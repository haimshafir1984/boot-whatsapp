/**
 * Stage B2 / step 3 (extension): delivery recovery for the paths that used to be "hold released but the flow does not
 * continue": the answer to a question (button tap), wait_reply / email capture, timers (inactivity timeout), and the
 * service bot (message + scheduled follow-up). Each is a flow unit; a resolution replays it, skipping what was delivered.
 * Also: the recovery window default depends on the provider (Meta 60s, no-callback providers a few seconds).
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
const { handleIncomingWhatsAppMessage, holdSenderForUncertainFailure, replayHeldMessages } = require('../dist/messageFlow');
const { tryHandleServiceBotMessage, deliverServiceBotFollowUp } = require('../dist/serviceBot');
const { startServiceBotFollowUpDispatcher } = require('../dist/serviceBotFollowUpDispatcher');

config.CLIENT_SERVICE_BOT_ENABLED = true;
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

(async () => {
  await scenario('P1 answer to a question (button tap): end text uncertain + evidence => the reply is NOT resent, the next step is sent ONCE, the answer is recorded once', async () => {
    const { st, campaign } = flowStorage([
      { id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick', options: [{ id: 'a', text: 'A', endText: 'Great choice', nextStepId: 'done' }, { id: 'b', text: 'B', nextStepId: 'done' }] },
      { id: 'done', kind: 'message', text: 'Thanks, done' },
    ], 'p1-join');
    const log = []; const tr = transportOf(log); const phone = '972504000001'; const jid = `whatsapp:${phone}`;
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      await inbound(st, tr, phone, 'p1-join');
      assert.equal(conversationState.get(jid).kind, 'decision');
      tr.failText = 1;
      await assert.rejects(() => inbound(st, tr, phone, 'a', true));
      const row = st.getUncertainOutboxMessages()[0];
      assert.equal(row.text, 'Great choice');
      assert.equal(st.getUnitContinuation(row.id).descriptor.kind, 'decision_reply');
      assert.equal(conversationState.getNeedsReview(jid).recovery.outboxId, row.id);
      assert.equal(count(log, 'text', 'Thanks, done'), 0, 'the flow had stopped before the next step');
      evidence(st, row.id);
      await waitFor(() => count(log, 'text', 'Thanks, done') === 1, 5000, 'flow moved on to the next step');
      assert.equal(count(log, 'text', 'Great choice'), 1, 'the delivered reply is not sent again');
      assert.equal(conversationState.getNeedsReview(jid), undefined);
      await sleep(400); assert.equal(count(log, 'text', 'Thanks, done'), 1);
      const answered = st.getCampaignEvents(campaign.id).filter((e) => e.type === 'step_answered');
      assert.equal(answered.length, 1, 'the answer is recorded once (no double-counted result)');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('P2 wait_reply / email capture: the "invalid email" reply is uncertain + evidence => not resent, the wait is re-armed, participant can answer again', async () => {
    const { st } = flowStorage([
      { id: 'w1', kind: 'email_capture', text: 'Your email?', nextStepId: 'done', emailInvalidText: 'That does not look like an email' },
      { id: 'done', kind: 'message', text: 'Thanks, done' },
    ], 'p2-join');
    const log = []; const tr = transportOf(log); const phone = '972504000002'; const jid = `whatsapp:${phone}`;
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      await inbound(st, tr, phone, 'p2-join');
      assert.equal(conversationState.get(jid).kind, 'wait-reply');
      tr.failText = 1;
      await assert.rejects(() => inbound(st, tr, phone, 'not-an-email'));
      const row = st.getUncertainOutboxMessages()[0];
      assert.equal(st.getUnitContinuation(row.id).descriptor.kind, 'wait_reply');
      evidence(st, row.id);
      await waitFor(() => conversationState.get(jid)?.kind === 'wait-reply' && !conversationState.getNeedsReview(jid), 5000, 'wait re-armed after recovery');
      assert.equal(count(log, 'text', 'That does not look like an email'), 1, 'not resent');
      await inbound(st, tr, phone, 'me@example.com');
      assert.equal(count(log, 'text', 'Thanks, done'), 1, 'the participant can carry on');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('P3 timer (inactivity timeout): an unknown outcome HOLDS the participant (it used to be only logged), evidence releases it, nothing is resent', async () => {
    const { st } = flowStorage([
      { id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick', timeoutSeconds: 1, timeoutText: 'Still there?', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
    ], 'p3-join');
    const log = []; const tr = transportOf(log); const phone = '972504000003'; const jid = `whatsapp:${phone}`;
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      await inbound(st, tr, phone, 'p3-join');
      tr.failText = 1;   // the timeout message will hit an unknown outcome
      await waitFor(() => st.getUncertainOutboxMessages().length === 1, 6000, 'timeout message uncertain');
      const row = st.getUncertainOutboxMessages()[0];
      assert.equal(row.text, 'Still there?');
      assert.equal(conversationState.getNeedsReview(jid)?.recovery?.outboxId, row.id, 'the timer failure created a recovery hold tied to that message');
      assert.equal(st.getUnitContinuation(row.id).descriptor.kind, 'decision_timeout');
      evidence(st, row.id);
      await waitFor(() => !conversationState.getNeedsReview(jid), 5000, 'hold released');
      assert.equal(count(log, 'text', 'Still there?'), 1, 'the timeout message was not sent again');
      await sleep(300); assert.equal(st.getUnitContinuation(row.id).state, 'done');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  function serviceBotStorage() {
    const st = new Storage(path.join(mk('paths-sb-'), 's.json'), { initialData: emptyStorageData() });
    st.updateServiceBot({
      enabled: true, name: 'SB', triggerText: 'sbmenu', mainMenuNodeId: 'main', fallbackText: 'fallback',
      nodes: [
        { id: 'main', title: 'Main', type: 'menu', text: 'How can we help?', options: [{ id: 'a', label: 'Info', targetNodeId: 'info' }, { id: 'b', label: 'Other', targetNodeId: 'info' }] },
        { id: 'info', title: 'Info', type: 'message', text: 'Some information' },
      ],
    });
    st.addCampaign({ name: 'unrelated', triggerType: 1, triggerPhrase: 'zzz-unrelated', suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: 'hi', followupMessages: [], decisionFlow: [] } });
    return st;
  }

  await scenario('P4 service bot message: navigation prompt uncertain + evidence => session restored and the message REPLAYED: nothing resent, session ends where it should', async () => {
    const st = serviceBotStorage(); const log = []; const tr = transportOf(log); const phone = '972504000004'; const jid = `whatsapp:${phone}`;
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      await inbound(st, tr, phone, 'sbmenu');
      assert.equal(st.getServiceBotSession(phone).nodeId, 'main');
      tr.failButtons = 1; const before = count(log, 'text');
      await assert.rejects(() => inbound(st, tr, phone, '1'));       // enters 'info' (text sent), then the navigation buttons are uncertain
      const row = st.getUncertainOutboxMessages()[0];
      assert.equal(st.getUnitContinuation(row.id).descriptor.kind, 'service_bot');
      assert.equal(st.getServiceBotSession(phone).nodeId, 'info', 'the session had already advanced when the send failed');
      const buttonsBefore = count(log, 'buttons'); const textBefore = count(log, 'text', 'Some information');
      evidence(st, row.id);
      await waitFor(() => !conversationState.getNeedsReview(jid), 5000, 'released');
      await sleep(500);
      assert.equal(st.getServiceBotSession(phone).nodeId, 'info', 'replay leaves the session at the right node (no double advance)');
      assert.equal(count(log, 'buttons'), buttonsBefore, 'the delivered navigation prompt is not resent');
      assert.equal(count(log, 'text', 'Some information'), textBefore, 'the delivered node text is not resent');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('P5 service bot follow-up run by the dispatcher: an unknown outcome holds the participant and is NOT retried by the follow-up retry loop; evidence releases it', async () => {
    const st = serviceBotStorage(); const log = []; const tr = transportOf(log); const phone = '972504000005'; const jid = `whatsapp:${phone}`;
    await tryHandleServiceBotMessage('sbmenu', jid, phone, st, tr);
    const session = st.getServiceBotSession(phone); const bot = st.getServiceBots()[0];
    st.scheduleServiceBotFollowUp({ botId: bot.id, phone, to: jid, nodeId: session.nodeId, text: 'reminder', runAt: new Date(Date.now() - 1000).toISOString() });
    tr.failText = 1;
    const rec = startDeliveryRecovery(st, () => tr); const disp = startServiceBotFollowUpDispatcher(st, () => tr, 100);
    try {
      await waitFor(() => st.getUncertainOutboxMessages().length === 1, 6000, 'follow-up uncertain');
      const row = st.getUncertainOutboxMessages()[0];
      assert.equal(row.text, 'reminder'); assert.equal(conversationState.getNeedsReview(jid)?.recovery?.outboxId, row.id);
      await sleep(600);
      assert.equal(count(log, 'text', 'reminder'), 1, 'the follow-up retry loop must not resend it');
      evidence(st, row.id);
      await waitFor(() => !conversationState.getNeedsReview(jid), 5000, 'released');
      assert.equal(count(log, 'text', 'reminder'), 1);
    } finally { await disp.stop(); await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('P7 Baileys: a message that arrives while the sender is held is KEPT (replayable) and processed after the hold is released - never dropped', async () => {
    const { st } = flowStorage([
      { id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick', options: [{ id: 'a', text: 'A', endText: 'Great choice', nextStepId: 'done' }, { id: 'b', text: 'B', nextStepId: 'done' }] },
      { id: 'done', kind: 'message', text: 'Thanks, done' },
    ], 'p7-join');
    const log = []; const tr = transportOf(log); const phone = '972504000007'; const jid = `whatsapp:${phone}`;
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      tr.failButtons = 1;
      await assert.rejects(() => inbound(st, tr, phone, 'p7-join', false, 'baileys'));
      const row = st.getUncertainOutboxMessages()[0];
      assert.equal(conversationState.getNeedsReview(jid).recovery.outboxId, row.id);
      await assert.rejects(() => inbound(st, tr, phone, 'A', false, 'baileys'), /held/i);   // arrives during the hold
      const held = conversationState.getNeedsReview(jid).heldMessages;
      assert.equal(held.length, 1); assert.equal(held[0].source, 'baileys');
      assert.equal(held[0].replay.body, 'A', 'the full message is kept, not only a preview');
      assert.equal(count(log, 'text', 'Great choice'), 0, 'not processed while held');
      evidence(st, row.id);
      try { await waitFor(() => count(log, 'text', 'Great choice') === 1 && count(log, 'text', 'Thanks, done') === 1, 6000, 'the held answer was processed after the release'); } catch (e) { throw new Error(e.message + ' log=' + JSON.stringify(log) + ' state=' + (conversationState.get(jid)?.kind ?? 'none') + ' reason=' + (conversationState.get(jid)?.reason ?? '')); }
      assert.equal(conversationState.getNeedsReview(jid), undefined);
      await sleep(400); assert.equal(count(log, 'text', 'Great choice'), 1, 'processed exactly once');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('P8 a held Baileys message without replay data is never dropped silently (critical alert + log); the admin requeue path replays through the same code', async () => {
    const { st } = flowStorage([
      { id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick', options: [{ id: 'a', text: 'A', nextStepId: 'done' }] },
      { id: 'done', kind: 'message', text: 'Thanks, done' },
    ], 'p8-join');
    const log = []; const tr = transportOf(log); const phone = '972504000008';
    const errs = []; const origErr = console.error; console.error = (...a) => { errs.push(a.join(' ')); };
    try {
      const r = await replayHeldMessages([{ messageId: 'old1', source: 'baileys', bodyPreview: 'legacy entry', timestamp: 1 }], st, tr);
      assert.equal(r.notReplayable, 1); assert.equal(r.replayed, 0);
      assert.ok(errs.some((e) => e.includes('[HELD_MESSAGE_NOT_REPLAYABLE]') && e.includes('legacy entry')), 'a visible trace exists');
    } finally { console.error = origErr; }
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      deliveryRecoveryBus.emit('replayHeld', [{ messageId: 'x1', source: 'baileys', bodyPreview: 'p8-join', timestamp: Date.now(), replay: { from: `whatsapp:${phone}`, senderPhone: phone, body: 'p8-join', hasUserSignal: true } }]);
      await waitFor(() => count(log, 'buttons', 'Pick') === 1, 5000, 'admin requeue replayed the held message');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('P6 the recovery window default follows the provider: Meta 60s (waiting for evidence), no-callback providers a few seconds; explicit env wins', async () => {
    const keepWin = process.env.OUTBOX_RECOVERY_WINDOW_MS; const keepProv = process.env.WHATSAPP_PROVIDER;
    try {
      delete process.env.OUTBOX_RECOVERY_WINDOW_MS;
      process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API'; assert.equal(recoveryWindowMs(), 60_000);
      process.env.WHATSAPP_PROVIDER = 'BAILEYS'; assert.equal(recoveryWindowMs(), 5_000);
      delete process.env.WHATSAPP_PROVIDER; assert.equal(recoveryWindowMs(), 5_000, 'Baileys is the default provider');
      process.env.OUTBOX_RECOVERY_WINDOW_MS = '2000'; assert.equal(recoveryWindowMs(), 2_000);
    } finally { if (keepWin === undefined) delete process.env.OUTBOX_RECOVERY_WINDOW_MS; else process.env.OUTBOX_RECOVERY_WINDOW_MS = keepWin; if (keepProv === undefined) delete process.env.WHATSAPP_PROVIDER; else process.env.WHATSAPP_PROVIDER = keepProv; }
  });

  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log('recovery-paths: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
})();
