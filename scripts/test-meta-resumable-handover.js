'use strict';
// META_RESUMABLE_HANDOVER (default off): when a fresh trigger is routed to client B, a client A that reports a RESUMABLE run of the sender
// (a finished run, an expired question: no pending state at all) is told to cancel too, durably, before B starts. Off: nothing changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-resumable-handover-'));
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

function metaPayload(id, body, from = '15551234567') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'shared-phone-id', display_phone_number: '15550001111' },
          contacts: [{ wa_id: from, profile: { name: 'Resumable handover' } }],
          messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
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
        stats[def.id].clearBodies = (stats[def.id].clearBodies || []).concat([await readBody(req)]);
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

let senderSeq = 0;
async function sendAndWait(adminUrl, messageId, body, until) {
  const response = await fetch(`${adminUrl}/webhooks/meta/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metaPayload(messageId, body, `1555123${String(4000 + (senderSeq += 1))}`)),
  });
  assert.equal(response.status, 200);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !until()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const FULL = ['resumable-v1', 'durable-supersede-v1'];
const resumableRun = (extra = {}) => ({ pending: false, activeWork: false, resumable: true, capabilities: FULL, ...extra });
const capable = (extra = {}) => ({ pending: false, activeWork: false, resumable: false, capabilities: FULL, ...extra });

(async () => {
  const savedWarn = console.warn; const warnings = [];
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); savedWarn(...a); };

  // 1. flag OFF: the behaviour of today. A client with only a resumable run is not asked to cancel.
  delete process.env.META_RESUMABLE_HANDOVER;
  await withHarness([
    { id: 'target-b', routes: [campaign('camp-b', 'handover trigger one')], pending: capable() },
    { id: 'old-a', routes: [campaign('camp-a', 'another trigger')], pending: resumableRun() },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'h1', 'handover trigger one', () => stats['target-b'].forwardCalls > 0);
    assert.equal(stats['target-b'].forwardCalls, 1, 'the trigger is delivered');
    assert.equal(stats['old-a'].clearCalls, 0, 'flag off: a resumable-only client is not asked to cancel');
  });
  console.log('PASS 1: flag off - unchanged.');

  // 2. flag ON: the resumable client is asked to cancel (and told who takes over) BEFORE the trigger reaches B
  process.env.META_RESUMABLE_HANDOVER = '1';
  await withHarness([
    { id: 'target-b', routes: [campaign('camp-b', 'handover trigger two')], pending: capable() },
    { id: 'old-a', routes: [campaign('camp-a', 'another trigger')], pending: resumableRun() },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'h2', 'handover trigger two', () => stats['target-b'].forwardCalls > 0);
    assert.equal(stats['old-a'].clearCalls, 1, 'flag on: the client that still holds a resumable run is told');
    assert.equal(stats['old-a'].clearBodies[0].toClientId, 'target-b', 'and who takes her over');
    assert.equal(stats['target-b'].forwardCalls, 1);
    assert.equal(stats['target-b'].clearCalls, 0, 'never the target itself');
  });
  console.log('PASS 2: flag on - a resumable client is cancelled before the new client starts.');

  // 3. flag ON, the cancel is not confirmed: the trigger must NOT be delivered (fail closed, as for any stale client)
  await withHarness([
    { id: 'target-b', routes: [campaign('camp-b', 'handover trigger three')], pending: capable() },
    { id: 'old-a', routes: [campaign('camp-a', 'another trigger')], pending: resumableRun(), clearStatus: 500 },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'h3', 'handover trigger three', () => stats['old-a'].clearCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stats['target-b'].forwardCalls, 0, 'cancel not confirmed -> no delivery to the new client');
  });
  console.log('PASS 3: flag on - an unconfirmed cancel blocks the trigger (fail closed).');

  // 4. flag ON, not resumable and nothing pending: not asked (no extra calls for clients that have nothing of hers)
  await withHarness([
    { id: 'target-b', routes: [campaign('camp-b', 'handover trigger four')], pending: capable() },
    { id: 'idle-a', routes: [campaign('camp-a', 'another trigger')], pending: { pending: false, activeWork: false, resumable: false, capabilities: FULL } },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'h4', 'handover trigger four', () => stats['target-b'].forwardCalls > 0);
    assert.equal(stats['idle-a'].clearCalls, 0);
  });
  console.log('PASS 4: flag on - a client with nothing of hers is not called.');

  // 5. both pending and resumable: one call, not two
  await withHarness([
    { id: 'target-b', routes: [campaign('camp-b', 'handover trigger five')], pending: capable() },
    { id: 'busy-a', routes: [campaign('camp-a', 'another trigger')], pending: resumableRun({ pending: true, campaignId: 'camp-a' }) },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'h5', 'handover trigger five', () => stats['target-b'].forwardCalls > 0);
    assert.equal(stats['busy-a'].clearCalls, 1);
  });
  console.log('PASS 5: flag on - one cancel per client.');

  // 6. flag ON and a client that does not report the capabilities (an old client): the trigger is NOT delivered (fail closed), and it says why
  warnings.length = 0;
  await withHarness([
    { id: 'target-b', routes: [campaign('camp-b', 'handover trigger six')], pending: capable() },
    { id: 'old-version', routes: [campaign('camp-a', 'another trigger')], pending: { pending: false, activeWork: false } },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'h6', 'handover trigger six', () => stats['old-version'].pendingCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(stats['target-b'].forwardCalls, 0, 'a client without the capabilities stops the trigger');
  });
  assert.ok(warnings.some((w) => w.includes('[META_RESUMABLE_HANDOVER_FLEET_INCOMPLETE]') && w.includes('old-version')), 'and the gateway says which client lacks them');
  console.log('PASS 6: flag on - a client without the capabilities stops the trigger (fail closed).');

  // 6b. a client that predates the endpoint altogether (404) also stops it
  await withHarness([
    { id: 'target-b', routes: [campaign('camp-b', 'handover trigger six b')], pending: capable() },
    { id: 'ancient', routes: [campaign('camp-a', 'another trigger')], pendingStatus: 404 },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'h6b', 'handover trigger six b', () => stats['ancient'].pendingCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(stats['target-b'].forwardCalls, 0, 'a client with no pending-route endpoint stops the trigger');
  });
  console.log('PASS 6b: flag on - a client that predates the endpoint stops the trigger.');

  // 6c. the same incomplete fleet does NOT hold up a message that is not a trigger (a follow-up reaching the client that owns the conversation)
  await withHarness([
    { id: 'owner-c', routes: [campaign('camp-c', 'follow trigger')], pending: capable({ pending: true, campaignId: 'camp-c' }) },
    { id: 'old-version', routes: [campaign('camp-a', 'another trigger')], pending: { pending: false, activeWork: false } },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'h6c', 'a plain follow up, no trigger', () => stats['owner-c'].forwardCalls > 0);
    assert.equal(stats['owner-c'].forwardCalls, 1, 'follow-ups are not blocked by an incomplete fleet');
  });
  console.log('PASS 6c: flag on - an incomplete fleet does not hold up messages that are not triggers.');

  // 6d. flag ON, a client whose live check FAILED is not counted as lacking (the existing blind cancel and its retry handle it); the others are complete
  await withHarness([
    { id: 'target-b', routes: [campaign('camp-b', 'handover trigger six d')], pending: capable() },
    { id: 'down-a', routes: [campaign('camp-a', 'another trigger')], pendingStatus: 500, clearBody: { removed: 0, cancelled: true } },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'h6d', 'handover trigger six d', () => stats['target-b'].forwardCalls > 0);
    assert.equal(stats['target-b'].forwardCalls, 1, 'delivered after the blind cancel of the client whose check failed was confirmed');
    assert.ok(stats['down-a'].clearCalls >= 1);
  });
  console.log('PASS 6d: flag on - a failed live check is handled by the existing blind cancel, not by the capability rule.');

  // 6e. flag ON and the TARGET's own live check fails: nothing confirms its capabilities and the target is never cancelled, so the trigger
  // must be held back (Codex review of 33ce19b, finding 1). Once the target answers with full capabilities it goes through.
  warnings.length = 0;
  const flakyTarget = { id: 'target-e', routes: [campaign('camp-b', 'handover trigger six e')], pendingStatus: 500 };
  await withHarness([
    flakyTarget,
    { id: 'idle-a', routes: [campaign('camp-a', 'another trigger')], pending: capable(), clearBody: { removed: 0, cancelled: true } },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'h6e', 'handover trigger six e', () => stats['target-e'].pendingCalls >= 2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(stats['target-e'].forwardCalls, 0, 'target whose check failed: trigger not delivered');
    assert.equal(stats['target-e'].clearCalls, 0, 'the target is never cancelled');
    assert.equal(stats['idle-a'].clearCalls, 0, 'and no partial handover happens');
    assert.ok(warnings.some((w) => w.includes('FLEET_INCOMPLETE') && w.includes('target-e')), 'the gateway says the target is the one missing');
    flakyTarget.pendingStatus = 200; flakyTarget.pending = capable();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && stats['target-e'].forwardCalls === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stats['target-e'].forwardCalls, 1, 'delivered by the retry once the target reports full capabilities');
  });
  console.log('PASS 6e: flag on - a target whose own check failed holds the trigger back until it reports its capabilities.');

  // 7. flag OFF again: no capability warning at all
  delete process.env.META_RESUMABLE_HANDOVER;
  warnings.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 61_000 > 0 ? 0 : 0));
  await withHarness([
    { id: 'target-b', routes: [campaign('camp-b', 'handover trigger seven')], pending: capable() },
    { id: 'old-version', routes: [campaign('camp-a', 'another trigger')], pending: { pending: false, activeWork: false } },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'h7', 'handover trigger seven', () => stats['target-b'].forwardCalls > 0);
    assert.equal(stats['target-b'].forwardCalls, 1, 'flag off: an old client blocks nothing');
  });
  assert.ok(!warnings.some((w) => w.includes('FLEET_INCOMPLETE')), 'flag off: silent');
  console.log('PASS 7: flag off - no capability noise.');

  console.log('PASS: Meta resumable handover behaves as specified.');
})().then(() => setTimeout(() => process.exit(0), 200), (error) => {
  console.error(error);
  setTimeout(() => process.exit(1), 200);
});
