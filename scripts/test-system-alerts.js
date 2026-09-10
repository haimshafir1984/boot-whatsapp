const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ALERT_EMAIL_TO = 'ops@example.com';
process.env.ALERT_EMAIL_FROM = 'flowsbiz@example.com';
process.env.ALERT_EMAIL_THROTTLE_MS = '60000';
process.env.OWNER_ACCESS_TOKEN = 'client-owner-token';
process.env.META_GATEWAY_BASE_URL = 'https://admin.example.com';
process.env.CLIENT_NAME = 'Alert Test Client';
process.env.CLIENT_ACCESS_TOKEN = 'alert-test-client-token';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';
process.env.META_PHONE_NUMBER_ID = 'phone-id';
process.env.META_DISPLAY_PHONE_NUMBER = '972500000000';

const {
  isMetaAuthError,
  metaApiAlert,
  notifyClientSystemAlert,
  resetSystemAlertStateForTest,
  setSystemAlertEmailSenderForTest,
} = require('../dist/systemAlerts');

async function waitFor(predicate, label) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(label);
}

(async () => {
  resetSystemAlertStateForTest();
  const emails = [];
  const forwards = [];
  setSystemAlertEmailSenderForTest(async (message) => {
    emails.push(message);
  });
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    forwards.push({ url: String(url), options });
    return { ok: true, status: 200 };
  };

  try {
    const body = { error: { code: 190, error_subcode: 463, message: 'Session expired' } };
    assert.equal(isMetaAuthError(401, body), true);
    const alert = metaApiAlert(401, body, 'text');
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.key, 'meta-auth-token-invalid');

    notifyClientSystemAlert(alert);
    await waitFor(() => emails.length === 1 && forwards.length === 1, 'first alert should send email and forward to gateway');
    assert.equal(emails[0].to[0], 'ops@example.com');
    assert.match(emails[0].subject, /Meta token is invalid/);
    assert.match(emails[0].body, /phoneNumberId: phone-id/);
    assert.equal(forwards[0].url, 'https://admin.example.com/internal/client-alerts');
    assert.equal(forwards[0].options.headers['X-Owner-Token'], 'client-owner-token');

    notifyClientSystemAlert(alert);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(emails.length, 1, 'duplicate alert should be throttled locally');
    assert.equal(forwards.length, 1, 'duplicate alert should be throttled before forwarding to the gateway');

    global.fetch = originalFetch;
    emails.length = 0;
    process.env.ALERT_EMAIL_THROTTLE_MS = '0';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'system-alerts-'));
    const ownerPath = path.join(root, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify([{
      id: 'client-a',
      name: 'Client A',
      accessCode: 'client-a-code',
      ownerAccessToken: 'client-a-owner-token',
      plan: 'self_service',
      readonlyDashboard: false,
      maxCampaigns: 7,
      whatsappProvider: 'BAILEYS',
      managementUrl: 'https://client-a.example.com/client/',
      provisioningStatus: 'ready',
      createdAt: new Date().toISOString(),
    }], null, 2));
    const { config } = require('../dist/config');
    config.OWNER_STORAGE_PATH = ownerPath;
    config.STORAGE_PATH = path.join(root, 'storage.json');
    config.CONVERSATION_STATE_PATH = path.join(root, 'state.json');
    config.ADMIN_PORT = 0;
    const { Storage } = require('../dist/storage');
    const { startAdminServer } = require('../dist/adminServer');
    const storage = new Storage(config.STORAGE_PATH);
    const admin = startAdminServer(storage);
    if (!admin.listening) await new Promise((resolve) => admin.once('listening', resolve));
    const adminUrl = `http://127.0.0.1:${admin.address().port}`;
    const unauthorized = await fetch(`${adminUrl}/internal/client-alerts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-token': 'wrong' },
      body: JSON.stringify(alert),
    });
    assert.equal(unauthorized.status, 401);
    const accepted = await fetch(`${adminUrl}/internal/client-alerts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-token': 'client-a-owner-token' },
      body: JSON.stringify(alert),
    });
    assert.equal(accepted.status, 200);
    await waitFor(() => emails.length === 1, 'admin should email an accepted client alert');
    assert.match(emails[0].body, /clientId: client-a/);
    assert.match(emails[0].body, /clientName: Client A/);
    admin.closeAllConnections();
    await new Promise((resolve) => admin.close(resolve));

    console.log('System alert tests passed.');
  } finally {
    global.fetch = originalFetch;
    resetSystemAlertStateForTest();
  }
})().then(() => {
  setTimeout(() => process.exit(0), 100);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
