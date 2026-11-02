'use strict';
/**
 * Key allocation for signed buttons: the values the provisioner (and the export script) hand to a client really work with the
 * gateway's master ring - a button issued with a client's allocated keys is routed by the gateway and verified by the client; one client's
 * keys cannot sign for another; the same call twice gives the same values (a redeploy keeps old buttons valid); rotation adds a kid; with
 * the rings missing nothing is provisioned and the issue flag is never set unless asked.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { clientButtonEnv, deriveFullKey } = require('../dist/buttonKeys');
const { issueButtonId } = require('../dist/buttonToken');
const { decideGatewayButton, loadClientButtonKeys, loadGatewayButtonKeys, parseKeyList } = require('../dist/buttonVerify');
const { buttonReadinessReport, routeKeyFingerprint } = require('../dist/buttonIssuer');
const { deriveRouteKey } = require('../dist/buttonToken');
const { DokployProvisioner } = require('../dist/dokployProvisioner');

const ROUTE = `k1:${Buffer.alloc(32, 11).toString('base64url')}`;
const FULL = `k1:${Buffer.alloc(32, 22).toString('base64url')}`;
const results = [];
const scenario = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); } };
const parse = (text) => Object.fromEntries(text.split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => {
  const value = l.slice(l.indexOf('=') + 1); let parsed = value;
  try { parsed = JSON.parse(value); } catch { /* a plain value (PORT=3001, STORAGE_PATH=...) */ }
  return [l.slice(0, l.indexOf('=')), parsed];
}));

(async () => {
  await scenario('allocated keys work end to end: issued with the client\'s keys, routed by the gateway ring, verified by the client; another client cannot sign for it', async () => {
    const a = clientButtonEnv('client-a', ROUTE, FULL); const b = clientButtonEnv('client-b', ROUTE, FULL);
    const keysA = loadClientButtonKeys(a); const keysB = loadClientButtonKeys(b);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const claims = { kid: 'k1', clientId: 'client-a', resultId: 'r1', stepId: 's1', optionId: 'o1', rev: 'rv', exp };
    const id = issueButtonId(claims, { routeKey: keysA.route.get('k1'), fullKey: keysA.full.get('k1') });
    const gw = loadGatewayButtonKeys({ META_BUTTON_ROUTE_MASTER_KEYS: ROUTE });
    const decision = decideGatewayButton(id, gw, new Set(['client-a', 'client-b']));
    assert.equal(decision.action, 'route'); assert.equal(decision.clientId, 'client-a');
    const forged = issueButtonId({ ...claims, clientId: 'client-a' }, { routeKey: keysB.route.get('k1'), fullKey: keysB.full.get('k1') });
    assert.equal(decideGatewayButton(forged, gw, new Set(['client-a'])).action, 'reject', 'client-b keys cannot sign a button for client-a');
    assert.notDeepEqual(keysA.full.get('k1'), keysA.route.get('k1'), 'the two keys of a client differ');
    assert.notDeepEqual(keysA.full.get('k1'), keysB.full.get('k1'));
    // what the gateway holds (the routing master) must not be enough to compute a client's full key
    assert.notDeepEqual(keysA.full.get('k1'), deriveFullKey(parseKeyList(ROUTE).get('k1'), 'client-a'), 'full keys come from their own master ring');
    assert.deepEqual(keysA.full.get('k1'), deriveFullKey(parseKeyList(FULL).get('k1'), 'client-a'));
    // the readiness report of such a client matches what the gateway derives for it
    const report = buttonReadinessReport({}, keysA);
    assert.equal(report.kids[0].selfTest, true);
    assert.equal(report.kids[0].routeFingerprint, routeKeyFingerprint(deriveRouteKey(parseKeyList(ROUTE).get('k1'), 'client-a')));
  });

  await scenario('deterministic: the same client gets the same values every time; rotation adds a kid and keeps the old one', async () => {
    assert.deepEqual(clientButtonEnv('client-a', ROUTE, FULL), clientButtonEnv('client-a', ROUTE, FULL));
    const ROUTE2 = `${ROUTE},k2:${Buffer.alloc(32, 33).toString('base64url')}`; const FULL2 = `${FULL},k2:${Buffer.alloc(32, 44).toString('base64url')}`;
    const before = clientButtonEnv('client-a', ROUTE, FULL); const after = clientButtonEnv('client-a', ROUTE2, FULL2);
    assert.ok(after.META_BUTTON_ROUTE_KEYS.startsWith(before.META_BUTTON_ROUTE_KEYS), 'k1 unchanged, k2 appended');
    assert.equal(after.META_BUTTON_FULL_KEYS.split(',').length, 2);
    assert.equal(clientButtonEnv('client-a', ROUTE2, FULL).META_BUTTON_ROUTE_KEYS, before.META_BUTTON_ROUTE_KEYS, 'a kid missing from one ring is skipped');
    assert.equal(deriveFullKey(Buffer.alloc(32, 22), 'x').length, 32);
  });

  await scenario('nothing is provisioned without both rings (or without a client id)', async () => {
    assert.equal(clientButtonEnv('client-a', ROUTE, undefined), undefined);
    assert.equal(clientButtonEnv('client-a', undefined, FULL), undefined);
    assert.equal(clientButtonEnv('client-a', ROUTE, `k9:${Buffer.alloc(32, 1).toString('base64url')}`), undefined, 'no kid in common');
    assert.equal(clientButtonEnv('', ROUTE, FULL), undefined);
  });

  // ---- the provisioner: what a new client's environment gets
  const calls = [];
  global.fetch = async (url, init) => {
    const route = String(url).split('/api/')[1]; const body = JSON.parse(init.body || '{}'); calls.push({ route, body });
    const json = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
    switch (route) {
      case 'application.create': return json({ applicationId: 'app_1', appName: body.appName });
      case 'mounts.create': return json({ mountId: 'mount_1' });
      case 'postgres.create': return json({ postgresId: 'pg_1', appName: body.appName + '-abc123', databaseName: body.databaseName, databaseUser: body.databaseUser, databasePassword: body.databasePassword });
      case 'domain.create': return json({ domainId: 'domain_1' });
      default: return json({ ok: true });
    }
  };
  const baseEnv = { DOKPLOY_API_URL: 'https://dokploy.example.test/api', DOKPLOY_API_TOKEN: 'token', DOKPLOY_ENVIRONMENT_ID: 'env_1', DOKPLOY_GIT_URL: 'https://github.example.test/org/repo.git',
    DOKPLOY_GIT_BRANCH: 'master', DOKPLOY_CLIENT_DOMAIN_SUFFIX: 'clients.example.test', DOKPLOY_META_ACCESS_TOKEN: 'central-token', DOKPLOY_META_PHONE_NUMBER_ID: '111111111111111',
    DOKPLOY_META_DISPLAY_PHONE_NUMBER: '972529771002', DOKPLOY_META_VERIFY_TOKEN: 'central-verify', DOKPLOY_META_APP_SECRET: 'central-app-secret' };
  const newClient = (id) => ({ id, name: 'Shared', accessCode: 'c', ownerAccessToken: 'o', plan: 'self_service', readonlyDashboard: false, maxCampaigns: 7, whatsappProvider: 'META_CLOUD_API', managementUrl: '', createdAt: new Date().toISOString() });
  const provision = async (env, id) => {
    calls.length = 0; const provisioner = new DokployProvisioner({ ...baseEnv, ...env });
    let client = newClient(id);
    client = await provisioner.provision(client, (patch) => { client = { ...client, ...patch }; return client; });
    return calls.find((call) => call.route === 'application.saveEnvironment').body.env;
  };

  await scenario('provisioner: a new Meta client gets its id and derived keys, and NOT the issue flag', async () => {
    const envText = await provision({ META_BUTTON_ROUTE_MASTER_KEYS: ROUTE, META_BUTTON_FULL_MASTER_KEYS: FULL }, 'abcdef12-90ab-cdef-1234-567890abcdef');
    const got = parse(envText); const want = clientButtonEnv('abcdef12-90ab-cdef-1234-567890abcdef', ROUTE, FULL);
    assert.equal(got.META_BUTTON_CLIENT_ID, want.META_BUTTON_CLIENT_ID);
    assert.equal(got.META_BUTTON_ROUTE_KEYS, want.META_BUTTON_ROUTE_KEYS);
    assert.equal(got.META_BUTTON_FULL_KEYS, want.META_BUTTON_FULL_KEYS);
    assert.ok(!/META_BUTTON_V1_ISSUE/.test(envText), 'issuing stays off');
    assert.ok(!/MASTER/.test(envText), 'a master ring never reaches a client');
    assert.ok(envText.includes('META_ACCESS_TOKEN="central-token"'), 'the rest of the environment is as before');
  });

  await scenario('provisioner: DOKPLOY_BUTTON_V1_ISSUE=1 adds the flag; without rings nothing about buttons is written', async () => {
    const withFlag = await provision({ META_BUTTON_ROUTE_MASTER_KEYS: ROUTE, META_BUTTON_FULL_MASTER_KEYS: FULL, DOKPLOY_BUTTON_V1_ISSUE: '1' }, 'client-flag');
    assert.ok(/META_BUTTON_V1_ISSUE=1/.test(withFlag));
    const without = await provision({}, 'client-none');
    assert.ok(!/META_BUTTON_/.test(without), 'unchanged environment when the feature is not configured');
    const onlyOne = await provision({ META_BUTTON_ROUTE_MASTER_KEYS: ROUTE }, 'client-half');
    assert.ok(!/META_BUTTON_/.test(onlyOne));
  });

  await scenario('export script: writes the same values the provisioner would, never prints a key, skips non-Meta clients', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'button-keys-'));
    const owner = path.join(dir, 'clients.json'); const out = path.join(dir, 'out.env');
    fs.writeFileSync(owner, JSON.stringify([{ id: 'meta-1', name: 'M1', whatsappProvider: 'META_CLOUD_API' }, { id: 'bail-1', name: 'B1', whatsappProvider: 'BAILEYS' }]));
    const run = spawnSync(process.execPath, [path.join(__dirname, 'button-keys-export.js'), '--owner', owner, '--out', out], { encoding: 'utf8', env: { ...process.env, META_BUTTON_ROUTE_MASTER_KEYS: ROUTE, META_BUTTON_FULL_MASTER_KEYS: FULL } });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.stdout.includes(Buffer.alloc(32, 11).toString('base64url')) && !/k1:/.test(run.stdout), 'no key on the terminal');
    const text = fs.readFileSync(out, 'utf8'); const got = parse(text); const want = clientButtonEnv('meta-1', ROUTE, FULL);
    assert.equal(got.META_BUTTON_ROUTE_KEYS, want.META_BUTTON_ROUTE_KEYS); assert.equal(got.META_BUTTON_FULL_KEYS, want.META_BUTTON_FULL_KEYS);
    assert.ok(!/bail-1/.test(text), 'a Baileys client is not included');
    const missing = spawnSync(process.execPath, [path.join(__dirname, 'button-keys-export.js'), '--owner', owner, '--out', out], { encoding: 'utf8', env: { ...process.env, META_BUTTON_ROUTE_MASTER_KEYS: '', META_BUTTON_FULL_MASTER_KEYS: '' } });
    assert.equal(missing.status, 2, 'refuses to run without the rings');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let failed = 0;
  for (const [name, status, detail] of results) { console.info(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.info(failed ? `\n${failed} scenario(s) FAILED` : `\nButton key allocation tests passed (${results.length} scenarios).`);
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})().catch((e) => { console.error(e); process.exit(1); });
