'use strict';
// (v1 gateway) A participant taps a repeatable button shortly AFTER her flow ended. No trigger matches and no client has a pending question,
// which the gateway used to drop (reason=no_trigger_or_pending_conversation). A client that reports repeatWindowCampaignId for the
// sender may take that button tap - and only that, and only when exactly one client does.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-v1-gateway-'));
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

function metaButtonPayload(id, buttonId = 'option-share') {
  const payload = metaPayload(id, '');
  const message = payload.entry[0].changes[0].value.messages[0];
  message.type = 'interactive';
  delete message.text;
  const title = replyTitle;
  if (replyShape === 'interactive_button') message.interactive = { type: 'button_reply', button_reply: { id: buttonId, title } };
  else if (replyShape === 'interactive_list') message.interactive = { type: 'list_reply', list_reply: { id: buttonId, title } };
  else if (replyShape === 'button_payload') { message.type = 'button'; message.button = { payload: buttonId, text: title }; }
  else if (replyShape === 'button_reply') message.button_reply = { id: buttonId, title };
  else if (replyShape === 'list_reply') message.list_reply = { id: buttonId, title };
  else if (replyShape === 'reply') message.reply = { id: buttonId, title };
  else throw new Error('unknown shape ' + replyShape);
  message.context = { id: 'wamid.QUESTION' };
  return payload;
}
// Every webhook shape getMetaInboundBody / isMetaButtonReply understand (Codex review of 33ce19b, finding 5).
const REPLY_SHAPES = ['interactive_button', 'interactive_list', 'button_payload', 'button_reply', 'list_reply', 'reply'];
let replyShape = 'interactive_button';
let replyTitle = 'Share';

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

async function sendAndWait(adminUrl, messageId, body, until, button = false, buttonId) {
  const response = await fetch(`${adminUrl}/webhooks/meta/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(button ? metaButtonPayload(messageId, buttonId) : metaPayload(messageId, body)),
  });
  assert.equal(response.status, 200);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !until()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}


const { issueButtonId, deriveRouteKey } = require('../dist/buttonToken');
const MASTER = { k1: Buffer.alloc(32, 7), k2: Buffer.alloc(32, 9) };
const FULL = Buffer.alloc(32, 3);
process.env.META_BUTTON_ROUTE_MASTER_KEYS = Object.entries(MASTER).map(([kid, key]) => `${kid}:${key.toString('base64url')}`).join(',');
const nowSec = () => Math.floor(Date.now() / 1000);
function v1(clientId, { kid = 'k1', exp = nowSec() + 3600, resultId = 'res1', stepId = 'q1', optionId = 'o1', rev = 'rev12345' } = {}) {
  return issueButtonId({ kid, clientId, resultId, stepId, optionId, rev, exp }, { routeKey: deriveRouteKey(MASTER[kid] ?? MASTER.k1, clientId), fullKey: FULL });
}
const windowOpen = { pending: false, activeWork: false, repeatWindowCampaignId: 'camp-a' };
const quiet = async (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));
const noFanOut = (stats) => { for (const id of Object.keys(stats)) { assert.equal(stats[id].pendingCalls, 0, `${id}: no pending-route fan-out`); assert.equal(stats[id].clearCalls, 0, `${id}: no handover`); } };
const twoClients = () => [
  { id: 'client-a', routes: [campaign('camp-a', 'trigger a')], pending: windowOpen },
  { id: 'client-b', routes: [campaign('camp-b', 'trigger b')] },
];

(async () => {
  await withHarness(twoClients(), async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'v1a', '', () => stats['client-b'].forwardCalls > 0, true, v1('client-b'));
    assert.equal(stats['client-b'].forwardCalls, 1, 'a valid tap goes to the client that issued it');
    assert.equal(stats['client-a'].forwardCalls, 0, 'even though client-a has an open repeat window');
    noFanOut(stats);
  });
  console.log('PASS 1: a valid v1 tap is routed straight to its issuing client, no fan-out, no handover.');

  const good = v1('client-b');
  const parts = good.split('.');
  const mutate = (index, replacement) => { const copy = parts.slice(); copy[index] = replacement; return copy.join('.'); };
  const bad = {
    'tampered step': mutate(4, Buffer.from('q2').toString('base64url')),
    'tampered client (signature no longer fits)': mutate(2, Buffer.from('client-a').toString('base64url')),
    'tampered expiry': mutate(7, (nowSec() + 999999).toString(36)),
    'cut signature': good.slice(0, -3),
    'garbage after v1.': 'v1.garbage',
    'expired': v1('client-b', { exp: nowSec() - 3600 }),
    'unknown kid': v1('client-b', { kid: 'k9' }),
    'client that is not on this number': v1('client-zzz'),
  };
  for (const [label, id] of Object.entries(bad)) {
    await withHarness(twoClients(), async ({ adminUrl, stats }) => {
      await sendAndWait(adminUrl, 'v1bad-' + label.replace(/[^a-z0-9]+/gi, '_'), '', () => false, true, id);
      await quiet();
      assert.equal(stats['client-a'].forwardCalls + stats['client-b'].forwardCalls, 0, `${label}: nothing is forwarded (not even through the legacy repeat window)`);
      noFanOut(stats);
    });
  }
  console.log(`PASS 2: ${Object.keys(bad).length} kinds of bad v1 ids are dropped and never fall back to the legacy path.`);

  process.env.META_BUTTON_REVOKED_KIDS = 'k1';
  await withHarness(twoClients(), async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'v1rev', '', () => false, true, v1('client-b'));
    await quiet();
    assert.equal(stats['client-b'].forwardCalls, 0, 'a revoked kid is refused at once');
    noFanOut(stats);
  });
  delete process.env.META_BUTTON_REVOKED_KIDS;
  console.log('PASS 3: a revoked key id is refused immediately.');

  const savedKeys = process.env.META_BUTTON_ROUTE_MASTER_KEYS;
  delete process.env.META_BUTTON_ROUTE_MASTER_KEYS;
  await withHarness(twoClients(), async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'v1nokeys', '', () => false, true, v1('client-b'));
    await quiet();
    assert.equal(stats['client-b'].forwardCalls, 0, 'a gateway with no keys configured cannot verify, so it refuses');
  });
  process.env.META_BUTTON_ROUTE_MASTER_KEYS = savedKeys;
  console.log('PASS 4: no keys configured at the gateway -> v1 refused, never guessed.');

  await withHarness(twoClients(), async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'legacy1', '', () => stats['client-a'].forwardCalls > 0, true, 'option-share');
    assert.equal(stats['client-a'].forwardCalls, 1, 'an old-style id still reaches the repeat-window client exactly as before');
    assert.ok(stats['client-a'].pendingCalls > 0, 'through the existing fan-out');
  });
  console.log('PASS 5: legacy ids are untouched.');

  await withHarness(twoClients(), async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'typed1', `${good}`, () => stats['client-a'].pendingCalls > 0 && stats['client-b'].pendingCalls > 0);
    await quiet();
    assert.equal(stats['client-b'].forwardCalls, 0, 'a v1-looking TEXT is just text: it is not a button and is not honoured as one');
    assert.ok(stats['client-a'].pendingCalls > 0, 'it took the normal path');
  });
  console.log('PASS 6: typed text that looks like a v1 id is not a button.');
  for (const shape of REPLY_SHAPES) {
    replyShape = shape;
    await withHarness(twoClients(), async ({ adminUrl, stats }) => {
      await sendAndWait(adminUrl, `shape-ok-${shape}`, '', () => stats['client-b'].forwardCalls > 0, true, v1('client-b'));
      assert.equal(stats['client-b'].forwardCalls, 1, `${shape}: a valid v1 reaches its client`);
      assert.equal(stats['client-a'].forwardCalls, 0, `${shape}: and only that client`);
      noFanOut(stats);
    });
    await withHarness(twoClients(), async ({ adminUrl, stats }) => {
      await sendAndWait(adminUrl, `shape-bad-${shape}`, '', () => false, true, v1('client-b', { exp: nowSec() - 3600 }));
      await quiet();
      assert.equal(stats['client-a'].forwardCalls + stats['client-b'].forwardCalls, 0, `${shape}: a bad v1 is dropped, not sent down the legacy path`);
      noFanOut(stats);
    });
  }
  replyShape = 'interactive_button';
  console.log(`PASS 7: valid and bad v1 ids behave the same in all ${REPLY_SHAPES.length} webhook shapes.`);

  // The visible title is never a token: a legacy id whose TITLE looks like a v1 id takes the legacy path untouched.
  replyTitle = good;
  await withHarness(twoClients(), async ({ adminUrl, stats }) => {
    await sendAndWait(adminUrl, 'title1', '', () => stats['client-a'].forwardCalls > 0, true, 'option-share');
    assert.equal(stats['client-b'].forwardCalls, 0, 'title text is not honoured as a token');
    assert.equal(stats['client-a'].forwardCalls, 1, 'the legacy id decided the route');
  });
  replyTitle = 'Share';
  console.log('PASS 8: a title that looks like a v1 id is not a token.');
  console.log('PASS: v1 buttons at the gateway behave as specified.');
})().then(() => setTimeout(() => process.exit(0), 200), (error) => {
  console.error(error);
  setTimeout(() => process.exit(1), 200);
});
