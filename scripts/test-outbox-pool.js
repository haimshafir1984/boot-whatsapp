/**
 * Stage B / 6.2 - independent progress and prompt start.
 *
 * On HEAD 0ea8d26 the dispatcher awaited Promise.all() on a batch of 20, so one hung
 * or slow send held back every recipient behind it, and a message enqueued after a tick
 * waited up to OUTBOX_POLL_MS (15s). These scenarios fail there.
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');

const dirs = [];
const newStorage = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-pool-')); dirs.push(d); return new Storage(path.join(d, 's.json')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return Date.now() - t0; await sleep(5); } throw new Error(`timed out (${ms}ms): ${label}`); }
const phone = (i) => `97254${String(1000000 + i)}`;
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.message || String(e)).split('\n').slice(0, 2).join(' | ')]); } }
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

(async () => {
  await scenario('one HUNG send does not block other recipients (40 recipients, 1st hangs)', async () => {
    const storage = newStorage();
    const ids = [];
    for (let i = 0; i < 40; i++) { ids.push(storage.enqueueOutboxMessage({ kind: 'text', to: phone(i), text: `m${i}` }).id); await sleep(1); }
    const gate = deferred(); const sent = [];
    const d = startOutboxDispatcher(storage, () => ({ async sendMessage(to) { if (to === phone(0)) await gate.promise; sent.push(to); return { messageId: 'x' }; } }), 60_000, { concurrency: 20 });
    try {
      await waitFor(() => sent.length >= 39, 2000, 'the 39 other recipients are sent while the first one hangs');
      assert.equal(storage.getOutboxMessage(ids[0]).status, 'processing');
      gate.resolve();
      await waitFor(() => storage.getOutboxHealth().sent === 40, 1000, 'hung one completes when released');
    } finally { gate.resolve(); await d.stop(); }
  });

  await scenario('slot refill: concurrency never exceeded, and a finished slot is reused immediately (no batch barrier)', async () => {
    const storage = newStorage();
    // 1 slow (300ms) + 8 fast (20ms) with concurrency 2: a barrier design needs 300ms per batch of 2.
    for (let i = 0; i < 9; i++) { storage.enqueueOutboxMessage({ kind: 'text', to: phone(100 + i), text: i === 0 ? 'slow' : 'fast' }); await sleep(1); }
    let active = 0; let maxActive = 0;
    const t0 = Date.now();
    const d = startOutboxDispatcher(storage, () => ({ async sendMessage(to, text) { active++; maxActive = Math.max(maxActive, active); await sleep(text === 'slow' ? 300 : 20); active--; return { messageId: 'x' }; } }), 60_000, { concurrency: 2 });
    try {
      await waitFor(() => storage.getOutboxHealth().sent === 9, 3000, 'all sent');
      const elapsed = Date.now() - t0;
      assert.equal(maxActive, 2);
      // barrier: pairs (slow,fast) 300 + 3 pairs of fast 20 = ~400ms+; pool: fast ones drain on the free slot while slow runs (~320ms)
      assert.ok(elapsed < 380, `pool should overlap fast sends with the slow one (took ${elapsed}ms)`);
    } finally { await d.stop(); }
  });

  await scenario('concurrency is bounded (1..100): 0 -> 1, 1000 -> 100', async () => {
    for (const [opt, expectMax] of [[0, 1], [1000, 100]]) {
      const storage = newStorage();
      for (let i = 0; i < 150; i++) storage.enqueueOutboxMessage({ kind: 'text', to: phone(200 + i), text: 'x' });
      let active = 0; let maxActive = 0;
      const d = startOutboxDispatcher(storage, () => ({ async sendMessage() { active++; maxActive = Math.max(maxActive, active); await sleep(opt === 0 ? 1 : 30); active--; return { messageId: 'x' }; } }), 60_000, { concurrency: opt });
      try { await waitFor(() => storage.getOutboxHealth().sent === (opt === 0 ? 20 : 150) || (opt === 0 && maxActive >= 1 && storage.getOutboxHealth().sent >= 20), 5000, 'progress'); }
      finally { await d.stop(); }
      assert.equal(maxActive, expectMax, `concurrency ${opt} must clamp to ${expectMax}`);
    }
  });

  await scenario('one recipient stays serial: its 3 messages never overlap and keep order', async () => {
    const storage = newStorage();
    for (let i = 0; i < 3; i++) { storage.enqueueOutboxMessage({ kind: 'text', to: phone(300), text: `s${i}` }); await sleep(2); }
    for (let i = 0; i < 5; i++) storage.enqueueOutboxMessage({ kind: 'text', to: phone(310 + i), text: 'other' });
    let active = 0; let overlap = false; const order = [];
    const d = startOutboxDispatcher(storage, () => ({ async sendMessage(to, text) { if (to === phone(300)) { if (active) overlap = true; active++; await sleep(30); active--; order.push(text); } return { messageId: 'x' }; } }), 60_000, { concurrency: 20 });
    try { await waitFor(() => storage.getOutboxHealth().sent === 8, 3000, 'all sent'); } finally { await d.stop(); }
    assert.equal(overlap, false); assert.deepEqual(order, ['s0', 's1', 's2']);
  });

  await scenario('direct-send claim vs dispatcher: a message claimed by the direct path is NOT sent by the dispatcher', async () => {
    const storage = newStorage();
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: phone(400), text: 'direct' });
    assert.ok(storage.claimOutboxMessage(m.id), 'direct path claims first');
    const sent = [];
    const d = startOutboxDispatcher(storage, () => ({ async sendMessage(to, t) { sent.push(t); return { messageId: 'x' }; } }), 60_000);
    try { await sleep(250); assert.deepEqual(sent, []); assert.equal(storage.claimOutboxMessage(m.id), null, 'and nobody can claim it twice'); } finally { await d.stop(); }
  });

  await scenario('wake-up: a message enqueued AFTER the first cycle is sent promptly, not after the 60s poll', async () => {
    const storage = newStorage(); const sent = [];
    const d = startOutboxDispatcher(storage, () => ({ async sendMessage(to, t) { sent.push(t); return { messageId: 'x' }; } }), 60_000);
    try {
      await sleep(100); // first (empty) cycle is over
      storage.enqueueOutboxMessage({ kind: 'text', to: phone(500), text: 'late' });
      const took = await waitFor(() => sent.includes('late'), 1500, 'wake-up delivery');
      assert.ok(took < 500, `took ${took}ms`);
    } finally { await d.stop(); }
  });

  await scenario('retry becomes due: dispatcher sleeps exactly until nextAttemptAt (no 60s poll wait, no spin)', async () => {
    const storage = newStorage(); const sent = [];
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: phone(510), text: 'retry me' });
    storage.claimOutboxMessage(m.id);
    let pendingCalls = 0; const realPending = storage.getPendingOutboxMessages.bind(storage);
    storage.getPendingOutboxMessages = (...a) => { pendingCalls++; return realPending(...a); };
    const d = startOutboxDispatcher(storage, () => ({ async sendMessage(to, t) { sent.push(t); return { messageId: 'x' }; } }), 60_000);
    try {
      await sleep(60);
      storage.markOutboxRetry(m.id, 'later', new Date(Date.now() + 300).toISOString());
      const t0 = Date.now();
      await waitFor(() => sent.includes('retry me'), 2000, 'sent when due');
      const took = Date.now() - t0;
      assert.ok(took >= 250 && took < 900, `took ${took}ms`);
      assert.ok(pendingCalls <= 8, `no polling spin while waiting (${pendingCalls} queries)`);
    } finally { await d.stop(); }
  });

  await scenario('everything held: no busy loop (query count stays tiny) and nothing is sent or attempted', async () => {
    const storage = newStorage();
    const ms = [];
    for (let i = 0; i < 25; i++) { const jid = `whatsapp:${phone(600 + i)}`; conversationState.set(jid, { kind: 'needs_review', senderJid: jid, senderPhone: phone(600 + i), reason: 't', timestamp: Date.now() }); ms.push(storage.enqueueOutboxMessage({ kind: 'text', to: jid, text: 'held' })); }
    let queries = 0; const real = storage.getPendingOutboxMessages.bind(storage);
    storage.getPendingOutboxMessages = (...a) => { queries++; return real(...a); };
    const sent = [];
    const d = startOutboxDispatcher(storage, () => ({ async sendMessage(to) { sent.push(to); return {}; } }), 60_000);
    try {
      await sleep(600);
      assert.deepEqual(sent, []); assert.ok(queries <= 5, `${queries} queries in 600ms`);
      for (const m of ms) assert.equal(storage.getOutboxMessage(m.id).attempts, 0);
    } finally { await d.stop(); for (let i = 0; i < 25; i++) conversationState.remove(`whatsapp:${phone(600 + i)}`); }
  });

  await scenario('shutdown: stop() stops taking work and waits only a bounded time for a hung send', async () => {
    const storage = newStorage();
    const a = storage.enqueueOutboxMessage({ kind: 'text', to: phone(700), text: 'hung' });
    await sleep(2);
    const b = storage.enqueueOutboxMessage({ kind: 'text', to: phone(701), text: 'after stop' });
    const gate = deferred(); const sent = [];
    const d = startOutboxDispatcher(storage, () => ({ async sendMessage(to, t) { sent.push(t); if (t === 'hung') await gate.promise; return {}; } }), 60_000, { concurrency: 1, shutdownWaitMs: 150 });
    await waitFor(() => sent.includes('hung'), 1000, 'hung started');
    const t0 = Date.now(); await d.stop(); const took = Date.now() - t0;
    assert.ok(took >= 100 && took < 600, `stop() returned after ${took}ms`);
    gate.resolve(); await sleep(150);
    assert.ok(!sent.includes('after stop'), 'no new work after stop()');
    assert.equal(storage.getOutboxMessage(b.id).status, 'queued');
  });

  let failed = 0;
  for (const [name, status, err] of results) { if (status === 'FAIL') failed++; console.log(`${status}  ${name}${err ? '\n      ' + err : ''}`); }
  console.log(`\npool: ${results.length - failed} passed, ${failed} failed`);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
