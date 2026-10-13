'use strict';
// docs/gateway-dedicated-number-scope-plan-2026-10-13.md, section 5 (10 required cases). Covers
// the fix for sections 4.1-4.5: a client on a dedicated metaPhoneNumberId must be completely
// invisible, in both directions, to the shared-number flow (inbound routing AND delivery-status
// fan-out) - and the 11 shared-number clients' own group, and their existing fail-closed
// behavior, must stay exactly as it is today.
//
// Same convention as scripts/test-meta-gateway-lookup-failure-isolation.js: a real admin server,
// mocked HTTP client units, actual call counts - not a parallel re-implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-gateway-scope-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  WHATSAPP_PROVIDER: 'META_CLOUD_API',
  STORAGE_PATH: path.join(root, 'storage.json'),
  OWNER_STORAGE_PATH: path.join(root, 'owner.json'),
  CONVERSATION_STATE_PATH: path.join(root, 'state.json'),
  OWNER_ACCESS_TOKEN: 'synthetic-owner',
  CLIENT_ACCESS_TOKEN: 'synthetic-client',
  META_ACCESS_TOKEN: '',
  DOKPLOY_META_ACCESS_TOKEN: '',
  META_PHONE_NUMBER_ID: 'shared-phone-id',
  META_DISPLAY_PHONE_NUMBER: '15550001111',
  BOT_REPLY_DELAY_MS: '0',
  // So notifySystemAlert actually dispatches (via the test sender below) instead of being a no-op.
  ALERT_EMAIL_TO: 'ops@example.com',
  ALERT_EMAIL_FROM: 'flowsbiz@example.com',
  ALERT_EMAIL_THROTTLE_MS: '60000',
});

const { resetSystemAlertStateForTest, setSystemAlertEmailSenderForTest } = require('../dist/systemAlerts');
let capturedAlerts = [];
function alertWithKey(key) {
  return capturedAlerts.find((body) => body.includes(`Key: ${key}`));
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function clientRecord(id, managementUrl, overrides = {}) {
  return {
    id,
    name: id,
    accessCode: id,
    ownerAccessToken: `${id}-owner-token`,
    plan: 'self_service',
    readonlyDashboard: false,
    maxCampaigns: 7,
    whatsappProvider: 'META_CLOUD_API',
    metaPhoneNumberId: 'shared-phone-id',
    metaDisplayPhoneNumber: '15550001111',
    managementUrl,
    provisioningStatus: 'ready',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function messagePayload(id, body, metadata) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata,
          contacts: [{ wa_id: '15551234567', profile: { name: 'Scope test' } }],
          messages: [{ id, from: '15551234567', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
        },
      }],
    }],
  };
}

function statusPayload(wamid, status, metadata) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata,
          statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '15551234567' }],
        },
      }],
    }],
  };
}

function campaign(id, triggerPhrase) {
  return { id, name: id, triggerType: 1, triggerPhrase, suffix: '', active: true, runtimeStatus: 'active' };
}

let caseCounter = 0;

async function withHarness(clientDefs, run) {
  caseCounter += 1;
  const servers = [];
  const stats = {};
  const ownerRecords = [];
  for (const def of clientDefs) {
    stats[def.id] = { routeCalls: 0, pendingCalls: 0, clearCalls: 0, forwardCalls: 0 };
    const server = http.createServer(async (req, res) => {
      if (req.url === '/owner-api/meta-routes') {
        stats[def.id].routeCalls += 1;
        if (def.routesStatus && def.routesStatus !== 200) return json(res, def.routesStatus, {});
        return json(res, 200, def.routes ?? []);
      }
      if (req.url === '/owner-api/meta-pending-route') {
        stats[def.id].pendingCalls += 1;
        await readBody(req);
        if (def.pendingStatus && def.pendingStatus !== 200) return json(res, def.pendingStatus, {});
        return json(res, 200, def.pending ?? { pending: false, activeWork: false });
      }
      if (req.url === '/owner-api/meta-clear-pending') {
        stats[def.id].clearCalls += 1;
        await readBody(req);
        if (def.clearStatus && def.clearStatus !== 200) return json(res, def.clearStatus, {});
        return json(res, 200, def.clearBody ?? { removed: 0, cancelled: true });
      }
      if (req.url === '/internal/meta/whatsapp') {
        stats[def.id].forwardCalls += 1;
        await readBody(req);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, {});
    });
    const url = await listen(server);
    servers.push(server);
    ownerRecords.push(clientRecord(def.id, url, def.client));
  }

  const ownerPath = path.join(root, `owner-${caseCounter}.json`);
  fs.writeFileSync(ownerPath, JSON.stringify(ownerRecords, null, 2));
  process.env.OWNER_STORAGE_PATH = ownerPath;

  const { Storage } = require('../dist/storage');
  const { config } = require('../dist/config');
  config.OWNER_STORAGE_PATH = ownerPath;
  config.ADMIN_PORT = 0;
  const storage = new Storage(path.join(root, `storage-${caseCounter}.json`));
  const admin = require('../dist/adminServer').startAdminServer(storage);
  if (!admin.listening) await new Promise((resolve) => admin.once('listening', resolve));
  const adminUrl = `http://127.0.0.1:${admin.address().port}`;

  resetSystemAlertStateForTest(); // also clears the test email sender - re-register it below
  setSystemAlertEmailSenderForTest(async (message) => { capturedAlerts.push(message.body); });
  capturedAlerts = [];

  try {
    await run({ adminUrl, stats });
  } finally {
    admin.closeAllConnections();
    await close(admin);
    await Promise.all(servers.map(close));
  }
}

async function postWebhook(adminUrl, body) {
  const response = await fetch(`${adminUrl}/webhooks/meta/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, 20));
}

const SHARED_META = { phone_number_id: 'shared-phone-id', display_phone_number: '15550001111' };
const dedicatedMeta = (id, display) => ({ phone_number_id: id, display_phone_number: display });

(async () => {
  // 1. A message to the shared number must not reach a client on a dedicated number at all - 0
  //    calls in either direction - and routing to the correct shared target is unaffected.
  await withHarness([
    { id: 'target-a', routes: [campaign('camp-a', 'scope trigger one')] },
    { id: 'dedicated-d', client: { metaPhoneNumberId: 'dedicated-1', metaDisplayPhoneNumber: '972500000001' } },
  ], async ({ adminUrl, stats }) => {
    await postWebhook(adminUrl, messagePayload('case1-msg', 'scope trigger one', SHARED_META));
    await waitUntil(() => stats['target-a'].forwardCalls > 0);
    assert.equal(stats['target-a'].forwardCalls, 1, 'routing to the correct shared-number client must be unaffected');
    assert.equal(stats['dedicated-d'].routeCalls, 0, 'a dedicated-number client must never be asked for its route list on a shared-number message');
    assert.equal(stats['dedicated-d'].pendingCalls, 0, '0 meta-pending-route calls to a client outside the scope');
    assert.equal(stats['dedicated-d'].clearCalls, 0, '0 meta-clear-pending calls to a client outside the scope');
  });
  console.log('PASS 1: a shared-number message never reaches a dedicated-number client (0 calls, either direction).');

  // 2. A dedicated-number client that is completely unreachable (every owner-api call fails) must
  //    not block or delay a shared-number trigger at all - it is excluded from the scan entirely,
  //    not merely tolerated as a failure within it.
  await withHarness([
    { id: 'target-a', routes: [campaign('camp-a', 'scope trigger two')] },
    { id: 'dedicated-d', client: { metaPhoneNumberId: 'dedicated-1', metaDisplayPhoneNumber: '972500000001' }, routesStatus: 500, pendingStatus: 500, clearStatus: 500 },
  ], async ({ adminUrl, stats }) => {
    await postWebhook(adminUrl, messagePayload('case2-msg', 'scope trigger two', SHARED_META));
    await waitUntil(() => stats['target-a'].forwardCalls > 0, 1_000);
    assert.equal(stats['target-a'].forwardCalls, 1, 'a fully unavailable dedicated-number client must not block or delay a shared-number trigger');
    assert.equal(stats['dedicated-d'].routeCalls, 0);
    assert.equal(stats['dedicated-d'].pendingCalls, 0);
    assert.equal(stats['dedicated-d'].clearCalls, 0);
  });
  console.log('PASS 2: a totally unavailable dedicated-number client neither blocks nor delays a shared-number trigger.');

  // 3. THE non-regression test: a client ON THE SHARED NUMBER that is unavailable must still
  //    block exactly as it does today (fail-closed is unchanged for the group it still applies
  //    to). If this ever fails, STOP - do not loosen it to make it pass.
  await withHarness([
    { id: 'target-a', routes: [campaign('camp-a', 'scope trigger three')] },
    { id: 'broken-shared', routesStatus: 500 },
  ], async ({ adminUrl, stats }) => {
    await postWebhook(adminUrl, messagePayload('case3-msg', 'scope trigger three', SHARED_META));
    await waitUntil(() => stats['broken-shared'].routeCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stats['target-a'].forwardCalls, 0, 'an unavailable SHARED-number client must still block the whole message, unchanged');
  });
  console.log('PASS 3 (non-regression): an unavailable shared-number client still blocks, exactly like before this change.');

  // 4. A participant with an open conversation with a dedicated-number client who then sends a
  //    campaign trigger to the SHARED number: the dedicated conversation must not be touched
  //    (0 clear-pending calls to it), and the trigger must still route correctly.
  await withHarness([
    { id: 'target-a', routes: [campaign('camp-a', 'scope trigger four')] },
    { id: 'dedicated-d', client: { metaPhoneNumberId: 'dedicated-1', metaDisplayPhoneNumber: '972500000001' }, pending: { pending: true, campaignId: 'service-bot' } },
  ], async ({ adminUrl, stats }) => {
    await postWebhook(adminUrl, messagePayload('case4-msg', 'scope trigger four', SHARED_META));
    await waitUntil(() => stats['target-a'].forwardCalls > 0);
    assert.equal(stats['target-a'].forwardCalls, 1, 'the trigger must still route to the shared-number target');
    assert.equal(stats['dedicated-d'].pendingCalls, 0, 'a dedicated-number conversation must never be queried for a shared-number message');
    assert.equal(stats['dedicated-d'].clearCalls, 0, 'a dedicated-number conversation must never be cleared by a shared-number message');
  });
  console.log('PASS 4: an open conversation on a dedicated number is untouched by a shared-number trigger.');

  // 5. Two clients on two DIFFERENT dedicated numbers never see each other, in either direction.
  await withHarness([
    { id: 'dedicated-x', routes: [campaign('camp-x', 'scope trigger five')], client: { metaPhoneNumberId: 'dedicated-x-id', metaDisplayPhoneNumber: '972500000002' } },
    { id: 'dedicated-y', client: { metaPhoneNumberId: 'dedicated-y-id', metaDisplayPhoneNumber: '972500000003' } },
  ], async ({ adminUrl, stats }) => {
    await postWebhook(adminUrl, messagePayload('case5-msg', 'scope trigger five', dedicatedMeta('dedicated-x-id', '972500000002')));
    await waitUntil(() => stats['dedicated-x'].forwardCalls > 0);
    assert.equal(stats['dedicated-x'].forwardCalls, 1);
    assert.equal(stats['dedicated-y'].routeCalls, 0, 'a client on a different dedicated number must never be queried');
    assert.equal(stats['dedicated-y'].pendingCalls, 0);
    assert.equal(stats['dedicated-y'].clearCalls, 0);
  });
  console.log('PASS 5: two clients on different dedicated numbers are fully invisible to each other.');

  // 6. Delivery statuses: a dedicated-number phone_number_id reaches only that client; the
  //    shared id reaches only the shared-number clients; no phone_number_id reaches everyone,
  //    exactly as before this change.
  await withHarness([
    { id: 'shared-a' },
    { id: 'shared-b' },
    { id: 'dedicated-d', client: { metaPhoneNumberId: 'dedicated-1', metaDisplayPhoneNumber: '972500000001' } },
  ], async ({ adminUrl, stats }) => {
    await postWebhook(adminUrl, statusPayload('wamid-ded', 'sent', dedicatedMeta('dedicated-1', '972500000001')));
    await waitUntil(() => stats['dedicated-d'].forwardCalls > 0);
    assert.equal(stats['dedicated-d'].forwardCalls, 1, 'a status for the dedicated number must reach its own client');
    assert.equal(stats['shared-a'].forwardCalls, 0, 'a status for the dedicated number must not reach a shared-number client');
    assert.equal(stats['shared-b'].forwardCalls, 0);

    await postWebhook(adminUrl, statusPayload('wamid-shared', 'sent', SHARED_META));
    await waitUntil(() => stats['shared-a'].forwardCalls > 0 && stats['shared-b'].forwardCalls > 0);
    assert.equal(stats['shared-a'].forwardCalls, 1, 'a status for the shared number must reach every shared-number client');
    assert.equal(stats['shared-b'].forwardCalls, 1);
    assert.equal(stats['dedicated-d'].forwardCalls, 1, 'and must not additionally reach the dedicated-number client');

    await postWebhook(adminUrl, statusPayload('wamid-none', 'sent', { display_phone_number: '15550001111' }));
    await waitUntil(() => stats['shared-a'].forwardCalls > 1 && stats['shared-b'].forwardCalls > 1 && stats['dedicated-d'].forwardCalls > 1);
    assert.equal(stats['shared-a'].forwardCalls, 2, 'no phone_number_id at all must still broadcast to every client, unchanged');
    assert.equal(stats['shared-b'].forwardCalls, 2);
    assert.equal(stats['dedicated-d'].forwardCalls, 2);
  });
  console.log('PASS 6: delivery statuses are scoped by phone_number_id in both directions; a missing id still broadcasts.');

  // 7. A status phone_number_id that matches NO managed client must still broadcast to everyone
  //    (never to 0 targets - that would silently lose the status), plus raise a warning alert.
  await withHarness([
    { id: 'shared-a' },
    { id: 'dedicated-d', client: { metaPhoneNumberId: 'dedicated-1', metaDisplayPhoneNumber: '972500000001' } },
  ], async ({ adminUrl, stats }) => {
    await postWebhook(adminUrl, statusPayload('wamid-unknown', 'sent', { phone_number_id: 'nobody-owns-this', display_phone_number: '15550001111' }));
    await waitUntil(() => stats['shared-a'].forwardCalls > 0 && stats['dedicated-d'].forwardCalls > 0);
    assert.equal(stats['shared-a'].forwardCalls, 1, 'an unmatched phone_number_id must still broadcast to every client (never 0 targets)');
    assert.equal(stats['dedicated-d'].forwardCalls, 1);
    await waitUntil(() => Boolean(alertWithKey('meta-status-unknown-phone-number-nobody-owns-this')), 2_000);
    assert.ok(alertWithKey('meta-status-unknown-phone-number-nobody-owns-this'), 'an unmatched phone_number_id must raise a warning alert');
  });
  console.log('PASS 7: a status with an unmatched phone_number_id still broadcasts to everyone and raises an alert.');

  // 8. Conflicting metadata on an inbound message - both directions - routes by phone_number_id
  //    alone and raises a conflict alert, never blocking the message.
  await withHarness([
    { id: 'target-a', routes: [campaign('camp-a', 'scope trigger eight a')] },
    { id: 'dedicated-d', routes: [campaign('camp-d', 'scope trigger eight a')], client: { metaPhoneNumberId: 'dedicated-1', metaDisplayPhoneNumber: '972500000001' } },
  ], async ({ adminUrl, stats }) => {
    // dedicated phone_number_id + SHARED display_phone_number -> routed by the id (dedicated group).
    await postWebhook(adminUrl, messagePayload('case8a-msg', 'scope trigger eight a', dedicatedMeta('dedicated-1', '15550001111')));
    await waitUntil(() => stats['dedicated-d'].forwardCalls > 0);
    assert.equal(stats['dedicated-d'].forwardCalls, 1, 'phone_number_id (dedicated) must win over a conflicting shared display_phone_number');
    assert.equal(stats['target-a'].forwardCalls, 0, 'the shared-number client must not receive a message whose id says it is not for the shared number');
    await waitUntil(() => Boolean(alertWithKey('meta-gateway-metadata-conflict-dedicated-1')), 2_000);
    assert.ok(alertWithKey('meta-gateway-metadata-conflict-dedicated-1'), 'the conflict must raise a warning alert keyed by phone_number_id');
  });
  console.log('PASS 8a: dedicated id + shared display -> routed by the id, with a conflict alert.');

  await withHarness([
    { id: 'target-a', routes: [campaign('camp-a', 'scope trigger eight b')] },
    { id: 'dedicated-d', routes: [campaign('camp-d', 'scope trigger eight b')], client: { metaPhoneNumberId: 'dedicated-1', metaDisplayPhoneNumber: '972500000001' } },
  ], async ({ adminUrl, stats }) => {
    // SHARED phone_number_id + dedicated display_phone_number -> routed by the id (shared group).
    await postWebhook(adminUrl, messagePayload('case8b-msg', 'scope trigger eight b', dedicatedMeta('shared-phone-id', '972500000001')));
    await waitUntil(() => stats['target-a'].forwardCalls > 0);
    assert.equal(stats['target-a'].forwardCalls, 1, 'phone_number_id (shared) must win over a conflicting dedicated display_phone_number');
    assert.equal(stats['dedicated-d'].forwardCalls, 0, 'the dedicated-number client must not receive a message whose id says it is for the shared number');
    await waitUntil(() => Boolean(alertWithKey('meta-gateway-metadata-conflict-shared-phone-id')), 2_000);
    assert.ok(alertWithKey('meta-gateway-metadata-conflict-shared-phone-id'), 'the opposite-direction conflict must also raise an alert');
  });
  console.log('PASS 8b: shared id + dedicated display -> routed by the id, with a conflict alert.');

  // 9. An envelope with no phone_number_id at all still resolves purely by display_phone_number,
  //    unchanged - and the dedicated-number client stays fully excluded (4.2 still narrows the
  //    scope once the shared number is identified this way, same as when identified by id).
  await withHarness([
    { id: 'target-a', routes: [campaign('camp-a', 'scope trigger nine')] },
    { id: 'dedicated-d', client: { metaPhoneNumberId: 'dedicated-1', metaDisplayPhoneNumber: '972500000001' } },
  ], async ({ adminUrl, stats }) => {
    await postWebhook(adminUrl, messagePayload('case9-msg', 'scope trigger nine', { display_phone_number: '15550001111' }));
    await waitUntil(() => stats['target-a'].forwardCalls > 0);
    assert.equal(stats['target-a'].forwardCalls, 1, 'display_phone_number alone must still resolve the shared number correctly');
    assert.equal(stats['dedicated-d'].routeCalls, 0);
    assert.equal(stats['dedicated-d'].pendingCalls, 0);
    assert.equal(stats['dedicated-d'].clearCalls, 0);
    assert.equal(alertWithKey('meta-gateway-metadata-conflict-undefined'), undefined, 'no conflict check is even possible without a phone_number_id');
  });
  console.log('PASS 9: an envelope with no phone_number_id still resolves by display_phone_number alone, unchanged.');

  console.log('PASS: Meta gateway dedicated-number scope behaves as specified (item 10 - the full regression manifest - is run separately).');
})().then(() => setTimeout(() => process.exit(0), 200), (error) => {
  console.error(error);
  setTimeout(() => process.exit(1), 200);
});
