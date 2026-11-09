'use strict';
/**
 * BaileysProvider reconnect decisions and the disconnect diagnostic line (no real WhatsApp socket; handleConnectionUpdate is driven directly).
 *
 * Regression from 9.11.2026: after a pairing-code link, `pairingPhone` stayed set for the life of the provider, so a later ordinary
 * `status=500` disconnect was treated as a failed one-shot pairing and NO reconnect was scheduled (the watchdog restarted it 221s later).
 * Everything that must NOT change is pinned too: a disconnect during pairing is still terminal, 515 still reconnects in 250ms, a
 * logged-out session is still cleared and never reconnected.
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-reconnect-'));
process.env.STORAGE_PATH = path.join(dir, 'storage.json');
process.env.SESSION_PATH = path.join(dir, 'session');
const { Storage } = require('../dist/storage');
const { botState } = require('../dist/botState');
const { BaileysProvider, logDisconnectDetail } = require('../dist/providers/BaileysProvider');

const fakeBaileys = { DisconnectReason: { loggedOut: 401, restartRequired: 515 } };
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}

function quiet() {
  const lines = [];
  const real = { warn: console.warn, log: console.log, error: console.error };
  const take = (...a) => { lines.push(a.map(String).join(' ')); };
  console.warn = take; console.log = take; console.error = take;
  return { lines, restore() { console.warn = real.warn; console.log = real.log; console.error = real.error; } };
}

/** Run one connection update and report which reconnect delay (if any) was scheduled. The scheduled reconnect itself never runs. */
async function drive(provider, update) {
  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(() => {}, 1); };
  const q = quiet();
  try { await provider.handleConnectionUpdate(fakeBaileys, update); } finally { global.setTimeout = realSetTimeout; q.restore(); }
  return { delays, lines: q.lines };
}
const close = (statusCode, message = 'Connection Closed', data) => ({ connection: 'close', lastDisconnect: { error: { message, output: { statusCode }, data } } });
const open = { connection: 'open' };
const reset = () => { botState.reconnectAttempts = 0; botState.pairingError = null; botState.lifecycle = 'running'; };

(async () => {
  const storage = new Storage(process.env.STORAGE_PATH);

  await scenario('after a pairing-code link is open, an ordinary status=500 schedules a reconnect (the 221s gap)', async () => {
    reset();
    const p = new BaileysProvider(storage, '972501234567');
    await drive(p, open);
    const r = await drive(p, close(500, 'Stream Errored (ack)'));
    assert.deepEqual(r.delays, [10_000], 'first reconnect uses the normal backoff');
    assert.equal(botState.reconnectAttempts, 1);
  });

  await scenario('control: a provider that never used pairing reconnects on 500 exactly as before', async () => {
    reset();
    const p = new BaileysProvider(storage);
    await drive(p, open);
    const r = await drive(p, close(500));
    assert.deepEqual(r.delays, [10_000]);
  });

  await scenario('unchanged: a disconnect DURING pairing (before open) is terminal: no reconnect, the code is cleared', async () => {
    reset();
    const p = new BaileysProvider(storage, '972501234567');
    const r = await drive(p, close(500));
    assert.deepEqual(r.delays, [], 'no reconnect while the one-shot pairing attempt is still unfinished');
    assert.match(String(botState.pairingError), /./);
  });

  await scenario('unchanged: 515 right after pairing reconnects in 250ms, and the following open clears the pairing flag', async () => {
    reset();
    const p = new BaileysProvider(storage, '972501234567');
    const a = await drive(p, close(515, 'Stream Errored (restart required)'));
    assert.deepEqual(a.delays, [250]);
    await drive(p, open);
    const b = await drive(p, close(500));
    assert.deepEqual(b.delays, [10_000], 'a later 500 now reconnects');
  });

  await scenario('unchanged: logged out (401) is never reconnected and the saved session is cleared', async () => {
    reset();
    const authDir = path.join(process.env.SESSION_PATH, 'baileys');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{}');
    const p = new BaileysProvider(storage);
    await drive(p, open);
    const r = await drive(p, close(401, 'Connection Failure'));
    assert.deepEqual(r.delays, []);
    assert.equal(fs.existsSync(authDir), false, 'the saved auth session was removed');
  });

  await scenario('backoff keeps growing on repeated failures after a pairing-code link (no reset to the first delay)', async () => {
    reset();
    const p = new BaileysProvider(storage, '972501234567');
    await drive(p, open);
    const a = await drive(p, close(500));
    const b = await drive(p, close(500));
    assert.deepEqual([a.delays[0], b.delays[0]], [10_000, 30_000]);
  });

  await scenario('disconnect detail line: status, library message and tag/class/type only; ids and phone numbers never appear', async () => {
    const q = quiet();
    try {
      logDisconnectDetail(500, { message: 'Stream Errored (ack)', data: { tag: 'ack', attrs: { class: 'status', type: 'media', id: '3EB0ABCDEF1234567890', from: '972501234567@s.whatsapp.net', participant: '972509876543@lid' } } });
    } finally { q.restore(); }
    const line = q.lines.find((l) => l.includes('[BAILEYS_DISCONNECT]'));
    assert.ok(line, 'logged');
    assert.match(line, /status=500 message="Stream Errored \(ack\)" node=ack class=status type=media code=-/);
    assert.doesNotMatch(line, /3EB0ABCDEF|972501234567|972509876543|s\.whatsapp\.net|@lid/);
  });

  await scenario('disconnect detail line tolerates missing / odd error data and strips long digit runs from the message', async () => {
    const q = quiet();
    try {
      logDisconnectDetail(undefined, undefined);
      logDisconnectDetail(428, { message: 'Connection Closed' });
      logDisconnectDetail(500, { message: 'boom 972501234567 jid', data: 'not-an-object' });
      logDisconnectDetail(515, { message: 'x', data: { attrs: { code: '1234567890123' } } });
      logDisconnectDetail(500, { get message() { throw new Error('hostile getter'); } });
    } finally { q.restore(); }
    const lines = q.lines.filter((l) => l.includes('[BAILEYS_DISCONNECT]'));
    assert.equal(lines.length, 4, 'the hostile one is swallowed, the other four are logged');
    assert.match(lines[0], /status=- message="-"/);
    assert.match(lines[2], /boom # jid/);
    assert.doesNotMatch(lines.join('\n'), /972501234567|1234567890123/);
  });

  await scenario('the existing "Baileys disconnected. status=N" line is unchanged (external greps depend on it)', async () => {
    reset();
    const p = new BaileysProvider(storage);
    const r = await drive(p, close(500, 'Stream Errored (ack)'));
    assert.ok(r.lines.includes('Baileys disconnected. status=500'));
    assert.ok(r.lines.some((l) => l.startsWith('[BAILEYS_DISCONNECT] status=500')));
  });

  for (const r of results) console.log(r[1].padEnd(5), r[0], r[2] || '');
  const failed = results.filter((r) => r[1] !== 'PASS').length;
  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})();
