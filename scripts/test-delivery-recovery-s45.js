/**
 * Stage B2 / steps 4 and 5: participant-started safe recovery (fresh trigger), no continuation for an undelivered message,
 * exhausted state is neither success nor blocking; retry membership check, duplicate copies of one question, provider ids.
 */
process.env.NODE_ENV = 'test';
process.env.META_ATTEMPT_CALLBACK_DATA = 'on';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.OUTBOX_RECOVERY_WINDOW_MS = '1000';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config } = require('../dist/config');
const { Storage, emptyStorageData, recoveryWindowMs } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { startDeliveryRecovery, deliveryRecoveryBus } = require('../dist/deliveryRecovery');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');

const dirs = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(15); } throw new Error(`timed out (${ms}ms): ${label}`); }
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 3).join(' | ')]); } }
const timeoutError = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };
const digits = (v) => String(v).replace(/\D/g, '');
let evN = 0;
function evidence(st, id) { const row = st.getOutboxMessage(id); return st.applyMetaStatus({ wamid: `wamid.P${++evN}`, status: 'delivered', recipientId: digits(row.to), attemptId: row.attemptId }); }
const transportOf = (log) => ({
  log, failText: 0, failButtons: 0,
  async resolvePhone(j) { return String(j).replace(/\D/g, ''); },
  async sendMessage(to, text) { log.push(['text', text]); if (this.failText > 0) { this.failText--; throw timeoutError(); } return { messageId: 'w' + log.length }; },
  async sendInteractiveButtons(to, text) { log.push(['buttons', text]); if (this.failButtons > 0) { this.failButtons--; throw timeoutError(); } return { messageId: 'w' + log.length }; },
});
const count = (log, kind, text) => log.filter((x) => x[0] === kind && (text === undefined || x[1] === text)).length;
let mid = 0;
const inbound = (st, tr, phone, body, isButtonReply = false, source = 'webhook') => handleIncomingWhatsAppMessage({ id: `pth-${++mid}`, from: `whatsapp:${phone}`, senderPhone: phone, body, hasUserSignal: true, isButtonReply, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'U'; } }, st, tr, source);
function flowStorage(decisionFlow, trigger, extra = {}) {
  const st = new Storage(path.join(mk('paths-'), 's.json'));
  const campaign = st.addCampaign({ name: trigger, triggerType: 1, triggerPhrase: trigger, suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow, ...extra } });
  return { st, campaign };
}


const FLOW = [
  { id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick', options: [{ id: 'a', text: 'A', endText: 'Great choice', nextStepId: 'done' }, { id: 'b', text: 'B', nextStepId: 'done' }] },
  { id: 'done', kind: 'message', text: 'Thanks, done' },
];
const bailInbound = (st, tr, phone, body, isButtonReply = false) => inbound(st, tr, phone, body, isButtonReply, 'webhook');

(async () => {
  await scenario('S4-1 a FRESH TRIGGER during a recovery hold starts a new run without an admin: the unresolved message is abandoned (recoverable_failed, never success), old continuation skipped, late evidence does not revive it', async () => {
    const { st } = flowStorage(FLOW, 's41-join');
    const log = []; const tr = transportOf(log); const phone = '972504100001'; const jid = `whatsapp:${phone}`;
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      tr.failButtons = 1;
      await assert.rejects(() => bailInbound(st, tr, phone, 's41-join'));
      const row = st.getUncertainOutboxMessages()[0];
      assert.equal(conversationState.getNeedsReview(jid).recovery.outboxId, row.id);
      await sleep(30);
      await bailInbound(st, tr, phone, 's41-join');           // the participant tries again - no admin involved
      assert.equal(conversationState.getNeedsReview(jid), undefined, 'the recovery hold is gone');
      assert.equal(conversationState.get(jid)?.kind, 'decision', 'a new run is waiting for the answer');
      assert.equal(count(log, 'buttons', 'Pick'), 2, 'one failed copy + the new run question');
      const old = st.getOutboxMessage(row.id);
      assert.equal(old.status, 'recoverable_failed'); assert.notEqual(old.status, 'sent');
      assert.equal(st.getUnitContinuation(row.id).state, 'skipped');
      evidence(st, row.id);                                     // late proof for the ABANDONED message
      await sleep(500);
      assert.equal(st.getOutboxMessage(row.id).status, 'recoverable_failed', 'late evidence does not revive it');
      assert.equal(count(log, 'buttons', 'Pick'), 2, 'nothing is sent for the abandoned message');
      assert.equal(conversationState.get(jid)?.kind, 'decision');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('S4-2 an ADMIN hold (no recovery) is never superseded by a trigger; a non-trigger message during a recovery hold is held, not superseded', async () => {
    const { st } = flowStorage(FLOW, 's42-join');
    const log = []; const tr = transportOf(log); const phone = '972504100002'; const jid = `whatsapp:${phone}`;
    conversationState.set(jid, { kind: 'needs_review', senderJid: jid, senderPhone: phone, reason: 'admin decided', timestamp: Date.now() });
    await assert.rejects(() => bailInbound(st, tr, phone, 's42-join'), /held/i);
    assert.equal(conversationState.getNeedsReview(jid).reason, 'admin decided');
    assert.equal(count(log, 'buttons'), 0, 'no run was started behind the admin');
    conversationState.removeByPhone(phone);
    const phone2 = '972504100003'; const jid2 = `whatsapp:${phone2}`;
    tr.failButtons = 1;
    await assert.rejects(() => bailInbound(st, tr, phone2, 's42-join'));
    const row = st.getUncertainOutboxMessages()[0];
    await assert.rejects(() => bailInbound(st, tr, phone2, 'hello?'), /held/i);
    assert.equal(conversationState.getNeedsReview(jid2).recovery.outboxId, row.id, 'still held on the message');
    assert.equal(st.getOutboxMessage(row.id).status, 'uncertain');
    conversationState.removeByPhone(phone2);
  });

  await scenario('S4-3 supersede is refused while the message is being sent or its continuation is running (the hold stays)', async () => {
    const st = new Storage(path.join(mk('s43-'), 's.json'));
    const m = st.enqueueOutboxMessage({ kind: 'text', to: '972504100004', text: 'x', flowRef: { unitId: 'fu_s43', index: 1 }, continuation: { descriptor: { kind: 'reply_chain', senderJid: 'whatsapp:972504100004' }, state: 'pending' } });
    st.claimOutboxMessage(m.id);                                                      // processing (a POST in flight)
    assert.equal(st.supersedeRecoveryOutbox(m.id, 't'), false);
    st.markOutboxUncertain(m.id, 'timeout');
    st.claimContinuation(m.id);                                                       // running
    assert.equal(st.supersedeRecoveryOutbox(m.id, 't'), false);
    st.finishContinuation(m.id, 'skipped');
    assert.equal(st.supersedeRecoveryOutbox(m.id, 't'), true); assert.equal(st.getOutboxMessage(m.id).status, 'recoverable_failed');
  });

  await scenario('S4-4 budget exhausted: recoverable_failed is NOT success, does not block the recipient, and NO continuation depends on the undelivered message', async () => {
    const { st } = flowStorage(FLOW, 's44-join');
    const log = []; const phone = '972504100005'; const jid = `whatsapp:${phone}`;
    const tr = transportOf(log);
    const dead = { ...tr, async sendInteractiveButtons(to, text) { log.push(['buttons', text]); throw timeoutError(); } };
    const rec = startDeliveryRecovery(st, () => tr);
    let disp;
    try {
      await assert.rejects(() => bailInbound(st, dead, phone, 's44-join'));
      disp = startOutboxDispatcher(st, () => dead, 150);
      const id = st.getUncertainOutboxMessages()[0].id;
      await waitFor(() => st.getOutboxMessage(id).status === 'recoverable_failed', 15000, 'exhausted');
      assert.equal(st.getOutboxMessage(id).attemptLog.length, 2, 'exactly the 2-POST budget');
      assert.notEqual(st.getOutboxMessage(id).status, 'sent');
      assert.equal(st.hasOutstandingOutboxForRecipient(phone), false, 'the recipient queue head is not blocked');
      await waitFor(() => !conversationState.getNeedsReview(jid), 5000, 'hold released');
      assert.equal(count(log, 'text', 'Great choice') + count(log, 'text', 'Thanks, done'), 0, 'nothing that depends on the undelivered question ran');
      assert.equal(st.getUnitContinuation(id).state, 'skipped');
      await bailInbound(st, tr, phone, 's44-join');             // the participant can simply start again
      assert.equal(conversationState.get(jid)?.kind, 'decision');
    } finally { if (disp) await disp.stop(); await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('S5-1 a granted RETRY is not sent when the participant has moved on to a newer run (membership check); the message ends recoverable_failed, continuation skipped', async () => {
    const { st } = flowStorage(FLOW, 's51-join');
    const log = []; const phone = '972504100006'; const jid = `whatsapp:${phone}`;
    const tr = transportOf(log);
    let disp;
    try {
      tr.failButtons = 1;
      await assert.rejects(() => bailInbound(st, tr, phone, 's51-join'));
      const row = st.getUncertainOutboxMessages()[0];
      conversationState.removeByPhone(phone);                   // the hold is lifted some other way (e.g. an admin) ...
      await sleep(30);
      await bailInbound(st, tr, phone, 's51-join');             // ... and the participant is now in a NEWER run
      disp = startOutboxDispatcher(st, () => tr, 150);
      await waitFor(() => st.getOutboxMessage(row.id).status === 'recoverable_failed', 8000, 'old message not retried');
      await sleep(600);
      const oldRow = st.getOutboxMessage(row.id);
      assert.equal(oldRow.attemptLog.length, 1, 'the old message was never POSTed again (the only attempt is the original unknown one)');
      assert.equal(oldRow.status, 'recoverable_failed'); assert.notEqual(oldRow.status, 'sent');
      assert.equal(st.getUnitContinuation(row.id).state, 'skipped');
      assert.equal(conversationState.getNeedsReview(jid), undefined, 'no hold is left behind');
    } finally { if (disp) await disp.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('S5-2 two physical copies of one question (retry after an unknown outcome): answering BOTH copies advances the flow once, one result, no double next step', async () => {
    const { st, campaign } = flowStorage(FLOW, 's52-join');
    const log = []; const phone = '972504100007'; const jid = `whatsapp:${phone}`;
    const tr = transportOf(log);
    const rec = startDeliveryRecovery(st, () => tr);
    let disp;
    try {
      tr.failButtons = 1;                                       // copy 1: arrives at the phone but the response is lost
      await assert.rejects(() => bailInbound(st, tr, phone, 's52-join'));
      disp = startOutboxDispatcher(st, () => tr, 150);
      await waitFor(() => count(log, 'buttons', 'Pick') === 2, 12000, 'retry sent a second copy');   // copy 2
      await waitFor(() => conversationState.get(jid)?.kind === 'decision', 5000, 'run continues');
      await bailInbound(st, tr, phone, 'a', true);              // answer to copy 1
      await bailInbound(st, tr, phone, 'a', true);              // answer to copy 2 (another provider message id)
      await sleep(400);
      assert.equal(count(log, 'text', 'Thanks, done'), 1, 'the next step is sent once');
      assert.equal(count(log, 'text', 'Great choice'), 1, 'the end text is sent once');
      assert.equal(st.getCampaignResults().filter((r) => r.campaignId === campaign.id).length, 1, 'no split / second result');
      assert.equal(st.getCampaignEvents(campaign.id).filter((e) => e.type === 'step_answered').length, 1, 'the answer is counted once');
    } finally { if (disp) await disp.stop(); await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('S5-3 every provider id a message received is known: a late status for the EARLIER attempt id updates the row', async () => {
    const st = new Storage(path.join(mk('s53-'), 's.json'));
    const m = st.enqueueOutboxMessage({ kind: 'text', to: '972504100008', text: 'x' });
    const a1 = st.claimOutboxMessage(m.id).attemptId; st.markOutboxUncertain(m.id, 'timeout');
    st.advanceUncertainRecovery(new Date(Date.now() + recoveryWindowMs() + 50));
    st.claimOutboxMessage(m.id); st.markOutboxSent(m.id, 'wamid.SECOND');
    const r1 = st.applyMetaStatus({ wamid: 'wamid.FIRST', status: 'delivered', recipientId: '972504100008', attemptId: a1 });
    assert.ok(['applied', 'duplicate'].includes(r1.result), r1.result);
    const viaLegacy = st.recordOutboxDelivery('wamid.FIRST', 'read');
    assert.ok(viaLegacy, 'the earlier id matches too'); assert.equal(st.getOutboxMessage(m.id).deliveryStatus, 'read');
    assert.equal(st.getOutboxMessage(m.id).status, 'sent');
    assert.ok(st.recordOutboxDelivery('wamid.SECOND', 'read'), 'and the latest id');
  });

  await scenario('S5-4 duplicate continuation suppression: evidence + a second resolution signal + rescans run the continuation ONCE', async () => {
    const { st } = flowStorage(FLOW, 's54-join');
    const log = []; const tr = transportOf(log); const phone = '972504100009'; const jid = `whatsapp:${phone}`;
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      tr.failButtons = 1;
      await assert.rejects(() => bailInbound(st, tr, phone, 's54-join'));
      const row = st.getUncertainOutboxMessages()[0];
      evidence(st, row.id); evidence(st, row.id); rec.kick(); rec.kick();
      await waitFor(() => conversationState.get(jid)?.kind === 'decision', 6000, 'continued');
      await sleep(500);
      assert.equal(count(log, 'buttons', 'Pick'), 1, 'the question was not sent again');
      assert.equal(st.getUnitContinuation(row.id).state, 'done');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log('recovery-s45: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
})();
