'use strict';
/**
 * BaileysProvider logs a message that reached the socket but is not processed (undecryptable stub / no usable content), with the reason
 * WhatsApp gave. Own messages, status updates and groups stay silent, the log is rate limited, and normal messages are still handled.
 */
process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-skipped-'));
process.env.STORAGE_PATH = path.join(dir, 'storage.json');
process.env.SESSION_PATH = path.join(dir, 'session');
const { Storage } = require('../dist/storage');
const { BaileysProvider } = require('../dist/providers/BaileysProvider');

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 4).join(' | ')]); }
}

function capture() {
  const lines = [];
  const realWarn = console.warn; const realLog = console.log; const realErr = console.error;
  const take = (...a) => { lines.push(a.map(String).join(' ')); };
  console.warn = take; console.log = take; console.error = take;
  return { lines, restore() { console.warn = realWarn; console.log = realLog; console.error = realErr; } };
}

(async () => {
  const storage = new Storage(process.env.STORAGE_PATH);
  const provider = new BaileysProvider(storage);
  const nowSec = () => Math.floor(Date.now() / 1000);
  const skipped = (lines) => lines.filter((l) => l.includes('[BAILEYS_SKIPPED]'));

  await scenario('an undecryptable message (stub with the reason) is logged with sender, alt phone, age and the reason', async () => {
    const c = capture();
    try {
      await provider.handleMessages([{ key: { remoteJid: '54340060500178@lid', remoteJidAlt: '972523460705@s.whatsapp.net', id: 'ABC123', fromMe: false }, messageTimestamp: nowSec() - 4, messageStubType: 2, messageStubParameters: ['Bad MAC'] }]);
    } finally { c.restore(); }
    const [line] = skipped(c.lines);
    assert.ok(line, 'logged');
    assert.match(line, /reason=no_content/);
    assert.match(line, /from=54340060500178@lid/);
    assert.match(line, /alt=972523460705@s\.whatsapp\.net/);
    assert.match(line, /id=ABC123/);
    assert.match(line, /age=[3-6]s/);
    assert.match(line, /params=Bad MAC/);
  });

  await scenario('a message with content the bot cannot read as text is logged as empty_body with its kinds', async () => {
    const c = capture();
    try {
      await provider.handleMessages([{ key: { remoteJid: '972523460705@s.whatsapp.net', id: 'X1', fromMe: false }, messageTimestamp: nowSec(), message: { senderKeyDistributionMessage: {} } }]);
    } finally { c.restore(); }
    const [line] = skipped(c.lines);
    assert.ok(line);
    assert.match(line, /reason=empty_body/);
    assert.match(line, /kinds=senderKeyDistributionMessage/);
  });

  await scenario('own messages, status updates and groups are never logged', async () => {
    const c = capture();
    try {
      await provider.handleMessages([
        { key: { remoteJid: '972523460705@s.whatsapp.net', id: 'M1', fromMe: true }, messageTimestamp: nowSec(), messageStubType: 2 },
        { key: { remoteJid: 'status@broadcast', id: 'S1', fromMe: false }, messageTimestamp: nowSec(), messageStubType: 2 },
        { key: { remoteJid: '120363000000000000@g.us', id: 'G1', fromMe: false }, messageTimestamp: nowSec(), messageStubType: 2 },
      ]);
    } finally { c.restore(); }
    assert.equal(skipped(c.lines).length, 0);
  });

  await scenario('the log is rate limited (30 per minute)', async () => {
    const fresh = new BaileysProvider(storage);
    const c = capture();
    try {
      await fresh.handleMessages(Array.from({ length: 45 }, (_v, i) => ({ key: { remoteJid: `97250000${String(i).padStart(4, '0')}@s.whatsapp.net`, id: `R${i}`, fromMe: false }, messageTimestamp: nowSec(), messageStubType: 2 })));
    } finally { c.restore(); }
    assert.equal(skipped(c.lines).length, 30);
  });

  await scenario('a normal text message is still handled (no skipped line)', async () => {
    const c = capture();
    try {
      await provider.handleMessages([{ key: { remoteJid: '972523460705@s.whatsapp.net', id: 'T1', fromMe: false }, messageTimestamp: nowSec(), message: { conversation: 'hello there' }, pushName: 'Tester' }]);
    } finally { c.restore(); }
    assert.equal(skipped(c.lines).length, 0);
    assert.ok(c.lines.some((l) => l.includes('[STATE_MISS]') || l.includes('no trigger match')), 'it went through the normal handler');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nBaileys skipped-message log tests passed (${results.length} scenarios).`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})().catch((e) => { console.error(e); process.exit(1); });
