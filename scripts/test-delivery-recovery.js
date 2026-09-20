/**
 * Stage B2 / step 3 - delivery recovery state machine, hold and continuation.
 *
 *  S*  state machine in Storage: window, budget (2 POSTs), evidence, no reset on restart, no revival
 *  D*  with the real dispatcher: bounded automatic retry, own hold does not block own retry
 *  F*  with the real campaign engine: continuation runs once, only for the owner of the hold, replay skips
 *      delivered sends, stale runs are never revived, replay failure re-holds
 *  B*  Baileys-shaped transport (no callbacks): same machine, retry after the window, budget 2
 * Window is 1s (the minimum allowed) so the tests are quick; the production default is 60s.
 */
process.env.NODE_ENV = 'test';
process.env.META_ATTEMPT_CALLBACK_DATA = 'on';   // evidence is matched by our attempt id
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.OUTBOX_RECOVERY_WINDOW_MS = '1000';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage, recoveryWindowMs, recoveryPostBudget } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');
const { startDeliveryRecovery, deliveryRecoveryBus } = require('../dist/deliveryRecovery');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { ProviderSendError } = require('../dist/sendOutcome');

const dirs = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const newStorage = () => new Storage(path.join(mk('recov-'), 's.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(15); } throw new Error(`timed out (${ms}ms): ${label}`); }
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 3).join(' | ')]); } }
const timeoutError = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };
const digits = (v) => String(v).replace(/\D/g, '');
let evN = 0;
function evidence(storage, outboxId, status = 'delivered') {
  const row = storage.getOutboxMessage(outboxId);
  return storage.applyMetaStatus({ wamid: `wamid.EV${++evN}`, status, recipientId: digits(row.to), attemptId: row.attemptId });
}
function uncertainRow(storage, to, text = 'x') {
  const m = storage.enqueueOutboxMessage({ kind: 'text', to, text });
  storage.claimOutboxMessage(m.id); storage.markOutboxUncertain(m.id, 'timeout');
  return m.id;
}
const afterWindow = () => new Date(Date.now() + recoveryWindowMs() + 50);

(async () => {
  assert.equal(recoveryWindowMs(), 1000); assert.equal(recoveryPostBudget(), 2, 'default budget is 2 POSTs');

  // ============================================================== S: state machine
  await scenario('S1 window: nothing happens inside it; after it, no evidence => ONE bounded retry with the duplicate risk declared', async () => {
    const s = newStorage(); const id = uncertainRow(s, '972501000001');
    const row = s.getOutboxMessage(id);
    assert.ok(Date.parse(row.recovery.windowEndsAt) - Date.parse(row.recovery.uncertainSince) === recoveryWindowMs());
    assert.deepEqual(s.advanceUncertainRecovery(new Date()), [], 'inside the window: still waiting (the participant is waiting too)');
    assert.equal(s.getOutboxMessage(id).status, 'uncertain');
    assert.deepEqual(s.advanceUncertainRecovery(afterWindow()), [{ id, to: 'retry' }]);
    const after = s.getOutboxMessage(id);
    assert.equal(after.recovery.retriesGranted, 1); assert.equal(after.recovery.duplicateRiskDeclared, true);
    assert.match(after.lastError, /duplicate risk declared/);
    assert.equal(after.attemptLog.length, 1, 'no new attempt until the dispatcher actually sends');
  });

  await scenario('S2 budget = 2 POSTs: second uncertain attempt + silent window => recoverable_failed (not success, not blocking)', async () => {
    const s = newStorage(); const to = '972501000002'; const id = uncertainRow(s, to);
    s.advanceUncertainRecovery(afterWindow());
    assert.equal(s.claimOutboxMessage(id).attempts, 2); s.markOutboxUncertain(id, 'timeout again');
    const row = s.getOutboxMessage(id);
    assert.notEqual(row.recovery.attemptId, row.attemptLog[0].attemptId, 'the second attempt gets its OWN window');
    assert.equal(row.recovery.retriesGranted, 1, 'the retry count is not reset');
    assert.deepEqual(s.advanceUncertainRecovery(afterWindow()), [{ id, to: 'recoverable_failed' }], 'a third POST would only make a third copy');
    const end = s.getOutboxMessage(id);
    assert.equal(end.status, 'recoverable_failed'); assert.notEqual(end.status, 'sent');
    assert.equal(s.hasOutstandingOutboxForRecipient(to), false, 'the recipient queue is NOT blocked any more');
    const next = s.enqueueOutboxMessage({ kind: 'text', to, text: 'next' });
    assert.ok(s.claimOutboxMessage(next.id), 'the next message to that recipient can be sent');
    assert.equal(s.getOutboxHealth().recoverable_failed, 1);
  });

  await scenario('S3 evidence (delivered/sent/read) inside the window resolves the message as SENT - no retry, ever', async () => {
    for (const status of ['sent', 'delivered', 'read']) {
      const s = newStorage(); const id = uncertainRow(s, '972501000003'); const events = [];
      s.onOutboxTransition((e) => events.push(e.type));
      assert.equal(evidence(s, id, status).result, 'applied');
      const row = s.getOutboxMessage(id);
      assert.equal(row.status, 'sent'); assert.ok(row.providerMessageId); assert.equal(row.attemptLog[0].status, 'accepted');
      assert.deepEqual(s.advanceUncertainRecovery(afterWindow()), [], 'nothing left to retry');
      await sleep(20); assert.deepEqual(events, ['sent_after_recovery']);
    }
  });

  await scenario('S4 evidence that the attempt FAILED => immediate retry, does not count as a possibly-delivered POST, no duplicate risk declared', async () => {
    const s = newStorage(); const id = uncertainRow(s, '972501000004');
    assert.equal(evidence(s, id, 'failed').result, 'applied');
    const row = s.getOutboxMessage(id);
    assert.equal(row.status, 'retry'); assert.equal(row.attemptLog[0].status, 'rejected'); assert.ok(!row.recovery.duplicateRiskDeclared);
  });

  await scenario('S5 late evidence AFTER recoverable_failed is recorded but never revives the message or its run', async () => {
    const s = newStorage(); const id = uncertainRow(s, '972501000005'); const events = [];
    s.advanceUncertainRecovery(afterWindow()); s.claimOutboxMessage(id); s.markOutboxUncertain(id, 't'); s.advanceUncertainRecovery(afterWindow());
    s.onOutboxTransition((e) => events.push(e.type));
    const first = s.getOutboxMessage(id).attemptLog[0];
    const out = s.applyMetaStatus({ wamid: 'wamid.LATE', status: 'delivered', recipientId: '972501000005', attemptId: first.attemptId });
    assert.equal(out.result, 'applied');
    assert.equal(s.getOutboxMessage(id).status, 'recoverable_failed', 'still terminal, still not success');
    await sleep(20); assert.deepEqual(events, ['late_evidence']);
  });

  await scenario('S6 evidence of the FIRST attempt arrives while the retry is granted-but-unsent: the retry is cancelled (message becomes sent, no second POST)', async () => {
    const s = newStorage(); const id = uncertainRow(s, '972501000006'); s.advanceUncertainRecovery(afterWindow());
    assert.equal(s.getOutboxMessage(id).status, 'retry');
    const first = s.getOutboxMessage(id).attemptLog[0];
    s.applyMetaStatus({ wamid: 'wamid.FIRST', status: 'delivered', recipientId: '972501000006', attemptId: first.attemptId });
    assert.equal(s.getOutboxMessage(id).status, 'sent');
    assert.equal(s.claimOutboxMessage(id), null, 'nothing left to send');
  });

  await scenario('S7 restart does NOT reset the window or the retry budget (window belongs to the attempt; orphan detected once)', async () => {
    const file = path.join(mk('recov-r-'), 's.json'); const s1 = new Storage(file);
    const m = s1.enqueueOutboxMessage({ kind: 'text', to: '972501000007', text: 'x' }); s1.claimOutboxMessage(m.id); await s1.flush();   // crash while processing
    const s2 = new Storage(file); s2.recoverOrphanedOutboxProcessing(); await s2.flush();
    const w1 = s2.getOutboxMessage(m.id).recovery.windowEndsAt;
    await sleep(300);
    const s3 = new Storage(file); s3.recoverOrphanedOutboxProcessing(); s3.markOutboxUncertain; // a second restart re-runs orphan recovery: nothing is processing any more
    assert.equal(s3.getOutboxMessage(m.id).recovery.windowEndsAt, w1, 'second restart: same window');
    s3.advanceUncertainRecovery(afterWindow()); await s3.flush();
    const s4 = new Storage(file);
    assert.equal(s4.getOutboxMessage(m.id).recovery.retriesGranted, 1);
    assert.equal(s4.getOutboxMessage(m.id).status, 'retry');
    assert.deepEqual(s4.advanceUncertainRecovery(afterWindow()), [], 'a granted retry is not granted twice by a restart');
  });

  await scenario('S7b marking the SAME attempt uncertain again never restarts its window (only a NEW attempt gets a new one)', async () => {
    const s = newStorage(); const id = uncertainRow(s, '972501000015');
    const w = s.getOutboxMessage(id).recovery.windowEndsAt; await sleep(120);
    s.markOutboxUncertain(id, 'seen again');
    assert.equal(s.getOutboxMessage(id).recovery.windowEndsAt, w);
  });

  // ============================================================== D: dispatcher
  await scenario('D1 dispatcher: timeout -> window -> ONE automatic retry -> timeout -> window -> recoverable_failed; exactly 2 POSTs; the next message then flows', async () => {
    const s = newStorage(); const to = '972501000010'; const posts = [];
    const m1 = s.enqueueOutboxMessage({ kind: 'text', to, text: 'first' }); await sleep(2);
    const m2 = s.enqueueOutboxMessage({ kind: 'text', to, text: 'second' });
    const d = startOutboxDispatcher(s, () => ({ async sendMessage(t, text) { posts.push(text); if (text === 'first') throw timeoutError(); return { messageId: 'w' + posts.length }; } }), 200);
    try {
      await waitFor(() => s.getOutboxMessage(m1.id).status === 'uncertain', 3000, 'first uncertain');
      assert.equal(posts.filter((t) => t === 'first').length, 1);
      assert.equal(s.getOutboxMessage(m2.id).status, 'queued', 'dependent message waits while the outcome is unknown');
      await waitFor(() => s.getOutboxMessage(m1.id).status === 'recoverable_failed', 8000, 'recoverable_failed');
      assert.equal(posts.filter((t) => t === 'first').length, 2, 'exactly the original + one retry');
      await waitFor(() => s.getOutboxMessage(m2.id).status === 'sent', 3000, 'the queue is not blocked after recoverable_failed');
      assert.equal(s.getOutboxMessage(m1.id).recovery.duplicateRiskDeclared, true);
    } finally { await d.stop(); }
  });

  await scenario('D2 dispatcher: evidence inside the window => NO retry, one POST', async () => {
    const s = newStorage(); const posts = []; const m = s.enqueueOutboxMessage({ kind: 'text', to: '972501000011', text: 'once' });
    const d = startOutboxDispatcher(s, () => ({ async sendMessage(t, text) { posts.push(text); throw timeoutError(); } }), 200);
    try {
      await waitFor(() => s.getOutboxMessage(m.id).status === 'uncertain', 3000, 'uncertain');
      evidence(s, m.id, 'delivered');
      await sleep(1600);
      assert.equal(posts.length, 1); assert.equal(s.getOutboxMessage(m.id).status, 'sent');
    } finally { await d.stop(); }
  });

  await scenario('D3 hold interplay: the recovery hold of THIS message does not block its retry; any other needs_review hold still does', async () => {
    for (const own of [true, false]) {
      const s = newStorage(); const to = own ? '972501000012' : '972501000013'; const jid = `whatsapp:${to}`; const posts = [];
      const m = s.enqueueOutboxMessage({ kind: 'text', to: jid, text: 'held' });
      s.claimOutboxMessage(m.id); s.markOutboxUncertain(m.id, 't'); s.advanceUncertainRecovery(afterWindow());   // retry granted
      conversationState.set(jid, { kind: 'needs_review', senderJid: jid, senderPhone: to, reason: 't', timestamp: Date.now(), ...(own ? { recovery: { outboxId: m.id } } : {}) });
      const d = startOutboxDispatcher(s, () => ({ async sendMessage(t, text) { posts.push(text); return { messageId: 'w' }; } }), 200);
      try {
        await sleep(700);
        assert.equal(posts.length, own ? 1 : 0, own ? 'own recovery hold must not stop the retry' : 'an admin hold must still block automatic sends');
      } finally { await d.stop(); conversationState.remove(jid); }
    }
  });

  // ============================================================== F: real campaign engine
  function makeFlowStorage(name, trigger, conversation) {
    const st = newStorage();
    const uploaded = st.addUploadedFile({ originalName: 'intro.jpg', filename: 'intro.jpg', mimeType: 'image/jpeg', size: 1 });
    const campaign = st.addCampaign({ name, triggerType: 1, triggerPhrase: trigger, suffix: '', active: true, conversation: {
      askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [],
      decisionFlow: [
        { id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick one', fileId: uploaded.id, options: [{ id: 'a', text: 'A', nextStepId: 'done' }, { id: 'b', text: 'B', nextStepId: 'done' }] },
        { id: 'done', kind: 'message', text: 'Thanks, done' },
      ], ...conversation } });
    return { st, campaign };
  }
  function makeTransport(log, opts = {}) {
    return {
      log, failButtons: 0, failText: 0,
      async resolvePhone(j) { return String(j).replace(/\D/g, ''); },
      async sendMessage(to, text) { log.push(['text', text]); if (this.failText > 0) { this.failText--; throw timeoutError(); } return { messageId: 'w' + log.length }; },
      async sendFile(to, f, cap) { log.push(['file', cap || '']); return { messageId: 'w' + log.length }; },
      async sendInteractiveButtons(to, text) { log.push(['buttons', text]); if (this.failButtons > 0) { this.failButtons--; throw timeoutError(); } return { messageId: 'w' + log.length }; },
    };
  }
  let mid = 0;
  const inbound = (st, tr, phone, body, isButtonReply = false) => handleIncomingWhatsAppMessage({ id: `rec-${++mid}`, from: `whatsapp:${phone}`, body, hasUserSignal: true, isButtonReply, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'U'; } }, st, tr, 'webhook');
  const count = (log, kind) => log.filter((x) => x[0] === kind).length;

  await scenario('F1 uncertain question + EVIDENCE: own hold released, the step is replayed WITHOUT re-sending what was delivered, pending restored ONCE, participant continues', async () => {
    const { st } = makeFlowStorage('F1', 'f1-join'); const log = []; const tr = makeTransport(log); tr.failButtons = 1;
    const phone = '972502000001'; const jid = `whatsapp:${phone}`;
    const released = []; const onRel = (e) => released.push(e); deliveryRecoveryBus.on('released', onRel);
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      await assert.rejects(() => inbound(st, tr, phone, 'f1-join'));
      const hold = conversationState.getNeedsReview(jid);
      const row = st.getUncertainOutboxMessages()[0];
      assert.equal(hold.recovery.outboxId, row.id, 'the hold is tied to that message');
      const cont = st.getUnitContinuation(row.id); assert.equal(cont.state, 'pending'); assert.equal(cont.descriptor.kind, 'decision_step'); assert.equal(cont.descriptor.stepId, 'q1');
      assert.equal(row.continuation, undefined, 'the descriptor lives on the FIRST row of the unit (the file), not on this one: rows stay small');
      assert.equal(count(log, 'file'), 1); assert.equal(count(log, 'buttons'), 1);
      // a message from the participant while the delivery is unresolved is held, not processed
      await assert.rejects(() => inbound(st, tr, phone, 'hello?'));
      evidence(st, row.id, 'delivered');
      await waitFor(() => conversationState.get(jid)?.kind === 'decision', 4000, 'pending decision restored');
      assert.equal(conversationState.getNeedsReview(jid), undefined, 'hold released');
      assert.equal(count(log, 'file'), 1, 'the delivered file is NOT sent again');
      assert.equal(count(log, 'buttons'), 1, 'the (delivered) question is NOT sent again');
      await waitFor(() => released.length === 1, 2000, 'release event'); assert.equal(released[0].heldMessages.length, 1, 'the held inbound message is handed back');
      // the participant can now answer and the flow moves on
      await inbound(st, tr, phone, 'a', true);
      assert.ok(log.some((x) => x[0] === 'text' && x[1] === 'Thanks, done'), 'flow continued to the next step');
      // running the recovery again does not run the continuation a second time
      rec.kick(); rec.kick(); await sleep(300);
      assert.equal(st.getUnitContinuation(row.id).state, 'done');
      assert.equal(count(log, 'buttons'), 1);
    } finally { await rec.stop(); deliveryRecoveryBus.off('released', onRel); conversationState.removeByPhone(phone); }
  });

  await scenario('F2 uncertain question + NO evidence: window -> automatic retry -> delivered -> continuation once; 2 copies of the question are the declared duplicate risk', async () => {
    const { st } = makeFlowStorage('F2', 'f2-join'); const log = []; const tr = makeTransport(log); tr.failButtons = 1;
    const phone = '972502000002'; const jid = `whatsapp:${phone}`;
    const rec = startDeliveryRecovery(st, () => tr); const d = startOutboxDispatcher(st, () => tr, 200);
    try {
      await assert.rejects(() => inbound(st, tr, phone, 'f2-join'));
      await waitFor(() => conversationState.get(jid)?.kind === 'decision', 8000, 'recovered after the window');
      assert.equal(count(log, 'buttons'), 2, 'original (unknown) + ONE retry');
      assert.equal(count(log, 'file'), 1);
      const row = st.getOutboxMessages(20).find((r) => r.kind === 'interactive_buttons');
      assert.equal(row.recovery.duplicateRiskDeclared, true);
      await inbound(st, tr, phone, 'b', true);
      assert.ok(log.some((x) => x[1] === 'Thanks, done'));
    } finally { await d.stop(); await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('F3 recoverable_failed: the own hold is released, NOTHING is sent or continued, held messages are handed back, later evidence revives nothing', async () => {
    const { st } = makeFlowStorage('F3', 'f3-join'); const log = []; const tr = makeTransport(log); tr.failButtons = 2;
    const phone = '972502000003'; const jid = `whatsapp:${phone}`; const released = []; const onRel = (e) => released.push(e); deliveryRecoveryBus.on('released', onRel);
    const rec = startDeliveryRecovery(st, () => tr); const d = startOutboxDispatcher(st, () => tr, 200);
    try {
      await assert.rejects(() => inbound(st, tr, phone, 'f3-join'));
      await waitFor(() => released.length === 1, 9000, 'released after budget exhausted');
      assert.equal(released[0].outcome, 'skipped');
      assert.equal(conversationState.getNeedsReview(jid), undefined, 'participant is no longer held');
      assert.equal(conversationState.get(jid), undefined, 'no pending decision was invented');
      assert.equal(count(log, 'buttons'), 2, 'budget: exactly 2 POSTs');
      const row = st.getOutboxMessages(20).find((r) => r.kind === 'interactive_buttons');
      assert.equal(row.status, 'recoverable_failed'); assert.equal(st.getUnitContinuation(row.id).state, 'skipped');
      // an old attempt's callback arrives late: recorded, nothing else
      const first = row.attemptLog[0];
      st.applyMetaStatus({ wamid: 'wamid.VERYLATE', status: 'delivered', recipientId: phone, attemptId: first.attemptId });
      await sleep(400);
      assert.equal(conversationState.get(jid), undefined, 'no revival'); assert.equal(count(log, 'buttons'), 2);
    } finally { await d.stop(); await rec.stop(); deliveryRecoveryBus.off('released', onRel); conversationState.removeByPhone(phone); }
  });

  await scenario('F4 the participant moved to ANOTHER run (old run superseded) when the evidence arrives: no revival, no new send from the old run', async () => {
    const { st } = makeFlowStorage('F4', 'f4-join'); const log = []; const tr = makeTransport(log); tr.failButtons = 1;
    const phone = '972502000004'; const jid = `whatsapp:${phone}`;
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      await assert.rejects(() => inbound(st, tr, phone, 'f4-join'));
      const row = st.getUncertainOutboxMessages()[0];
      // the participant is released from run A (admin) and its leftovers are superseded, then a NEW run B starts
      conversationState.remove(jid); st.cancelOutboxForRecipient(phone); await st.flush();
      await inbound(st, tr, phone, 'f4-join');
      const stateBefore = conversationState.get(jid); const sendsBefore = log.length;
      assert.equal(stateBefore.kind, 'decision');
      evidence(st, row.id, 'delivered');   // run A's first question turns out to have been delivered
      rec.kick(); await sleep(600);
      assert.equal(log.length, sendsBefore, 'nothing new was sent on behalf of the old run');
      assert.equal(conversationState.get(jid).campaignResultId, stateBefore.campaignResultId, 'the current run is untouched');
      assert.equal(st.getOutboxMessage(row.id).status, 'failed', 'the superseded message stays superseded');
      assert.notEqual(st.getUnitContinuation(row.id).state, 'done');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('F4b the participant already has a NEWER run (no hold of ours, row still unresolved): the old run is not revived when its evidence arrives', async () => {
    const { st, campaign } = makeFlowStorage('F4b', 'f4b-join'); const log = []; const tr = makeTransport(log); tr.failButtons = 1;
    const phone = '972502000014'; const jid = `whatsapp:${phone}`;
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      await assert.rejects(() => inbound(st, tr, phone, 'f4b-join'));
      const row = st.getUncertainOutboxMessages()[0];
      conversationState.remove(jid); await st.flush();                     // the hold is gone (admin)
      st.recordCampaignTrigger(campaign.id, phone, 'U');                   // ... and the participant now has a NEWER result (run B)
      const sendsBefore = log.length;
      evidence(st, row.id, 'delivered'); rec.kick(); await sleep(600);
      assert.equal(log.length, sendsBefore, 'the old run must not send anything');
      assert.equal(conversationState.get(jid), undefined, 'and must not re-arm a pending decision');
      assert.equal(st.getUnitContinuation(row.id).state, 'skipped');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('F5 an admin needs_review hold (no recovery tie) is NEVER released by delivery evidence - even when a continuation WOULD succeed', async () => {
    const { st, campaign } = makeFlowStorage('F5', 'f5-join'); const log = []; const tr = makeTransport(log);
    const phone = '972502000005'; const jid = `whatsapp:${phone}`;
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      // a message of a REAL step whose continuation could run successfully if it were (wrongly) allowed to
      const m = st.enqueueOutboxMessage({ kind: 'text', to: jid, text: 'x', continuation: { descriptor: { kind: 'decision_step', senderJid: jid, senderPhone: phone, stepId: 'q1', campaignId: campaign.id }, state: 'pending' }, flowRef: { unitId: 'fu_x', index: 1 } });
      st.claimOutboxMessage(m.id); st.markOutboxUncertain(m.id, 't');
      conversationState.set(jid, { kind: 'needs_review', senderJid: jid, senderPhone: phone, reason: 'admin decides', timestamp: Date.now() });
      evidence(st, m.id, 'delivered'); await sleep(600);
      assert.ok(conversationState.getNeedsReview(jid), 'the admin hold is still there');
      assert.equal(conversationState.getNeedsReview(jid).recovery, undefined);
      assert.equal(log.length, 0, 'nothing was sent on the participant behalf');
      assert.notEqual(st.getUnitContinuation(m.id).state, 'done');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('F6 the replay itself hits another unknown outcome: the participant is held AGAIN, tied to the NEW message; held inbound messages are kept', async () => {
    const { st } = makeFlowStorage('F6', 'f6-join'); const log = []; const tr = makeTransport(log);
    tr.sendFile = async function (to, f, cap) { log.push(['file', cap || '']); if (this.failFile > 0) { this.failFile--; throw timeoutError(); } return { messageId: 'w' + log.length }; };
    tr.failFile = 1; tr.failButtons = 1;   // the FILE is the unknown message; the replay then has to send the question, which also times out
    const phone = '972502000006'; const jid = `whatsapp:${phone}`; const released = []; const onRel = (e) => released.push(e); deliveryRecoveryBus.on('released', onRel);
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      await assert.rejects(() => inbound(st, tr, phone, 'f6-join'));
      await assert.rejects(() => inbound(st, tr, phone, 'anyone there?'));
      const fileRow = st.getUncertainOutboxMessages()[0];
      assert.equal(fileRow.kind, 'file');
      evidence(st, fileRow.id, 'delivered');   // the file WAS delivered
      await waitFor(() => st.getUncertainOutboxMessages().some((r) => r.kind === 'interactive_buttons'), 5000, 'replay sent the question and it became uncertain');
      const buttonsRow = st.getUncertainOutboxMessages().find((r) => r.kind === 'interactive_buttons');
      assert.equal(count(log, 'file'), 1, 'the delivered file was not re-sent by the replay');
      const hold = conversationState.getNeedsReview(jid);
      assert.equal(hold.recovery.outboxId, buttonsRow.id, 'held again, tied to the NEW unknown message');
      assert.equal(hold.heldMessages.length, 1, 'the participant message that was already waiting is kept');
      assert.equal(released.length, 0, 'nothing was released to the inbox yet');
      // and the chain resolves: evidence for the question => released, pending restored, held message handed back
      evidence(st, buttonsRow.id, 'delivered');
      await waitFor(() => released.length === 1, 5000, 'released at last');
      assert.equal(released[0].heldMessages.length, 1); assert.equal(conversationState.get(jid)?.kind, 'decision');
    } finally { await rec.stop(); deliveryRecoveryBus.off('released', onRel); conversationState.removeByPhone(phone); }
  });

  await scenario('F7 reply chain (text before the flow) uncertain + evidence: replayed WITHOUT a second contact-save job, the flow then starts once', async () => {
    const { st } = makeFlowStorage('F7', 'f7-join', { replyText: 'Welcome text' }); const log = []; const tr = makeTransport(log); tr.failText = 1;
    const phone = '972502000007'; const jid = `whatsapp:${phone}`;
    let contactSaves = 0; const origEnqueue = st.enqueueContactSave.bind(st); st.enqueueContactSave = (...a) => { contactSaves++; return origEnqueue(...a); };
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      await assert.rejects(() => inbound(st, tr, phone, 'f7-join'));
      const row = st.getUncertainOutboxMessages()[0];
      assert.equal(st.getUnitContinuation(row.id).descriptor.kind, 'reply_chain');
      assert.equal(contactSaves, 1, 'the contact-save job is created once, by the original run');
      evidence(st, row.id, 'delivered');
      await waitFor(() => conversationState.get(jid)?.kind === 'decision', 5000, 'flow started after the reply chain');
      assert.equal(count(log, 'text') >= 1, true);
      assert.equal(log.filter((x) => x[1] === 'Welcome text').length, 1, 'the welcome was not sent again');
      assert.equal(count(log, 'buttons'), 1, 'the first question is sent exactly once');
      assert.equal(st.getUnitContinuation(row.id).state, 'done');
      assert.equal(contactSaves, 1, 'the replay did not create the contact-save job a second time');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  // ============================================================== B: Baileys shape
  await scenario('B1 a transport with NO callbacks (Baileys): orphan after a crash => same machine, retry after the window, budget 2, then recoverable_failed', async () => {
    const file = path.join(mk('recov-b-'), 's.json'); const s1 = new Storage(file);
    const to = '972503000001'; const m = s1.enqueueOutboxMessage({ kind: 'text', to, text: 'baileys msg' }); s1.claimOutboxMessage(m.id); await s1.flush();   // process died mid-send
    const s2 = new Storage(file); const posts = [];
    // never any status callback, and every retry also "dies" mid-send (never resolves)
    const d = startOutboxDispatcher(s2, () => ({ async sendMessage(t, text) { posts.push(text); throw Object.assign(new Error('socket closed mid-write'), { name: 'TimeoutError' }); } }), 200);
    try {
      await waitFor(() => s2.getOutboxMessage(m.id).status === 'recoverable_failed', 9000, 'recoverable_failed');
      assert.equal(posts.length, 1, 'orphan (the crashed POST) + exactly one retry = 2 possibly-delivered copies');
      assert.equal(s2.getOutboxMessage(m.id).recovery.duplicateRiskDeclared, true);
    } finally { await d.stop(); }
  });

  await scenario('B2 Baileys-style errors are NOT uncertain: a closed socket / rejected send is a certain "not sent" and follows the normal retry path', async () => {
    const { classifySendError } = require('../dist/sendOutcome');
    const boom = Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
    assert.equal(classifySendError(boom).outcome, 'rejected_transient');
    assert.equal(classifySendError(new Error('Baileys socket is not initialized.')).outcome, 'rejected_transient');
  });

  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log('delivery-recovery: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
})();
