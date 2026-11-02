'use strict';
// (v1 readiness) A participant taps a repeatable button shortly AFTER her flow ended. No trigger matches and no client has a pending question,
// which the gateway used to drop (reason=no_trigger_or_pending_conversation). A client that reports repeatWindowCampaignId for the
// sender may take that button tap - and only that, and only when exactly one client does.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-readiness-'));
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
});

// What a correctly configured client reports (real code from dist, keys as the gateway derives them from its master key k1).
function goodStatus(id, { masterByte = 7, fullByte = 3, kid = 'k1', issueKid, clientId = id, revoked = [] } = {}) {
  const { buttonReadinessReport } = require('../dist/buttonIssuer');
  const { deriveRouteKey } = require('../dist/buttonToken');
  const route = new Map([[kid, deriveRouteKey(Buffer.alloc(32, masterByte), id)]]);
  const full = new Map([[kid, Buffer.alloc(32, fullByte)]]);
  const env = issueKid ? { META_BUTTON_ISSUE_KID: issueKid } : {};
  return buttonReadinessReport(env, { route, full, revoked: new Set(revoked), clientId });
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

function clientRecord(id, managementUrl) {
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
  };
}

function metaPayload(id, body) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'shared-phone-id', display_phone_number: '15550001111' },
          contacts: [{ wa_id: '15551234567', profile: { name: 'Repeat window' } }],
          messages: [{ id, from: '15551234567', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
        },
      }],
    }],
  };
}

function metaButtonPayload(id) {
  const payload = metaPayload(id, '');
  const message = payload.entry[0].changes[0].value.messages[0];
  message.type = 'interactive';
  delete message.text;
  message.interactive = { type: 'button_reply', button_reply: { id: 'option-share', title: 'Share' } };
  message.context = { id: 'wamid.QUESTION' };
  return payload;
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
    stats[def.id] = { routeCalls: 0, pendingCalls: 0, clearCalls: 0, forwardCalls: 0, leaseCalls: 0, leaseBodies: [] };
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
      if (req.url === '/owner-api/button-v1/lease') {
        stats[def.id].leaseCalls += 1; stats[def.id].leaseBodies.push(await readBody(req));
        return json(res, def.leaseStatus ?? 200, { granted: true });
      }
      if (req.url === '/owner-api/button-v1/status') {
        if (def.statusCode && def.statusCode !== 200) return json(res, def.statusCode, {});
        return json(res, 200, def.buttonStatus ?? goodStatus(def.id));
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
    ownerRecords.push(clientRecord(def.id, url));
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

  try {
    await run({ adminUrl, stats });
  } finally {
    admin.closeAllConnections();
    await close(admin);
    await Promise.all(servers.map(close));
  }
}

async function sendAndWait(adminUrl, messageId, body, until, button = false) {
  const response = await fetch(`${adminUrl}/webhooks/meta/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(button ? metaButtonPayload(messageId) : metaPayload(messageId, body)),
  });
  assert.equal(response.status, 200);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !until()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}


const CAPS = ['resumable-v1', 'durable-supersede-v1'];
const ok = { pending: false, activeWork: false, resumable: false, capabilities: CAPS };
let cookie = '';
async function readiness(adminUrl) {
  {
    const login = await fetch(`${adminUrl}/auth/owner/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: 'synthetic-owner' }) });
    assert.equal(login.status, 200);
    cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  }
  const res = await fetch(`${adminUrl}/owner/api/button-v1/readiness`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return res.json();
}
const setGateway = ({ handover = true, keys = true } = {}) => {
  if (handover) process.env.META_RESUMABLE_HANDOVER = '1'; else delete process.env.META_RESUMABLE_HANDOVER;
  if (keys) process.env.META_BUTTON_ROUTE_MASTER_KEYS = `k1:${Buffer.alloc(32, 7).toString('base64url')}`; else delete process.env.META_BUTTON_ROUTE_MASTER_KEYS;
};

(async () => {
  setGateway();
  await withHarness([{ id: 'a', pending: ok }, { id: 'b', pending: ok }], async ({ adminUrl }) => {
    const r = await readiness(adminUrl);
    assert.equal(r.ready, true, JSON.stringify(r)); assert.equal(r.clients.length, 2);
  });
  console.log('PASS 1: everything in place -> ready.');

  await withHarness([{ id: 'a', pending: ok }, { id: 'old', pending: { pending: false, activeWork: false } }], async ({ adminUrl }) => {
    const r = await readiness(adminUrl);
    assert.equal(r.ready, false);
    assert.equal(r.clients.find((c) => c.id === 'old').capabilitiesOk, false);
    assert.equal(r.clients.find((c) => c.id === 'a').capabilitiesOk, true);
  });
  console.log('PASS 2: one client that does not report the capabilities blocks the whole fleet.');

  await withHarness([{ id: 'a', pending: ok }, { id: 'older', pendingStatus: 404 }], async ({ adminUrl }) => {
    const r = await readiness(adminUrl);
    assert.equal(r.ready, false); assert.equal(r.clients.find((c) => c.id === 'older').capabilitiesOk, false);
  });
  console.log('PASS 3: a client that predates the endpoint (404) blocks.');

  await withHarness([{ id: 'a', pending: ok }, { id: 'down', pendingStatus: 500 }], async ({ adminUrl }) => {
    const r = await readiness(adminUrl);
    assert.equal(r.ready, false); assert.equal(r.clients.find((c) => c.id === 'down').reachable, false);
  });
  console.log('PASS 4: a client that cannot be reached blocks.');

  setGateway({ handover: false });
  await withHarness([{ id: 'a', pending: ok }], async ({ adminUrl }) => {
    const r = await readiness(adminUrl);
    assert.equal(r.ready, false); assert.equal(r.gateway.resumableHandoverOn, false);
  });
  setGateway({ keys: false });
  await withHarness([{ id: 'a', pending: ok }], async ({ adminUrl }) => {
    const r = await readiness(adminUrl);
    assert.equal(r.ready, false); assert.equal(r.gateway.routingKeys, 0);
  });
  console.log('PASS 5: the gateway itself must run the resumable handover and hold routing keys.');

  await withHarness([{ id: 'a', pending: ok }], async ({ adminUrl }) => {
    const res = await fetch(`${adminUrl}/owner/api/button-v1/readiness`, { redirect: 'manual' });
    assert.ok(res.status === 401 || res.status === 302 || res.status === 403, `status ${res.status}`);
  });
  console.log('PASS 6: not available without the owner session.');

  setGateway();
  const problem = async (defs, id) => {
    let row; await withHarness(defs, async ({ adminUrl }) => { const r = await readiness(adminUrl); assert.equal(r.ready, false, JSON.stringify(r)); row = r.clients.find((c) => c.id === id); });
    return row;
  };
  const withStatus = (buttonStatus, extra = {}) => [{ id: 'a', pending: ok }, { id: 'x', pending: ok, buttonStatus, ...extra }];
  assert.equal((await problem(withStatus(undefined, { statusCode: 404 }), 'x')).buttonProblem, 'no_button_status');
  assert.equal((await problem(withStatus(goodStatus('x', { clientId: '' })), 'x')).buttonProblem, 'client_id_mismatch', 'client does not know its id');
  assert.equal((await problem(withStatus(goodStatus('x', { clientId: 'other' })), 'x')).buttonProblem, 'client_id_mismatch', 'client thinks it is another client');
  assert.equal((await problem(withStatus(goodStatus('x', { masterByte: 9 })), 'x')).buttonProblem, 'route_key_mismatch', 'routing key not the one the gateway derives');
  assert.equal((await problem(withStatus(goodStatus('x', { kid: 'k2' })), 'x')).buttonProblem, 'issue_kid_unknown_at_gateway', 'kid the gateway does not hold');
  assert.equal((await problem(withStatus(goodStatus('x', { revoked: ['k1'] })), 'x')).buttonProblem, 'issue_kid_unusable_at_client', 'the signing key is revoked at the client');
  const broken = goodStatus('x'); broken.kids[0].selfTest = false;
  assert.equal((await problem(withStatus(broken), 'x')).buttonProblem, 'self_test_failed');
  const noKey = goodStatus('x'); noKey.kids = [];
  assert.equal((await problem(withStatus(noKey), 'x')).buttonProblem, 'issue_kid_unusable_at_client');
  const good = await problem(withStatus(goodStatus('x', { masterByte: 9 })), 'a');
  assert.equal(good.buttonsOk, true, 'the healthy client is not blamed');
  console.log('PASS 7: ready needs every client to know its id, hold a working key pair and the routing key the gateway derives for it.');
  // 8. the lease: while the whole fleet is ready every client is granted one (short, relative); nothing is granted when it is not.
  process.env.META_BUTTON_LEASE_TTL_MS = '45000';
  await withHarness([{ id: 'a', pending: ok }, { id: 'b', pending: ok }], async ({ stats }) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (stats.a.leaseCalls === 0 || stats.b.leaseCalls === 0)) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(stats.a.leaseCalls >= 1 && stats.b.leaseCalls >= 1, 'every client of a ready fleet gets a lease');
    assert.equal(stats.a.leaseBodies[0].ttlMs, 45000);
  });
  await withHarness([{ id: 'a', pending: ok }, { id: 'bad', pending: ok, buttonStatus: goodStatus('bad', { masterByte: 9 }) }], async ({ stats }) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(stats.a.leaseCalls + stats.bad.leaseCalls, 0, 'one broken client: nobody gets a lease, not even the healthy ones');
  });
  setGateway({ handover: false });
  await withHarness([{ id: 'a', pending: ok }], async ({ stats }) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(stats.a.leaseCalls, 0, 'gateway without the resumable handover grants nothing');
  });
  setGateway();
  delete process.env.META_BUTTON_LEASE_TTL_MS;
  console.log('PASS 8: leases are granted to the whole fleet only while the whole fleet is ready.');
  console.log('PASS: v1 readiness check behaves as specified.');
})().then(() => setTimeout(() => process.exit(0), 200), (error) => {
  console.error(error);
  setTimeout(() => process.exit(1), 200);
});
