/**
 * The public GET /health (no login) must not expose participants' phone numbers or message text. It used to return
 * twilio.recentEvents (from / to / body / messageSid / details), and external uptime monitors now fetch it every 5 minutes.
 *
 * Also guards what other code reads from /health: check-ready and the provisioner depend on clientConfigured and storage.ready.
 * The authenticated /api/twilio/status endpoint is unchanged (login required).
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-pii-'));
process.env.NODE_ENV = 'test';
process.env.PORT = String(33000 + Math.floor(Math.random() * 4000));
process.env.CLIENT_ACCESS_TOKEN = 'health-pii-test-token';
process.env.STORAGE_PATH = path.join(dir, 'storage.json');   // twilio-events.json is written next to it

const assert = require('node:assert/strict');
const { Storage } = require('../dist/storage');
const { recordTwilioEvent } = require('../dist/twilioEvents');
const { startAdminServer } = require('../dist/adminServer');

const PHONE = '972501234567';
const TEXT = 'private message text should never be public';
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 4).join(' | ')]); }
}

(async () => {
  recordTwilioEvent({ direction: 'inbound', status: 'failed', from: `whatsapp:+${PHONE}`, to: 'whatsapp:+972555071008', body: TEXT, messageSid: 'SMsecretsid123', details: `Gateway route to client abc failed (409) for ${PHONE}` });
  const storage = new Storage(path.join(dir, 'storage.json'));
  startAdminServer(storage);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const base = `http://127.0.0.1:${process.env.PORT}`;

  await scenario('public /health: no recentEvents, no participant phone, no message text, no event ids/details', async () => {
    const res = await fetch(`${base}/health`);   // no cookie, no token
    assert.equal(res.status, 200);
    const raw = await res.text();
    const body = JSON.parse(raw);
    assert.equal('recentEvents' in (body.twilio || {}), false, 'twilio.recentEvents must not be public');
    for (const forbidden of [PHONE, TEXT, 'SMsecretsid123', 'Gateway route to client', 'whatsapp:+']) {
      assert.equal(raw.includes(forbidden), false, `public /health must not contain "${forbidden}"`);
    }
    assert.equal(/\+?972\d{8,9}/.test(JSON.stringify(body.twilio ?? {})), false, 'no phone number anywhere in the twilio block');
  });

  await scenario('public /health keeps the fields other code and monitors depend on', async () => {
    const body = await (await fetch(`${base}/health`)).json();
    assert.equal(body.ok, true, 'uptime monitors search for "ok":true');
    assert.equal(typeof body.clientConfigured, 'boolean', 'check-ready reads clientConfigured');
    assert.notEqual(body.storage?.ready, false, 'the provisioner health check treats storage.ready === false as not ready');
    assert.equal(typeof body.storage, 'object');
    assert.equal(body.twilio.configured, false);
    assert.ok(typeof body.twilio.lastEventAt === 'string', 'the timestamp of the last event stays available');
    assert.ok(JSON.stringify(body).includes('"ok":true'));
  });

  await scenario('the authenticated /api/twilio/status still returns the events (unchanged, behind login)', async () => {
    const unauth = await fetch(`${base}/api/twilio/status`);
    assert.ok([401, 403].includes(unauth.status), `unauthenticated status endpoint must be refused, got ${unauth.status}`);
    const login = await fetch(`${base}/auth/client/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: process.env.CLIENT_ACCESS_TOKEN }) });
    assert.equal(login.status, 200);
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    const res = await fetch(`${base}/api/twilio/status`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.recentEvents) && body.recentEvents.length >= 1);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.log(failed ? `\n${failed} scenario(s) FAILED` : '\nHealth no-PII tests passed.');
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(failed ? 1 : 0), 300);   // let the server sockets close first (avoids a libuv assertion on Windows)
})();
