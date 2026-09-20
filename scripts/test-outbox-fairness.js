/**
 * Stage B / 6.1 - Outbox fairness: held (needs_review) recipients must be filtered
 * BEFORE the batch limit, so N held head-of-queue messages cannot starve eligible
 * recipients behind them.
 *
 * Every scenario runs ONE dispatcher cycle (poll interval 60s, so only the initial
 * tick counts). On HEAD 0ea8d26 the held filter ran after LIMIT: with >= 20 older
 * held recipients the first batch is all held, nothing is sent and the dispatcher
 * breaks - the eligible messages wait for the next 15s poll. This test fails there.
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');

const tmpDirs = [];
function newStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-fairness-'));
  tmpDirs.push(dir);
  return new Storage(path.join(dir, 'storage.json'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await sleep(10); }
  throw new Error(`timed out (${ms}ms) waiting for: ${label}`);
}
function hold(phone) {
  const jid = `whatsapp:${phone}`;
  conversationState.set(jid, { kind: 'needs_review', senderJid: jid, senderPhone: phone, reason: 'fairness test', timestamp: Date.now() });
  return jid;
}
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', e.message]); }
}

async function heldThenEligible(heldCount) {
  const storage = newStorage();
  const heldMessages = [];
  for (let i = 0; i < heldCount; i++) {
    const phone = `97250${String(1000000 + i)}`;
    heldMessages.push(storage.enqueueOutboxMessage({ kind: 'text', to: hold(phone), text: `held ${i}` }));
    await sleep(1); // distinct createdAt: the held messages are OLDER than the eligible ones
  }
  const eligible = [];
  for (let i = 0; i < 5; i++) eligible.push(storage.enqueueOutboxMessage({ kind: 'text', to: `whatsapp:97252${String(2000000 + i)}`, text: `ok ${i}` }));
  const sent = [];
  const dispatcher = startOutboxDispatcher(storage, () => ({
    async sendMessage(to, text) { sent.push(to); return { messageId: `m-${sent.length}` }; },
  }), 60_000);
  try {
    await waitFor(() => sent.length >= 5, 1500, `${heldCount} held + 5 eligible: eligible must be sent in the first cycle`);
    await sleep(100);
    assert.equal(sent.length, 5, 'only the eligible recipients may be sent');
    for (const m of heldMessages) {
      const now = storage.getOutboxMessage(m.id);
      assert.equal(now.status, 'queued', 'held message must stay queued');
      assert.equal(now.attempts, 0, 'held message must not consume an attempt');
    }
    for (const m of eligible) assert.equal(storage.getOutboxMessage(m.id).status, 'sent');
  } finally {
    await dispatcher.stop();
    for (let i = 0; i < heldCount; i++) conversationState.remove(`whatsapp:97250${String(1000000 + i)}`);
  }
}

(async () => {
  for (const n of [0, 1, 20, 100]) await scenario(`${n} held head-of-queue messages before 5 eligible: eligible sent in the same cycle, held untouched`, () => heldThenEligible(n));

  await scenario('storage query: blocked recipients filtered BEFORE limit', async () => {
    const storage = newStorage();
    for (let i = 0; i < 30; i++) { storage.enqueueOutboxMessage({ kind: 'text', to: `97260${1000 + i}`, text: 'b' }); await sleep(1); }
    for (let i = 0; i < 3; i++) storage.enqueueOutboxMessage({ kind: 'text', to: `97261${1000 + i}`, text: 'f' });
    const batch = storage.getPendingOutboxMessages(20, new Date(), undefined, (to) => to.startsWith('97260'));
    assert.deepEqual(batch.map((m) => m.to).sort(), ['972611000', '972611001', '972611002']);
  });

  await scenario('a blocked head is not skipped to send a later message of the same recipient', async () => {
    const storage = newStorage();
    storage.enqueueOutboxMessage({ kind: 'text', to: '972620001', text: 'first (blocked)' });
    await sleep(2);
    storage.enqueueOutboxMessage({ kind: 'text', to: '972620001', text: 'second' });
    assert.deepEqual(storage.getPendingOutboxMessages(20, new Date(), undefined, () => true), []);
    const open = storage.getPendingOutboxMessages(20);
    assert.equal(open.length, 1);
    assert.equal(open[0].text, 'first (blocked)');
  });

  await scenario('a head in retry (not yet due) is not bypassed by the recipient\'s next message', async () => {
    const storage = newStorage();
    const first = storage.enqueueOutboxMessage({ kind: 'text', to: '972630001', text: 'first' });
    await sleep(2);
    storage.enqueueOutboxMessage({ kind: 'text', to: '972630001', text: 'second' });
    storage.claimOutboxMessage(first.id);
    storage.markOutboxRetry(first.id, 'temporary', new Date(Date.now() + 60_000).toISOString());
    assert.deepEqual(storage.getPendingOutboxMessages(20), []);
  });

  await scenario('hold placed after selection: a claim-time re-check leaves the message queued with no attempt consumed', async () => {
    const storage = newStorage();
    const phone = '972503000001';
    const jid = `whatsapp:${phone}`;
    // `other` is OLDER, so with concurrency 1 it is in flight (gated) while the hold is placed on `m`.
    const other = storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972503000002', text: 'other' });
    await sleep(2);
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: jid, text: 'x' });
    const sent = [];
    let releaseFirstSend;
    const gate = new Promise((r) => { releaseFirstSend = r; });
    const dispatcher = startOutboxDispatcher(storage, () => ({
      async sendMessage(to, text) { sent.push(to); if (to.endsWith('2')) await gate; return { messageId: 'm' }; },
    }), 60_000, { concurrency: 1 });
    try {
      await waitFor(() => sent.length >= 1, 1000, 'first send started');
      hold(phone);
      releaseFirstSend();
      await sleep(200);
      assert.ok(!sent.includes(jid), 'a recipient held before its claim must not be sent');
      assert.equal(storage.getOutboxMessage(m.id).attempts, 0);
      assert.equal(storage.getOutboxMessage(m.id).status, 'queued');
      assert.equal(storage.getOutboxMessage(other.id).status, 'sent');
    } finally {
      await dispatcher.stop();
      conversationState.remove(jid);
    }
  });

  let failed = 0;
  for (const [name, status, err] of results) { if (status === 'FAIL') failed++; console.log(`${status}  ${name}${err ? '\n      ' + err : ''}`); }
  console.log(`\nfairness: ${results.length - failed} passed, ${failed} failed`);
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
