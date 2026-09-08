'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-mixed-rollout-'));
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
          contacts: [{ wa_id: '15551234567', profile: { name: 'Mixed rollout' } }],
          messages: [{ id, from: '15551234567', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
        },
      }],
    }],
  };
}

async function runCase({ oldPending }) {
  let clearCalls = 0;
  let forwarded = 0;

  const oldClient = http.createServer(async (req, res) => {
    if (req.url === '/owner-api/meta-routes') return json(res, 200, []);
    if (req.url === '/owner-api/meta-pending-route') return json(res, 200, { pending: oldPending });
    if (req.url === '/owner-api/meta-clear-pending') {
      clearCalls += 1;
      await readBody(req);
      return json(res, 200, { removed: oldPending ? 1 : 0 });
    }
    return json(res, 404, {});
  });

  const targetClient = http.createServer(async (req, res) => {
    if (req.url === '/owner-api/meta-routes') return json(res, 200, [{
      id: 'target-campaign',
      name: 'Target',
      triggerType: 1,
      triggerPhrase: 'mixed rollout start',
      suffix: '',
      active: true,
      runtimeStatus: 'active',
    }]);
    if (req.url === '/owner-api/meta-pending-route') return json(res, 200, { pending: false, activeWork: false });
    if (req.url === '/internal/meta/whatsapp') {
      forwarded += 1;
      await readBody(req);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, {});
  });

  const oldUrl = await listen(oldClient);
  const targetUrl = await listen(targetClient);
  const ownerPath = path.join(root, `owner-${oldPending ? 'pending' : 'idle'}.json`);
  fs.writeFileSync(ownerPath, JSON.stringify([
    clientRecord('legacy-old-client', oldUrl),
    clientRecord('target-client', targetUrl),
  ], null, 2));
  process.env.OWNER_STORAGE_PATH = ownerPath;

  const { Storage } = require('../dist/storage');
  const { config } = require('../dist/config');
  config.OWNER_STORAGE_PATH = ownerPath;
  config.ADMIN_PORT = 0;
  const storage = new Storage(path.join(root, `storage-${oldPending ? 'pending' : 'idle'}.json`));
  const admin = require('../dist/adminServer').startAdminServer(storage);
  if (!admin.listening) await new Promise((resolve) => admin.once('listening', resolve));
  const adminUrl = `http://127.0.0.1:${admin.address().port}`;
  const response = await fetch(`${adminUrl}/webhooks/meta/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metaPayload(oldPending ? 'mixed-pending' : 'mixed-idle', 'mixed rollout start')),
  });
  assert.equal(response.status, 200);

  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline && (oldPending ? clearCalls === 0 : forwarded === 0)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  admin.closeAllConnections();
  await close(admin);
  await Promise.all([close(oldClient), close(targetClient)]);

  return { clearCalls, forwarded };
}

(async () => {
  const idle = await runCase({ oldPending: false });
  assert.equal(idle.clearCalls, 0, 'idle legacy clients must not be asked for a new cancellation acknowledgement');
  assert.equal(idle.forwarded, 1, 'a fresh trigger must route during a mixed-version rollout when other clients are idle');

  const pending = await runCase({ oldPending: true });
  assert.equal(pending.clearCalls, 1, 'a legacy client with pending sender state must still be asked to clear');
  assert.equal(pending.forwarded, 0, 'a legacy client with pending state must not be bypassed without cancellation acknowledgement');

  console.log('PASS: Meta gateway tolerates idle legacy clients during rollout while failing closed on legacy pending state.');
})().then(() => setTimeout(() => process.exit(0), 200), (error) => {
  console.error(error);
  setTimeout(() => process.exit(1), 200);
});
