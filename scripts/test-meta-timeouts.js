/**
 * Stage B / 6.3 (last step) - explicit timeouts on every Graph API fetch, and the guarantee
 * that a timeout is an UNKNOWN outcome, not a reason to send again.
 *
 * Uses a fake global.fetch that honours the AbortSignal exactly like undici does (rejects
 * with signal.reason). No network.
 */
process.env.NODE_ENV = 'test';
process.env.META_ACCESS_TOKEN = 'test-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';
process.env.META_SEND_TIMEOUT_MS = '1000';           // the minimum the bounds allow
process.env.META_MEDIA_UPLOAD_TIMEOUT_MS = '1000';
process.env.BOT_REPLY_DELAY_MS = '0';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');
const { MetaCloudProvider, metaSendTimeoutMs, metaMediaUploadTimeoutMs } = require('../dist/providers/MetaCloudProvider');
const { classifySendError } = require('../dist/sendOutcome');

// AbortSignal.timeout() timers are unref'd; a server always has other handles, this bare test process does not.
const keepAlive = setInterval(() => {}, 1000);
const realFetch = global.fetch;
const dirs = [];
const mkdir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return; await sleep(10); } throw new Error(`timed out (${ms}ms): ${label}`); }
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.message || String(e)).split('\n').slice(0, 2).join(' | ')]); } finally { global.fetch = realFetch; } }

const hang = (init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
const hangingBody = (status, init) => new Response(new ReadableStream({ start(c) { init.signal.addEventListener('abort', () => c.error(init.signal.reason), { once: true }); } }), { status });

(async () => {
  await scenario('every Graph fetch carries an AbortSignal (messages and media)', async () => {
    const seen = [];
    const file = path.join(mkdir('tmo-a-'), 'a.png'); fs.writeFileSync(file, 'png-a-' + Date.now());
    global.fetch = async (url, init) => { seen.push([String(url).split('/').pop(), init.signal instanceof AbortSignal]); return String(url).endsWith('/media') ? new Response(JSON.stringify({ id: 'm1' }), { status: 200 }) : new Response(JSON.stringify({ messages: [{ id: 'w1' }] }), { status: 200 }); };
    await new MetaCloudProvider().sendFile('972500400001', file, 'c');
    assert.deepEqual(seen, [['media', true], ['messages', true]]);
  });

  await scenario('budgets are configurable and bounded (send 1s..120s, upload 1s..300s)', async () => {
    const keep = { ...process.env };
    process.env.META_SEND_TIMEOUT_MS = '1'; assert.equal(metaSendTimeoutMs(), 1000);
    process.env.META_SEND_TIMEOUT_MS = '99999999'; assert.equal(metaSendTimeoutMs(), 120000);
    process.env.META_SEND_TIMEOUT_MS = 'abc'; assert.equal(metaSendTimeoutMs(), 15000, 'default send budget is 15s');
    delete process.env.META_MEDIA_UPLOAD_TIMEOUT_MS; assert.equal(metaMediaUploadTimeoutMs(), 60000, 'default upload budget is 60s');
    Object.assign(process.env, keep);
  });

  await scenario('a hung message POST times out after the budget and is classified UNCERTAIN', async () => {
    global.fetch = async (url, init) => hang(init);
    const t0 = Date.now();
    await assert.rejects(() => new MetaCloudProvider().sendMessage('972500400002', 'hi'), (e) => classifySendError(e).outcome === 'uncertain');
    const took = Date.now() - t0; assert.ok(took >= 900 && took < 2500, `took ${took}ms`);
  });

  await scenario('a hung media UPLOAD times out as a retryable rejection (not uncertain) and no message is ever POSTed', async () => {
    let messagePosts = 0;
    global.fetch = async (url, init) => { if (String(url).endsWith('/messages')) { messagePosts++; return new Response('{}', { status: 200 }); } return hang(init); };
    const file = path.join(mkdir('tmo-b-'), 'b.png'); fs.writeFileSync(file, 'png-b-' + Date.now());
    await assert.rejects(() => new MetaCloudProvider().sendFile('972500400003', file, 'c'), (e) => classifySendError(e).outcome === 'rejected_transient');
    assert.equal(messagePosts, 0);
  });

  await scenario('200 OK whose body read times out: the message WAS accepted - resolves (no error, so no resend)', async () => {
    global.fetch = async (url, init) => hangingBody(200, init);
    const r = await new MetaCloudProvider().sendMessage('972500400004', 'hi');
    assert.deepEqual(r, {}, 'accepted, provider id unknown');
  });

  await scenario('5xx whose body read times out -> uncertain by status (not "transient")', async () => {
    global.fetch = async (url, init) => hangingBody(502, init);
    await assert.rejects(() => new MetaCloudProvider().sendMessage('972500400005', 'hi'), (e) => classifySendError(e).outcome === 'uncertain');
  });

  await scenario('END TO END: dispatcher + real MetaCloudProvider + hung Graph API: ONE POST, message parked uncertain, later message held, never resent across cycles', async () => {
    let posts = 0;
    global.fetch = async (url, init) => { posts++; return hang(init); };
    const storage = new Storage(path.join(mkdir('tmo-c-'), 's.json'));
    const m1 = storage.enqueueOutboxMessage({ kind: 'text', to: '972500400010', text: 'first' });
    await sleep(2);
    const m2 = storage.enqueueOutboxMessage({ kind: 'text', to: '972500400010', text: 'second' });
    const provider = new MetaCloudProvider();
    const d = startOutboxDispatcher(storage, () => provider, 300);   // 300ms poll: several cycles happen while we watch
    try {
      await waitFor(() => storage.getOutboxMessage(m1.id).status === 'uncertain', 4000, 'first parked as uncertain after the timeout');
      await sleep(1200);   // ~4 more poll cycles
      assert.equal(posts, 1, 'exactly ONE request reached the provider; a timeout must not become a second message');
      assert.equal(storage.getOutboxMessage(m2.id).status, 'queued');
      assert.equal(storage.getOutboxMessage(m1.id).attempts, 1);
    } finally { await d.stop(); }
  });

  let failed = 0;
  for (const [name, status, err] of results) { if (status === 'FAIL') failed++; console.log(`${status}  ${name}${err ? '\n      ' + err : ''}`); }
  console.log(`\ntimeouts: ${results.length - failed} passed, ${failed} failed`);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  clearInterval(keepAlive);
  process.exit(failed ? 1 : 0);
})();
