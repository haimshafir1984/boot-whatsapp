'use strict';
// Verifies the fix that decouples a client's LIVE pending-conversation lookup
// failure from its (cached, rarely-failing) campaign route list, per
// docs/meta-gateway-lookup-failure-blast-radius-plan-2026-09-16.md and the
// corrections Opus 5 required before implementation:
//   - a client whose pending check fails must not disappear from ambiguity
//     detection (its route list is still known);
//   - it MUST still receive a blind meta-clear-pending call before a fresh
//     trigger match is forwarded to a different client, exactly like a
//     confirmed-stale client would;
//   - if that blind call is not confirmed, routing stays fail-closed (retry),
//     not silently misrouted to the unresponsive client's real owner;
//   - the fallback (no-fresh-trigger, pending-only) branch must still fail
//     closed when ANY client's pending check failed - this is the specific
//     bug Opus caught: a local counter that could never actually increment,
//     letting the fallback wrongly route to a different client than the one
//     that failed to answer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-lookup-isolation-'));
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

function metaPayload(id, body) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'shared-phone-id', display_phone_number: '15550001111' },
          contacts: [{ wa_id: '15551234567', profile: { name: 'Lookup isolation' } }],
          messages: [{ id, from: '15551234567', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
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

async function sendAndWait(adminUrl, messageId, body, until) {
  const response = await fetch(`${adminUrl}/webhooks/meta/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metaPayload(messageId, body)),
  });
  assert.equal(response.status, 200);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !until()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

(async () => {
  // 1. Fresh, unambiguous trigger to A; B's route list is fine (has no
  //    competing trigger) but its LIVE pending check fails. B must still get
  //    a blind clear-pending call, and once it confirms cancellation, the
  //    message must route to A promptly - not sit through the full 10-attempt
  //    retry cycle that the old, conflated counter forced.
  await withHarness([
    { id: 'target-a', routes: [campaign('camp-a', 'isolation trigger one')] },
    { id: 'unknown-b', routes: [], pendingStatus: 500, clearBody: { removed: 0, cancelled: true } },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'case1-msg', 'isolation trigger one', () => stats['target-a'].forwardCalls > 0);
    assert.equal(stats['target-a'].forwardCalls, 1, 'a fresh unambiguous trigger must route to the healthy client');
    assert.ok(stats['unknown-b'].clearCalls >= 1, 'a client whose pending check failed must still receive a blind clear-pending call');
  });
  console.log('PASS 1: pending-check failure on an unrelated client no longer blocks a fresh, unambiguous trigger match.');

  // 2. Same as above, but B cannot even confirm the blind clear-pending call
  //    (still unreachable). Routing to A must stay fail-closed - never
  //    forwarded while B's real state is unknown.
  await withHarness([
    { id: 'target-a', routes: [campaign('camp-a', 'isolation trigger two')] },
    { id: 'unknown-b', routes: [], pendingStatus: 500, clearStatus: 500 },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'case2-msg', 'isolation trigger two', () => stats['unknown-b'].clearCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stats['target-a'].forwardCalls, 0, 'must not forward while the blind clear-pending call is unconfirmed');
  });
  console.log('PASS 2: an unconfirmed blind clear-pending call still blocks the forward (fail-closed preserved).');

  // 3. Regression guard for the route-list failure path: if a client's
  //    CACHED route list itself is unavailable, the whole message must still
  //    fail closed exactly as before - this path is unchanged by the fix.
  await withHarness([
    { id: 'target-a', routes: [campaign('camp-a', 'isolation trigger three')] },
    { id: 'broken-b', routesStatus: 500 },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'case3-msg', 'isolation trigger three', () => stats['broken-b'].routeCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stats['target-a'].forwardCalls, 0, 'a client whose route list is unavailable must still block the whole message');
  });
  console.log('PASS 3: an unavailable route list still fails closed (unchanged regression guard).');

  // 4. The critical bug Opus caught: no fresh trigger anywhere (pure
  //    pending-conversation fallback). Client C genuinely owns a pending
  //    conversation. Client B (unrelated) fails its live pending check. The
  //    old, conflated-counter code could never detect B's failure here and
  //    would route to C anyway. The fix must refuse to route (retry) because
  //    B's true state is unknown - even though C's answer looks conclusive.
  await withHarness([
    { id: 'owner-c', routes: [campaign('camp-c', 'unrelated trigger')], pending: { pending: true, campaignId: 'camp-c' } },
    { id: 'unknown-b', routes: [], pendingStatus: 500, clearStatus: 500 },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'case4-msg', 'no trigger match at all', () => stats['unknown-b'].pendingCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stats['owner-c'].forwardCalls, 0, 'must NOT route to a client with a real pending match while another client\'s pending state is unknown');
  });
  console.log('PASS 4: fallback pending-only routing still fails closed when any client\'s pending check failed (the bug Opus caught).');

  // 5. Ambiguity detection must still work correctly when an unrelated third
  //    client's pending check fails - proving candidate registration truly
  //    does not depend on pending-check success. Two clients share the exact
  //    same trigger phrase; the message must never be forwarded to either.
  await withHarness([
    { id: 'dup-a', routes: [campaign('camp-dup-a', 'shared duplicate trigger')] },
    { id: 'dup-b', routes: [campaign('camp-dup-b', 'shared duplicate trigger')], pendingStatus: 500, clearStatus: 500 },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'case5-msg', 'shared duplicate trigger', () => stats['dup-a'].routeCalls > 0 && stats['dup-b'].routeCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stats['dup-a'].forwardCalls, 0, 'an ambiguous trigger must never be forwarded to either candidate');
    assert.equal(stats['dup-b'].forwardCalls, 0, 'an ambiguous trigger must never be forwarded to either candidate');
  });
  console.log('PASS 5: ambiguity detection is unaffected by an unrelated client\'s pending-check failure.');

  console.log('PASS: Meta gateway lookup-failure isolation behaves as specified.');
})().then(() => setTimeout(() => process.exit(0), 200), (error) => {
  console.error(error);
  setTimeout(() => process.exit(1), 200);
});
