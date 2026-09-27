'use strict';
// Covers inspectMetaTriggerAvailability()'s per-number scoping (adminServer.ts), added for the
// customer-owned-whatsapp-number-meta-plan.md feature (dedicated Meta numbers for a client's
// campaigns AND service bots - they share this same trigger-uniqueness check).
//
// Before the fix: a client on a dedicated number was still blocked by an unrelated client (on the
// shared number, or on a totally different dedicated number) being unreachable, because every Meta
// client's route list was fetched and required to answer before any scope filtering happened. That
// defeats the whole point of a dedicated number - it should not depend on strangers' health.
//
// This test proves, against the real adminServer.ts code (not a re-implementation):
//   1. A dedicated-number client's trigger check is NOT blocked by an unrelated, unreachable client
//      - neither one on the shared number nor one on a different dedicated number.
//   2. Two clients that share the SAME dedicated number still correctly conflict with each other.
//   3. The shared number's own conflict detection is unchanged: an unreachable DEDICATED-number
//      client must not block a SHARED-number requester either (isolation is symmetric), and a real
//      conflict between two shared-number clients (existing campaign behaviour) still fires.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-dedicated-scope-'));
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

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function clientRecord(id, managementUrl, metaPhoneNumberId) {
  return {
    id,
    name: id,
    accessCode: id,
    ownerAccessToken: `${id}-owner-token`,
    plan: 'self_service',
    readonlyDashboard: false,
    maxCampaigns: 7,
    whatsappProvider: 'META_CLOUD_API',
    metaPhoneNumberId,
    metaDisplayPhoneNumber: metaPhoneNumberId === 'shared-phone-id' ? '15550001111' : `1555${metaPhoneNumberId}`,
    managementUrl,
    provisioningStatus: 'ready',
    createdAt: new Date().toISOString(),
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
    stats[def.id] = { routeCalls: 0 };
    const server = http.createServer((req, res) => {
      if (req.url === '/owner-api/meta-routes') {
        stats[def.id].routeCalls += 1;
        if (def.routesStatus && def.routesStatus !== 200) return json(res, def.routesStatus, {});
        return json(res, 200, def.routes ?? []);
      }
      return json(res, 404, {});
    });
    const url = await listen(server);
    servers.push(server);
    ownerRecords.push(clientRecord(def.id, url, def.metaPhoneNumberId ?? 'shared-phone-id'));
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

async function checkAvailability(adminUrl, requesterId, triggerPhrase) {
  const response = await fetch(`${adminUrl}/internal/meta/trigger-availability`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-owner-token': `${requesterId}-owner-token` },
    body: JSON.stringify({ triggerPhrase }),
  });
  assert.equal(response.status, 200, `trigger-availability must not fail for ${requesterId}`);
  return response.json();
}

(async () => {
  // 1. A dedicated-number client's check must not be blocked by an unrelated, unreachable client -
  //    neither the shared number (whole fleet down would previously throw 503) nor a different
  //    dedicated number.
  await withHarness([
    { id: 'dedicated-requester', metaPhoneNumberId: 'dedicated-111', routes: [] },
    { id: 'shared-unreachable', metaPhoneNumberId: 'shared-phone-id', routesStatus: 500 },
    { id: 'other-dedicated-unreachable', metaPhoneNumberId: 'dedicated-999', routesStatus: 500 },
  ], async ({ adminUrl, stats }) => {
    const result = await checkAvailability(adminUrl, 'dedicated-requester', 'unique trigger one');
    assert.equal(result.available, true, 'a dedicated-number client must not be blocked by unrelated clients being down');
    assert.equal(stats['shared-unreachable'].routeCalls, 0, 'an unrelated shared-number client must not even be queried');
    assert.equal(stats['other-dedicated-unreachable'].routeCalls, 0, 'an unrelated dedicated-number client must not even be queried');
  });
  console.log('PASS 1: dedicated-number trigger check is isolated from unrelated clients being unreachable.');

  // 2. Two clients sharing the SAME dedicated number still correctly conflict with each other -
  //    scoping must narrow the check, not disable it.
  await withHarness([
    { id: 'dedicated-a', metaPhoneNumberId: 'dedicated-222', routes: [] },
    { id: 'dedicated-b', metaPhoneNumberId: 'dedicated-222', routes: [campaign('camp-b', 'shared trigger')] },
    { id: 'unrelated-shared', metaPhoneNumberId: 'shared-phone-id', routes: [campaign('camp-x', 'shared trigger')] },
  ], async ({ adminUrl }) => {
    const conflict = await checkAvailability(adminUrl, 'dedicated-a', 'shared trigger');
    assert.equal(conflict.available, false, 'same dedicated number: a real conflict must still be caught');
    assert.equal(conflict.conflicts.length, 1);
    assert.equal(conflict.conflicts[0].clientId, 'dedicated-b');
  });
  console.log('PASS 2: clients on the same dedicated number still conflict with each other.');

  // 3. Shared-number behaviour must be completely unaffected: existing campaigns depend on this.
  //    (a) a real conflict between two shared-number clients still fires;
  //    (b) an unreachable DEDICATED-number client must not block a SHARED-number requester either.
  await withHarness([
    { id: 'shared-a', metaPhoneNumberId: 'shared-phone-id', routes: [] },
    { id: 'shared-b', metaPhoneNumberId: 'shared-phone-id', routes: [campaign('camp-b', 'central trigger')] },
    { id: 'dedicated-unreachable', metaPhoneNumberId: 'dedicated-333', routesStatus: 500 },
  ], async ({ adminUrl, stats }) => {
    const conflict = await checkAvailability(adminUrl, 'shared-a', 'central trigger');
    assert.equal(conflict.available, false, 'shared number: cross-client conflict detection must be unchanged');
    assert.equal(conflict.conflicts[0].clientId, 'shared-b');
    assert.equal(stats['dedicated-unreachable'].routeCalls, 0, 'a shared-number requester must not depend on an unrelated dedicated number either');

    const free = await checkAvailability(adminUrl, 'shared-a', 'a brand new unused trigger');
    assert.equal(free.available, true, 'shared number: a genuinely free trigger is still available');
  });
  console.log('PASS 3: shared-number trigger checks (existing campaign behaviour) are unaffected.');

  console.log('meta-dedicated-number-trigger-scope tests passed.');
})().then(() => setTimeout(() => process.exit(0), 200), (error) => {
  console.error(error);
  setTimeout(() => process.exit(1), 200);
});
