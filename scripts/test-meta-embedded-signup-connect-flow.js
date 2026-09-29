'use strict';

/**
 * embedded-signup-automation-plan-2026-09-28, stage 7 step 3 (sections 3.1-3.3),
 * corrected per docs/embedded-signup-coexistence-event-contract-finding-2026-09-29.md.
 *
 * Runs the REAL admin server (startAdminServer) against a real OWNER_STORAGE_PATH
 * file, exactly like scripts/test-meta-gateway-lookup-failure-isolation.js. Only
 * the two external HTTP boundaries - Meta's Graph API and the Dokploy API - are
 * stubbed via global.fetch (same convention as
 * scripts/test-dokploy-provisioner-postgres.js). All calls INTO the admin server
 * use Node's http module directly, so they are never touched by that stub.
 *
 * Covers plan section 6, test 1 (adapted: phoneNumberId is always
 * server-discovered, never trusted from the request body - see the finding doc):
 *   - happy path end to end, including provisioning
 *   - code-exchange failure
 *   - debug_token that does not cover the reported waba (rejected)
 *   - more than one phone number under the WABA (rejected, no picker)
 *   - the shared number / an already-claimed dedicated number (rejected)
 *   - smb_app_data failure, then a retry that succeeds WITHOUT exchanging a new code
 *   - a concurrent double submit of the same link completes exactly once
 *   - an already-used link is rejected on a second, later attempt
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-signup-flow-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  WHATSAPP_PROVIDER: 'META_CLOUD_API',
  STORAGE_PATH: path.join(root, 'storage.json'),
  OWNER_STORAGE_PATH: path.join(root, 'owner.json'),
  CONVERSATION_STATE_PATH: path.join(root, 'state.json'),
  OWNER_ACCESS_TOKEN: 'es-owner-token',
  CLIENT_ACCESS_TOKEN: 'es-client-token',
  META_ACCESS_TOKEN: 'central-shared-token',
  META_PHONE_NUMBER_ID: 'shared-phone-id',
  META_DISPLAY_PHONE_NUMBER: '15550001111',
  META_APP_SECRET: 'boot1-app-secret',
  META_GRAPH_API_VERSION: 'v23.0',
  META_APP_ID: 'boot1-app-id',
  META_EMBEDDED_SIGNUP_CONFIG_ID: 'signup-config-1',
  CLIENT_DIRECTORY_URL: 'https://admin.example.test',
  DOKPLOY_API_URL: 'https://dokploy.example.test/api',
  DOKPLOY_API_TOKEN: 'dokploy-token',
  DOKPLOY_ENVIRONMENT_ID: 'env-1',
  DOKPLOY_GIT_URL: 'https://github.example.test/org/repo.git',
  DOKPLOY_GIT_BRANCH: 'master',
  DOKPLOY_CLIENT_DOMAIN_SUFFIX: 'clients.example.test',
  DOKPLOY_META_ACCESS_TOKEN: 'central-shared-token',
  DOKPLOY_META_PHONE_NUMBER_ID: 'shared-phone-id',
  DOKPLOY_META_DISPLAY_PHONE_NUMBER: '15550001111',
  DOKPLOY_META_VERIFY_TOKEN: 'central-verify',
  DOKPLOY_META_APP_SECRET: 'boot1-app-secret',
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ── Graph API stub state (mutated per test case) ────────────────────────────
const graph = {
  exchangeCalls: 0,
  debugTokenCalls: 0,
  phoneNumbersCalls: 0,
  subscribeCalls: 0,
  smbCalls: 0,
  issuedAccessToken: 'issued-access-token-1',
  wabaId: 'waba-happy-1',
  phoneNumberIds: ['phone-happy-1'],
  displayPhoneNumber: '972500000001',
  exchangeShouldFail: false,
  debugTokenTargetIds: null, // null = matches wabaId automatically
  smbShouldFail: false,
};
function resetGraph(overrides) {
  Object.assign(graph, {
    exchangeCalls: 0, debugTokenCalls: 0, phoneNumbersCalls: 0, subscribeCalls: 0, smbCalls: 0,
    issuedAccessToken: 'issued-access-token-1', wabaId: 'waba-happy-1', phoneNumberIds: ['phone-happy-1'],
    displayPhoneNumber: '972500000001', exchangeShouldFail: false, debugTokenTargetIds: null, smbShouldFail: false,
  }, overrides);
}

const dokployCalls = [];

global.fetch = async (url, init) => {
  const urlStr = String(url);
  if (urlStr.startsWith('https://graph.facebook.com/')) {
    const u = new URL(urlStr);
    if (u.pathname.endsWith('/oauth/access_token')) {
      graph.exchangeCalls += 1;
      if (graph.exchangeShouldFail) return jsonResponse({ error: { message: 'הקוד שסופק אינו תקף או שפג תוקפו' } }, 400);
      return jsonResponse({ access_token: graph.issuedAccessToken });
    }
    if (u.pathname.endsWith('/debug_token')) {
      graph.debugTokenCalls += 1;
      const targetIds = graph.debugTokenTargetIds || [graph.wabaId];
      return jsonResponse({
        data: {
          is_valid: true,
          scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
          granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: targetIds }],
        },
      });
    }
    if (u.pathname.endsWith('/subscribed_apps')) {
      graph.subscribeCalls += 1;
      return jsonResponse({ success: true });
    }
    if (u.pathname.endsWith('/smb_app_data')) {
      graph.smbCalls += 1;
      if (graph.smbShouldFail) return jsonResponse({ error: { message: 'sync temporarily unavailable' } }, 503);
      return jsonResponse({ success: true });
    }
    if (u.pathname.endsWith('/phone_numbers')) {
      graph.phoneNumbersCalls += 1;
      return jsonResponse({ data: graph.phoneNumberIds.map((id) => ({ id })) });
    }
    // GET /<phoneNumberId>?fields=... (phone number details)
    return jsonResponse({ display_phone_number: graph.displayPhoneNumber, verified_name: 'עסק לדוגמה', quality_rating: 'GREEN', code_verification_status: 'VERIFIED' });
  }
  if (urlStr.startsWith('https://dokploy.example.test/api/')) {
    const route = urlStr.split('/api/')[1];
    const body = JSON.parse(init.body || '{}');
    dokployCalls.push(route);
    if (route === 'deployment.all') return jsonResponse([{ deploymentId: 'd1', status: 'done', createdAt: new Date().toISOString(), title: body.title }]);
    return jsonResponse({ ok: true, applicationId: body.applicationId });
  }
  throw new Error('Unexpected fetch to ' + urlStr);
};

const { config } = require('../dist/config');
const { Storage } = require('../dist/storage');

function baseClient(id, overrides = {}) {
  return {
    id,
    name: overrides.name || 'לקוחה לבדיקת Embedded Signup',
    accessCode: id + '-code',
    ownerAccessToken: id + '-owner-token',
    plan: 'self_service',
    readonlyDashboard: false,
    maxCampaigns: 7,
    whatsappProvider: 'META_CLOUD_API',
    managementUrl: `https://${id}.clients.example.test/client/`,
    provisioningStatus: 'ready',
    createdAt: new Date().toISOString(),
    dokployApplicationId: `app-${id}`,
    dokployAppName: `${id}-app`,
    dokployDeploymentRequested: true,
    dokployPostgresId: `pg-${id}`,
    dokployPostgresAppName: `${id}-postgres`,
    dokployPostgresDatabaseName: 'postgres',
    dokployPostgresDatabaseUser: 'postgres',
    dokployPostgresDatabasePassword: 'pw',
    ...overrides,
  };
}

function httpRequest(baseUrl, method, pathAndQuery, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(baseUrl + pathAndQuery, {
      method,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let caseCounter = 0;

async function withHarness(clients, run) {
  caseCounter += 1;
  const ownerPath = path.join(root, `owner-${caseCounter}.json`);
  fs.writeFileSync(ownerPath, JSON.stringify(clients, null, 2));
  process.env.OWNER_STORAGE_PATH = ownerPath;
  config.OWNER_STORAGE_PATH = ownerPath;
  config.ADMIN_PORT = 0;

  delete require.cache[require.resolve('../dist/adminServer')];
  delete require.cache[require.resolve('../dist/ownerStorage')];
  const { OwnerStorage } = require('../dist/ownerStorage');
  const storage = new Storage(path.join(root, `storage-${caseCounter}.json`));
  const admin = require('../dist/adminServer').startAdminServer(storage);
  if (!admin.listening) await new Promise((resolve) => admin.once('listening', resolve));
  const adminUrl = `http://127.0.0.1:${admin.address().port}`;

  const login = await httpRequest(adminUrl, 'POST', '/auth/owner/login', { body: { accessCode: 'es-owner-token' } });
  assert.equal(login.status, 200, 'owner login must succeed with the configured OWNER_ACCESS_TOKEN');
  const ownerCookie = String(login.headers['set-cookie'] || '').split(';')[0];

  const ownerStorageDirect = new OwnerStorage(ownerPath);

  try {
    await run({ adminUrl, ownerCookie, ownerStorageDirect, ownerPath });
  } finally {
    admin.closeAllConnections();
    await new Promise((resolve) => admin.close(resolve));
  }
}

function extractToken(url) {
  return url.split('/connect/meta/')[1];
}

async function main() {
  // ── 1. Happy path end to end ────────────────────────────────────────────
  await withHarness([baseClient('c1')], async ({ adminUrl, ownerCookie }) => {
    resetGraph({});
    const linkRes = await httpRequest(adminUrl, 'POST', '/owner/api/clients/c1/meta-connect-link', { headers: { cookie: ownerCookie } });
    assert.equal(linkRes.status, 200);
    assert.ok(linkRes.body.url.startsWith('https://admin.example.test/connect/meta/'));
    const token = extractToken(linkRes.body.url);

    const info = await httpRequest(adminUrl, 'GET', `/connect/meta/${token}/info`);
    assert.equal(info.status, 200);
    assert.deepEqual(info.body, { valid: true, appId: 'boot1-app-id', configId: 'signup-config-1', graphApiVersion: 'v23.0' });

    const complete = await httpRequest(adminUrl, 'POST', `/connect/meta/${token}/complete`, { body: { code: 'one-time-code', wabaId: graph.wabaId } });
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    assert.equal(complete.body.client.metaPhoneNumberId, 'phone-happy-1');
    assert.equal(complete.body.client.metaDisplayPhoneNumber, '972500000001');
    assert.equal(complete.body.client.metaOnboarding.status, 'connected');
    assert.equal(complete.body.client.metaAccessToken, undefined, 'the access token must never reach the owner dashboard response');
    assert.ok(dokployCalls.includes('application.saveEnvironment'), 'a successful connection must push new env (the dedicated Meta credentials) to the client unit');
    assert.ok(dokployCalls.includes('application.redeploy') || dokployCalls.includes('application.deploy'), 'a successful connection must redeploy the client unit');
    assert.equal(graph.exchangeCalls, 1);
    assert.equal(graph.subscribeCalls, 1);
    assert.equal(graph.smbCalls, 2, 'both smb_app_state_sync and history syncs must run');

    // The link is single-use: a second completion attempt with the same token must be rejected.
    const second = await httpRequest(adminUrl, 'POST', `/connect/meta/${token}/complete`, { body: { code: 'one-time-code', wabaId: graph.wabaId } });
    assert.equal(second.status, 410);
    assert.equal(graph.exchangeCalls, 1, 'a reused link must never re-exchange the code');
  });
  console.log('  1. happy path end to end - passed');

  // ── 2. Code exchange failure ─────────────────────────────────────────────
  await withHarness([baseClient('c2')], async ({ adminUrl, ownerCookie }) => {
    resetGraph({ exchangeShouldFail: true });
    const linkRes = await httpRequest(adminUrl, 'POST', '/owner/api/clients/c2/meta-connect-link', { headers: { cookie: ownerCookie } });
    const token = extractToken(linkRes.body.url);
    const complete = await httpRequest(adminUrl, 'POST', `/connect/meta/${token}/complete`, { body: { code: 'bad-code', wabaId: 'waba-x' } });
    assert.equal(complete.status, 502);
    const clientAfter = await httpRequest(adminUrl, 'GET', '/owner/api/clients/c2', { headers: { cookie: ownerCookie } });
    assert.equal(clientAfter.body.metaOnboarding.status, 'failed');
    assert.equal(clientAfter.body.metaOnboarding.step, 'code_exchanged');
    assert.equal(clientAfter.body.metaPhoneNumberId, undefined, 'a failed exchange must never touch metaPhoneNumberId');
  });
  console.log('  2. code-exchange failure - passed');

  // ── 3. debug_token does not cover the reported waba ─────────────────────
  await withHarness([baseClient('c3')], async ({ adminUrl, ownerCookie }) => {
    resetGraph({ debugTokenTargetIds: ['some-other-waba'] });
    const linkRes = await httpRequest(adminUrl, 'POST', '/owner/api/clients/c3/meta-connect-link', { headers: { cookie: ownerCookie } });
    const token = extractToken(linkRes.body.url);
    const complete = await httpRequest(adminUrl, 'POST', `/connect/meta/${token}/complete`, { body: { code: 'code-1', wabaId: graph.wabaId } });
    assert.equal(complete.status, 502);
    assert.match(complete.body.error, /אינו מכסה/);
    const clientAfter = await httpRequest(adminUrl, 'GET', '/owner/api/clients/c3', { headers: { cookie: ownerCookie } });
    assert.equal(clientAfter.body.metaOnboarding.status, 'failed');
    assert.equal(clientAfter.body.metaAccessToken, undefined);
  });
  console.log('  3. debug_token / waba mismatch rejected - passed');

  // ── 4. More than one phone number under the WABA: rejected, no guessing ──
  await withHarness([baseClient('c4')], async ({ adminUrl, ownerCookie }) => {
    resetGraph({ phoneNumberIds: ['phone-a', 'phone-b'] });
    const linkRes = await httpRequest(adminUrl, 'POST', '/owner/api/clients/c4/meta-connect-link', { headers: { cookie: ownerCookie } });
    const token = extractToken(linkRes.body.url);
    const complete = await httpRequest(adminUrl, 'POST', `/connect/meta/${token}/complete`, { body: { code: 'code-1', wabaId: graph.wabaId } });
    assert.equal(complete.status, 502);
    assert.match(complete.body.error, /יותר ממספר טלפון אחד/);
  });
  console.log('  4. multiple phone numbers under one WABA rejected - passed');

  // ── 5. Shared number and already-claimed dedicated number rejected ──────
  await withHarness([baseClient('c5'), baseClient('c5-other', { metaPhoneNumberId: 'phone-taken' })], async ({ adminUrl, ownerCookie }) => {
    resetGraph({ phoneNumberIds: ['shared-phone-id'] });
    const linkRes = await httpRequest(adminUrl, 'POST', '/owner/api/clients/c5/meta-connect-link', { headers: { cookie: ownerCookie } });
    const token = extractToken(linkRes.body.url);
    const complete = await httpRequest(adminUrl, 'POST', `/connect/meta/${token}/complete`, { body: { code: 'code-1', wabaId: graph.wabaId } });
    assert.equal(complete.status, 502);
    assert.match(complete.body.error, /המספר המשותף/);

    resetGraph({ phoneNumberIds: ['phone-taken'] });
    const linkRes2 = await httpRequest(adminUrl, 'POST', '/owner/api/clients/c5/meta-connect-link', { headers: { cookie: ownerCookie } });
    const token2 = extractToken(linkRes2.body.url);
    const complete2 = await httpRequest(adminUrl, 'POST', `/connect/meta/${token2}/complete`, { body: { code: 'code-2', wabaId: graph.wabaId } });
    assert.equal(complete2.status, 502);
    assert.match(complete2.body.error, /כבר מחובר ללקוחה אחרת/);
  });
  console.log('  5. shared / already-claimed number rejected - passed');

  // ── 6. smb_app_data failure, then retry succeeds without a new code exchange ─
  await withHarness([baseClient('c6')], async ({ adminUrl, ownerCookie }) => {
    resetGraph({ smbShouldFail: true, wabaId: 'waba-6', phoneNumberIds: ['phone-6'] });
    const linkRes = await httpRequest(adminUrl, 'POST', '/owner/api/clients/c6/meta-connect-link', { headers: { cookie: ownerCookie } });
    const token = extractToken(linkRes.body.url);
    const complete = await httpRequest(adminUrl, 'POST', `/connect/meta/${token}/complete`, { body: { code: 'code-1', wabaId: 'waba-6' } });
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    assert.equal(complete.body.client.metaOnboarding.status, 'in_progress');
    assert.equal(complete.body.client.metaOnboarding.step, 'smb_sync_failed');
    assert.equal(complete.body.client.metaPhoneNumberId, 'phone-6', 'the client must already be live on its number even though the sync failed');
    assert.equal(graph.exchangeCalls, 1);

    graph.smbShouldFail = false;
    const retry = await httpRequest(adminUrl, 'POST', '/owner/api/clients/c6/meta-connect-retry', { headers: { cookie: ownerCookie } });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.metaOnboarding.status, 'connected');
    assert.equal(graph.exchangeCalls, 1, 'retry must never re-exchange the one-time code');
    assert.equal(graph.smbCalls, 4, 'both syncs must be attempted independently on the first pass (2 calls, both failing) and both re-attempted on retry (2 more, both succeeding)');
  });
  console.log('  6. smb_app_data failure + retry without re-exchange - passed');

  // ── 7. Concurrent double submit of the same link completes exactly once ──
  await withHarness([baseClient('c7')], async ({ adminUrl, ownerCookie }) => {
    resetGraph({ wabaId: 'waba-7', phoneNumberIds: ['phone-7'] });
    const linkRes = await httpRequest(adminUrl, 'POST', '/owner/api/clients/c7/meta-connect-link', { headers: { cookie: ownerCookie } });
    const token = extractToken(linkRes.body.url);
    const [first, second] = await Promise.all([
      httpRequest(adminUrl, 'POST', `/connect/meta/${token}/complete`, { body: { code: 'code-1', wabaId: 'waba-7' } }),
      httpRequest(adminUrl, 'POST', `/connect/meta/${token}/complete`, { body: { code: 'code-1', wabaId: 'waba-7' } }),
    ]);
    // The loser is rejected either as "already in flight" (409, if it reaches the lock check while
    // the winner is still running) or as "link already used" (410, if the winner already finished
    // by the time it checks) - which one depends on event-loop timing, but exactly one 200 and one
    // rejection is the actual guarantee under test.
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one concurrent request must succeed, got ${statuses}`);
    assert.ok(statuses.includes(409) || statuses.includes(410), `the losing request must be rejected as in-flight or already-used, got ${statuses}`);
    assert.equal(graph.exchangeCalls, 1, 'a concurrent double-click must exchange the code exactly once');
  });
  console.log('  7. concurrent double-click completes exactly once - passed');

  // ── 8. Recreating a link invalidates the previous one ────────────────────
  await withHarness([baseClient('c8')], async ({ adminUrl, ownerCookie }) => {
    const link1 = await httpRequest(adminUrl, 'POST', '/owner/api/clients/c8/meta-connect-link', { headers: { cookie: ownerCookie } });
    const token1 = extractToken(link1.body.url);
    const link2 = await httpRequest(adminUrl, 'POST', '/owner/api/clients/c8/meta-connect-link', { headers: { cookie: ownerCookie } });
    const token2 = extractToken(link2.body.url);
    assert.notEqual(token1, token2);

    const infoOld = await httpRequest(adminUrl, 'GET', `/connect/meta/${token1}/info`);
    assert.equal(infoOld.status, 410, 'the previous link must stop working once a new one is created');
    const infoNew = await httpRequest(adminUrl, 'GET', `/connect/meta/${token2}/info`);
    assert.equal(infoNew.status, 200);
  });
  console.log('  8. recreating a link invalidates the previous one - passed');

  // ── 9. A wrong / random token never leaks whether a client exists ────────
  await withHarness([baseClient('c9')], async ({ adminUrl }) => {
    const randomToken = crypto.randomBytes(32).toString('base64url');
    const info = await httpRequest(adminUrl, 'GET', `/connect/meta/${randomToken}/info`);
    assert.equal(info.status, 410);
    assert.deepEqual(info.body, { valid: false });
  });
  console.log('  9. an unrecognized token is rejected generically - passed');

  // ── 10. Per-IP rate limit on /connect/meta/* (section 5) ─────────────────
  await withHarness([baseClient('c10')], async ({ adminUrl, ownerCookie }) => {
    const randomToken = crypto.randomBytes(32).toString('base64url');
    const statuses = [];
    // 20 is the configured cap - all of these must land under it (token is wrong, so 410, but
    // that proves the request reached the route handler, i.e. was NOT rate limited).
    for (let i = 0; i < 20; i += 1) {
      const res = await httpRequest(adminUrl, 'GET', `/connect/meta/${randomToken}/info`);
      statuses.push(res.status);
    }
    assert.ok(statuses.every((s) => s === 410), `all 20 requests within the cap must reach the route handler, got ${statuses}`);

    const over = await httpRequest(adminUrl, 'GET', `/connect/meta/${randomToken}/info`);
    assert.equal(over.status, 429, 'the 21st request within the same minute from the same IP must be rate limited');
    assert.ok(over.headers['retry-after'], '429 must carry a Retry-After header');

    const overOnOtherPath = await httpRequest(adminUrl, 'GET', `/connect/meta/${randomToken}`);
    assert.equal(overOnOtherPath.status, 429, 'the limiter is per-IP across the whole /connect/meta/* prefix, not per exact path');

    // The limiter must be scoped to /connect/meta/* only - an unrelated, authenticated owner
    // route from the same (rate-limited) IP must be completely unaffected.
    const unrelated = await httpRequest(adminUrl, 'GET', '/owner/api/clients/c10', { headers: { cookie: ownerCookie } });
    assert.equal(unrelated.status, 200, 'the rate limit must never apply to routes outside /connect/meta/*');
  });
  console.log('  10. per-IP rate limit on /connect/meta/* - passed');

  console.log('Embedded Signup connect-flow tests passed.');
}

// Each harness spins up a real admin server, which starts its own
// un-unref'd routes-cache-refresh interval (src/adminServer.ts,
// refreshAllRoutesCaches) that outlives admin.close() - the same reason
// scripts/test-meta-gateway-lookup-failure-isolation.js calls process.exit()
// explicitly instead of letting the event loop drain naturally.
main().then(
  () => setTimeout(() => process.exit(0), 200),
  (err) => { console.error(err); setTimeout(() => process.exit(1), 200); },
);
