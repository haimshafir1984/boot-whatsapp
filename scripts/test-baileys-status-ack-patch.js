'use strict';
/**
 * scripts/patch-baileys-status-ack.js and the behaviour it adds (Baileys issue #2858: an unacknowledged <status> stanza makes WhatsApp close
 * the stream every ~50 minutes, status 500 "Stream Errored (ack)").
 *
 * Part A, the patch script (run as a child process on temp copies of the library): applies exactly once, is idempotent, and FAILS LOUDLY
 * (exit 1, file untouched) when the library version differs, an anchor is missing, the file is half patched or has CRLF; it leaves a library
 * that already handles <status> alone.
 *
 * Part B, the patched code itself: the real patched region of messages-recv.js (processNode, the offline processor map, the listeners) is
 * evaluated with stubbed dependencies and the REAL offline-node-processor and buildAckStanza. A live <status> and an offline="true" one are
 * each acknowledged exactly once with the right stanza, an ignored JID is acknowledged once, a failing ack is swallowed, and message nodes
 * are not touched.
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const BASE = path.join(ROOT, 'node_modules', '@whiskeysockets', 'baileys');
const SCRIPT = path.join(__dirname, 'patch-baileys-status-ack.js');
const INSTALLED = fs.readFileSync(path.join(BASE, 'lib', 'Socket', 'messages-recv.js'), 'utf8');
const VERSION = JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf8')).version;

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}

// ---- helpers for part A -----------------------------------------------------------------------------------------------------------------
/** The library file as it was before the patch (the inverse of the three insertions); works whether or not node_modules is patched yet. */
function pristine(text) {
  let t = text;
  t = t.replace(/    \/\/ FlowsBiz patch \(Baileys issue #2858\)[\s\S]*?    const handleStatusAck = async \(node\) => \{\n[^\n]*\n    \};\n/, '');
  t = t.replace("        ['notification', handleNotification],\n        ['status', handleStatusAck]\n    ]), {", "        ['notification', handleNotification]\n    ]), {");
  t = t.replace("    ws.on('CB:status', async (node) => {\n        await processNode('status', node, 'handling status', handleStatusAck);\n    });\n", '');
  return t;
}
function makeCopy(label, { text, version = VERSION } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `baileys-${label}-`));
  fs.mkdirSync(path.join(dir, 'lib', 'Socket'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@whiskeysockets/baileys', version }));
  fs.writeFileSync(path.join(dir, 'lib', 'Socket', 'messages-recv.js'), text ?? pristine(INSTALLED));
  return { dir, file: path.join(dir, 'lib', 'Socket', 'messages-recv.js') };
}
function run(dir) {
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, BAILEYS_PATCH_BASE_DIR: dir }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const count = (t, n) => t.split(n).length - 1;

(async () => {
  // ================= Part A =================
  await scenario('pristine library: patched exactly once, and the result equals the installed (patched) file', async () => {
    const c = makeCopy('a1');
    assert.equal(count(fs.readFileSync(c.file, 'utf8'), "ws.on('CB:status'"), 0, 'fixture really is unpatched');
    const r = run(c.dir);
    assert.equal(r.code, 0, r.out);
    const t = fs.readFileSync(c.file, 'utf8');
    assert.equal(count(t, 'const handleStatusAck = async (node) => {'), 1);
    assert.equal(count(t, "['status', handleStatusAck]"), 1);
    assert.equal(count(t, "ws.on('CB:status'"), 1);
    assert.equal(t, INSTALLED, 'same bytes as what npm install produced here');
  });

  await scenario('running it again changes nothing (idempotent)', async () => {
    const c = makeCopy('a2');
    run(c.dir); const once = fs.readFileSync(c.file, 'utf8');
    const r = run(c.dir);
    assert.equal(r.code, 0); assert.match(r.out, /already present/);
    assert.equal(fs.readFileSync(c.file, 'utf8'), once);
  });

  await scenario('half patched file (listener missing) fails loudly and is left untouched', async () => {
    const full = INSTALLED;
    const half = full.replace("    ws.on('CB:status', async (node) => {\n        await processNode('status', node, 'handling status', handleStatusAck);\n    });\n", '');
    const c = makeCopy('a3', { text: half });
    const r = run(c.dir);
    assert.equal(r.code, 1); assert.match(r.out, /partly patched/);
    assert.equal(fs.readFileSync(c.file, 'utf8'), half);
  });

  await scenario('a different library version fails (the patch is locked) and leaves the file alone', async () => {
    const c = makeCopy('a4', { version: '7.0.0-rc15' });
    const before = fs.readFileSync(c.file, 'utf8');
    const r = run(c.dir);
    assert.equal(r.code, 1); assert.match(r.out, /locked to/);
    assert.equal(fs.readFileSync(c.file, 'utf8'), before);
  });

  await scenario('an upstream change of an anchor fails loudly instead of skipping silently', async () => {
    const changed = pristine(INSTALLED).replace("['notification', handleNotification]\n    ]), {", "['notification', handleNotification],\n        ['somethingNew', handleNotification]\n    ]), {");
    const c = makeCopy('a5', { text: changed });
    const r = run(c.dir);
    assert.equal(r.code, 1); assert.match(r.out, /anchor "offline map" found 0 times/);
    assert.equal(fs.readFileSync(c.file, 'utf8'), changed);
  });

  await scenario('a library that already handles <status> natively is accepted without a second ack', async () => {
    const native = pristine(INSTALLED).replace("    ws.on('CB:ack,class:message'", "    ws.on('CB:status', async () => {});\n    ws.on('CB:ack,class:message'");
    const c = makeCopy('a6', { text: native, version: '7.0.0-rc16' });
    const r = run(c.dir);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /natively/);
    assert.equal(fs.readFileSync(c.file, 'utf8'), native);
  });

  await scenario('CRLF line endings and a missing file both fail', async () => {
    const crlf = makeCopy('a7', { text: pristine(INSTALLED).replace(/\n/g, '\r\n') });
    assert.equal(run(crlf.dir).code, 1);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-a7b-'));
    assert.equal(run(empty).code, 1);
  });

  // ================= Part B =================
  const start = INSTALLED.indexOf('    /// processes a node with the given function');
  const end = INSTALLED.indexOf("    ev.on('call', async ([call]) => {");
  assert.ok(start > 0 && end > start, 'the patched region is where expected');
  const region = INSTALLED.slice(start, end);
  const { makeOfflineNodeProcessor } = await import(pathToFileURL(path.join(BASE, 'lib', 'Utils', 'offline-node-processor.js')).href);
  const { buildAckStanza } = await import(pathToFileURL(path.join(BASE, 'lib', 'Utils', 'stanza-ack.js')).href);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const evalRegion = new AsyncFunction('ev', 'onUnexpectedError', 'handleMessage', 'handleCall', 'handleReceipt', 'handleNotification', 'handleBadAck', 'makeOfflineNodeProcessor', 'ws', 'S_WHATSAPP_NET', 'shouldIgnoreJid', 'areJidsSameUser', 'isJidGroup', 'authState', 'sendMessageAck', 'NACK_REASONS', 'logger', `${region}; return { processNode };`);

  function harness({ ackImpl, ignore = () => false } = {}) {
    const calls = { ack: [], message: [], unexpected: [], logged: [], order: [] };
    const listeners = new Map();
    const ws = { isOpen: true, on: (event, fn) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); } };
    const deps = {
      ev: { buffer() {}, flush() {} },
      onUnexpectedError: (err, id) => calls.unexpected.push([String(err), id]),
      handleMessage: async (node) => { calls.message.push(node); calls.order.push('message'); },
      handleCall: async () => {}, handleReceipt: async () => {}, handleNotification: async () => {}, handleBadAck: async () => {},
      makeOfflineNodeProcessor, ws, S_WHATSAPP_NET: 's.whatsapp.net',
      shouldIgnoreJid: ignore, areJidsSameUser: () => false, isJidGroup: () => false,
      authState: { creds: { me: { id: '972500000000:1@s.whatsapp.net', lid: '1@lid' } } },
      sendMessageAck: async (...args) => { calls.ack.push(args); calls.order.push('ack'); if (ackImpl) return ackImpl(...args); },
      NACK_REASONS: { UnhandledError: 487, ParsingError: 487 },
      logger: { error: (...a) => calls.logged.push(a), warn() {}, debug() {}, info() {} },
    };
    const ready = evalRegion(...Object.values(deps));
    return { calls, listeners, ready, emit: async (event, node) => { for (const fn of listeners.get(event) ?? []) await fn(node); } };
  }
  const statusNode = (extra = {}) => ({ tag: 'status', attrs: { from: 'status@broadcast', id: 'ABC123', type: 'media', participant: '972501111111@s.whatsapp.net', ...extra }, content: [] });
  const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

  await scenario('exactly one CB:status listener is registered by the patched code', async () => {
    const h = harness(); await h.ready;
    assert.equal((h.listeners.get('CB:status') ?? []).length, 1);
    assert.equal((h.listeners.get('CB:message') ?? []).length, 1, 'message listener unchanged');
  });

  await scenario('a live <status> is acknowledged exactly once with the node itself; no message handler runs', async () => {
    const h = harness(); await h.ready;
    const node = statusNode();
    await h.emit('CB:status', node); await flush();
    assert.equal(h.calls.ack.length, 1);
    assert.equal(h.calls.ack[0][0], node);
    assert.equal(h.calls.ack[0].length, 1, 'a plain ack: no error code');
    assert.equal(h.calls.message.length, 0);
    assert.equal(h.calls.unexpected.length, 0);
  });

  await scenario('a <status> flagged offline="true" goes through the offline queue and is acknowledged once, in order', async () => {
    const h = harness(); await h.ready;
    const msg = { tag: 'message', attrs: { from: '972502222222@s.whatsapp.net', id: 'M1', offline: '1' }, content: [] };
    await h.emit('CB:message', msg);
    await h.emit('CB:status', statusNode({ offline: '2' }));
    await h.emit('CB:message', { ...msg, attrs: { ...msg.attrs, id: 'M2' } });
    await flush();
    assert.deepEqual(h.calls.order, ['message', 'ack', 'message'], 'processed in arrival order through the same queue');
    assert.equal(h.calls.ack.length, 1);
    assert.equal(h.calls.unexpected.length, 0);
  });

  await scenario('a <status> from an ignored JID is acknowledged once (fast path), not twice', async () => {
    const h = harness({ ignore: () => true }); await h.ready;
    await h.emit('CB:status', statusNode()); await flush();
    assert.equal(h.calls.ack.length, 1);
  });

  await scenario('a failing ack is logged and swallowed: no unexpected-error path, no unhandled rejection', async () => {
    const unhandled = []; const onRej = (e) => unhandled.push(e); process.on('unhandledRejection', onRej);
    try {
      const h = harness({ ackImpl: async () => { throw new Error('socket closed'); } }); await h.ready;
      await h.emit('CB:status', statusNode()); await h.emit('CB:status', statusNode({ offline: '1', id: 'ABC124' })); await flush();
      assert.equal(h.calls.ack.length, 2);
      assert.equal(h.calls.logged.length, 2, 'both failures were logged');
      assert.equal(h.calls.unexpected.length, 0);
      assert.equal(unhandled.length, 0);
    } finally { process.off('unhandledRejection', onRej); }
  });

  await scenario('ordinary message / receipt / notification nodes behave exactly as before (no extra ack)', async () => {
    const h = harness(); await h.ready;
    await h.emit('CB:message', { tag: 'message', attrs: { from: '972503333333@s.whatsapp.net', id: 'M9' }, content: [] });
    await h.emit('CB:receipt', { tag: 'receipt', attrs: { from: '972503333333@s.whatsapp.net', id: 'R9' }, content: [] });
    await h.emit('CB:notification', { tag: 'notification', attrs: { from: 's.whatsapp.net', id: 'N9' }, content: [] });
    await flush();
    assert.equal(h.calls.message.length, 1);
    assert.equal(h.calls.ack.length, 0, 'only handleMessage/handleReceipt/handleNotification (stubbed here) would ack those');
  });

  await scenario("the library's own ack builder produces the stanza WhatsApp is waiting for (class=status, same id and type)", async () => {
    const stanza = buildAckStanza(statusNode(), undefined, '972500000000:1@s.whatsapp.net');
    assert.equal(stanza.tag, 'ack');
    assert.equal(stanza.attrs.class, 'status');
    assert.equal(stanza.attrs.id, 'ABC123');
    assert.equal(stanza.attrs.to, 'status@broadcast');
    assert.equal(stanza.attrs.type, 'media');
    assert.equal(stanza.attrs.participant, '972501111111@s.whatsapp.net');
    assert.equal(stanza.attrs.error, undefined, 'an ack, not a nack');
  });

  for (const r of results) console.log(r[1].padEnd(5), r[0], r[2] || '');
  const failed = results.filter((r) => r[1] !== 'PASS').length;
  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})();
