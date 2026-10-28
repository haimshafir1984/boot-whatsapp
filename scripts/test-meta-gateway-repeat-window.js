'use strict';
// A participant taps a repeatable button shortly AFTER her flow ended. No trigger matches and no client has a pending question,
// which the gateway used to drop (reason=no_trigger_or_pending_conversation). A client that reports repeatWindowCampaignId for the
// sender may take that button tap - and only that, and only when exactly one client does.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-repeat-window-'));
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

(async () => {
  const windowOpen = { pending: false, activeWork: false, repeatWindowCampaignId: 'camp-a' };

  await withHarness([
    { id: 'owner-a', routes: [campaign('camp-a', 'repeat trigger one')], pending: windowOpen },
    { id: 'other-b', routes: [campaign('camp-b', 'something else')] },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'rw1', '', () => stats['owner-a'].forwardCalls > 0, true);
    assert.equal(stats['owner-a'].forwardCalls, 1, 'the button tap goes to the client whose repeat window is open');
    assert.equal(stats['other-b'].forwardCalls, 0);
  });
  console.log('PASS 1: a button tap inside the repeat window is routed to the one client that reports it.');

  await withHarness([
    { id: 'owner-a', routes: [campaign('camp-a', 'repeat trigger two')], pending: windowOpen },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'rw2', 'hello there', () => stats['owner-a'].pendingCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stats['owner-a'].forwardCalls, 0, 'a plain text message is not a button tap: still dropped');
  });
  console.log('PASS 2: only button taps use the repeat window.');

  await withHarness([
    { id: 'owner-a', routes: [campaign('camp-a', 'repeat trigger three')], pending: windowOpen },
    { id: 'owner-b', routes: [campaign('camp-b', 'repeat trigger four')], pending: { ...windowOpen, repeatWindowCampaignId: 'camp-b' } },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'rw3', '', () => stats['owner-a'].pendingCalls > 0 && stats['owner-b'].pendingCalls > 0, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stats['owner-a'].forwardCalls + stats['owner-b'].forwardCalls, 0, 'two open windows are ambiguous: never guess');
  });
  console.log('PASS 3: two clients with an open window -> not forwarded.');

  await withHarness([
    { id: 'owner-a', routes: [campaign('camp-a', 'repeat trigger five')] },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'rw4', '', () => stats['owner-a'].pendingCalls > 0, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stats['owner-a'].forwardCalls, 0, 'without an open window the old behaviour is unchanged (ignored)');
  });
  console.log('PASS 4: no open window -> unchanged, dropped as before.');

  await withHarness([
    { id: 'owner-a', routes: [campaign('camp-a', 'repeat trigger six')], pending: windowOpen },
    { id: 'owner-c', routes: [campaign('camp-c', 'unrelated')], pending: { pending: true, campaignId: 'camp-c' } },
  ], async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'rw5', '', () => stats['owner-c'].forwardCalls > 0, true);
    assert.equal(stats['owner-c'].forwardCalls, 1, 'a real pending conversation still wins');
    assert.equal(stats['owner-a'].forwardCalls, 0);
  });
  console.log('PASS 5: a real pending question keeps priority over the repeat window.');

  console.log('PASS: Meta gateway repeat-window routing behaves as specified.');
})().then(() => setTimeout(() => process.exit(0), 200), (error) => {
  console.error(error);
  setTimeout(() => process.exit(1), 200);
});
