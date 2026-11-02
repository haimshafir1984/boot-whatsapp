'use strict';
/**
 * Jump back to an older button (P4): what happens when the process DIES in the middle (Codex review of 00d2146, mandatory items 1-3).
 * The crash tests are real: a child process runs the jump and exits abruptly at a chosen point, a second process starts on the same
 * files (like a restart) and either gets the same webhook message again or only runs the startup scan of delivery recovery.
 *   before_send      the journal is on disk, nothing was created yet
 *   after_first_send the first message of the branch was delivered, the next one never started
 *   uncertain_first  the first send was in flight when the process died (outcome unknown)
 * Plus (same process): a handover before recovery, the outbox retry guard, and recovery keeping the jump id of a replayed unit.
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mode = process.argv[2];

function setEnv(dir) {
  Object.assign(process.env, { NODE_ENV: 'test', BOT_REPLY_DELAY_MS: '0', FLOW_STEP_FAILURE_CONTINUE_DELAY_MS: '10', WHATSAPP_PROVIDER: 'META_CLOUD_API',
    STORAGE_PATH: path.join(dir, 'storage.json'), OWNER_STORAGE_PATH: path.join(dir, 'owner.json'), CONVERSATION_STATE_PATH: path.join(dir, 'state.json'),
    OWNER_ACCESS_TOKEN: 'synthetic-owner', CLIENT_ACCESS_TOKEN: 'synthetic-client', META_ACCESS_TOKEN: '', META_PHONE_NUMBER_ID: '', SESSION_PATH: path.join(dir, 'session') });
}

class FakeTransport {
  constructor(onSend) { this.sent = []; this.onSend = onSend; this.n = 0; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  record(entry) {
    this.n += 1;
    if (this.onSend) this.onSend(this.n, entry);
    entry.wamid = `wamid.R${process.pid}.${this.n}`; this.sent.push(entry); return { messageId: entry.wamid };
  }
  async sendMessage(to, text) { return this.record({ type: 'text', to, text }); }
  async sendInteractiveButtons(to, text, buttons) { return this.record({ type: 'buttons', to, text, buttons }); }
  async sendInteractiveList(to, text, buttonText, items) { return this.record({ type: 'list', to, text, buttonText, items }); }
}

const flowOf = () => [
  { id: 'q1', kind: 'question', presentation: 'buttons', text: 'First?', timeoutMinutes: 30, options: [{ id: 'o1', text: 'Yes', nextStepId: 'mA' }, { id: 'o2', text: 'No', nextStepId: 'mB' }] },
  { id: 'mA', kind: 'message', text: 'BRANCH A', nextStepId: 'q2' },
  { id: 'mB', kind: 'message', text: 'BRANCH B', nextStepId: 'q2' },
  { id: 'q2', kind: 'question', presentation: 'buttons', text: 'Second?', timeoutMinutes: 30, options: [{ id: 'p1', text: 'Alpha', nextStepId: 'end' }, { id: 'p2', text: 'Beta', nextStepId: 'end' }] },
  { id: 'end', kind: 'message', text: 'THE END' },
];
const conversationOf = (decisionFlow) => ({ askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow, allowJumpBack: true,
  decisionTimeoutMinutes: 30, decisionTimeoutText: '', decisionTimeoutMode: 'message', decisionTimeoutNextStepId: '', invalidReplyText: '', flowRecoveryText: '',
  humanHandoffEnabled: false, humanHandoffText: '', humanHandoffPhone: '' });
const incoming = (phone, over) => ({ from: `whatsapp:${phone}`, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'T'; }, ...over });

// ---------------------------------------------------------------- child: the process that dies
async function childRun(dir, crash) {
  setEnv(dir);
  const { Storage } = require('../dist/storage');
  const { conversationState } = require('../dist/conversationState');
  const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
  const { computeFlowRev } = require('../dist/flowRev');
  const storage = new Storage(process.env.STORAGE_PATH);
  const campaign = storage.addCampaign({ name: 'Crash', triggerType: 1, triggerPhrase: 'crash-trigger', suffix: '', active: true, conversation: conversationOf(flowOf()) });
  const phone = '972505559001';
  let armed = false;
  let sendsSinceArmed = 0;
  const transport = new FakeTransport(() => {
    if (!armed) return;
    sendsSinceArmed += 1;
    if (crash === 'uncertain_second' && sendsSinceArmed === 2) process.exit(86);   // the 2nd send is in flight (its row is `processing`)
    if (crash === 'uncertain_first' && sendsSinceArmed === 1) process.exit(86);
  });
  await handleIncomingWhatsAppMessage(incoming(phone, { id: 'start-1', body: 'crash-trigger', isButtonReply: false }), storage, transport, 'webhook');
  const q1 = transport.sent.find((m) => m.type === 'buttons');
  await handleIncomingWhatsAppMessage(incoming(phone, { id: 'ans-1', body: 'o1', isButtonReply: true, replyToMessageId: q1.wamid }), storage, transport, 'webhook');
  const run = storage.getCurrentRun(phone);
  const rev = computeFlowRev(storage.getCampaigns().find((c) => c.id === campaign.id).conversation);
  fs.writeFileSync(path.join(dir, 'ctx.json'), JSON.stringify({ phone, resultId: run.id, rev }));
  await storage.flush();
  if (crash === 'before_send') {
    const realRemove = conversationState.remove.bind(conversationState);
    conversationState.remove = (...a) => { if (storage.getCurrentRun(phone)?.jumps?.length) process.exit(86); return realRemove(...a); };   // right after the journal is flushed
  } else {
    armed = true;
    if (crash === 'after_first_send') {
      // dies BETWEEN the sends: the first message is delivered and recorded, the 2nd row of the jump is never created
      const realEnqueue = storage.enqueueOutboxMessage.bind(storage); let jumpRows = 0;
      storage.enqueueOutboxMessage = (input) => { if (String(input.idempotencyKey || '').startsWith('jump:') && (jumpRows += 1) === 2) process.exit(86); return realEnqueue(input); };
    }
  }
  await handleIncomingWhatsAppMessage(incoming(phone, { id: 'jump-msg-1', body: 'o2', isButtonReply: true, signedJump: { resultId: run.id, stepId: 'q1', optionId: 'o2', rev } }), storage, transport, 'webhook');
  process.exit(3);   // it should have died before getting here
}

// ---------------------------------------------------------------- recovery process: the restart
async function childRecover(dir, how) {
  setEnv(dir);
  const { Storage } = require('../dist/storage');
  const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
  const { startDeliveryRecovery } = require('../dist/deliveryRecovery');
  const storage = new Storage(process.env.STORAGE_PATH);
  storage.recoverOrphanedOutboxProcessing();          // what index.ts does at startup
  await storage.flush();
  const ctx = JSON.parse(fs.readFileSync(path.join(dir, 'ctx.json'), 'utf-8'));
  const transport = new FakeTransport();
  const jumpMessage = () => handleIncomingWhatsAppMessage(incoming(ctx.phone, { id: 'jump-msg-1', body: 'o2', isButtonReply: true, signedJump: { resultId: ctx.resultId, stepId: 'q1', optionId: 'o2', rev: ctx.rev } }), storage, transport, 'webhook');
  const status = () => (storage.getCurrentRun(ctx.phone)?.jumps ?? []).map((j) => j.status);
  const settled = () => !status().includes('started');
  if (how === 'handover') storage.supersedeRunsFromOutsideNow(ctx.phone, 'test');
  if (how === 'redeliver') {
    await jumpMessage().catch(() => {});
    await jumpMessage().catch(() => {});                // a third copy of the same webhook
  } else {
    const rec = startDeliveryRecovery(storage, () => transport);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !settled()) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    await rec.stop();
  }
  const run = storage.data.campaignResults.find((r) => r.id === ctx.resultId);
  const jumps = run.jumps ?? [];
  const rows = storage.data.outboxMessages.filter((o) => (o.idempotencyKey || '').startsWith('jump:')).map((o) => ({ key: o.idempotencyKey, status: o.status, text: o.text }));
  process.stdout.write('RESULT ' + JSON.stringify({ jumps: jumps.map((j) => ({ jumpId: j.jumpId, status: j.status })), sent: transport.sent.map((m) => ({ type: m.type, text: m.text })), rows }) + '\n');
  process.exit(0);
}

if (mode === 'run') { childRun(process.argv[3], process.argv[4]).catch((e) => { console.error(e); process.exit(4); }); }
else if (mode === 'recover') { childRecover(process.argv[3], process.argv[4]).catch((e) => { console.error(e); process.exit(5); }); }


// ---------------------------------------------------------------- orchestrator
function crashThenRecover(crash, how) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jump-rec-${crash}-`));
  const first = spawnSync(process.execPath, [__filename, 'run', dir, crash], { encoding: 'utf-8', timeout: 60_000 });
  assert.equal(first.status, 86, `the first process should die at "${crash}" (status ${first.status}) ${first.stderr?.slice(0, 400)}`);
  const second = spawnSync(process.execPath, [__filename, 'recover', dir, how], { encoding: 'utf-8', timeout: 60_000 });
  assert.equal(second.status, 0, `recovery process failed: ${second.stderr?.slice(0, 600)}`);
  const line = second.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, 'no result line: ' + second.stdout.slice(-400));
  fs.rmSync(dir, { recursive: true, force: true });
  return JSON.parse(line.slice(7));
}
const texts = (r) => r.sent.filter((m) => m.type === 'text').map((m) => m.text);
const questions = (r) => r.sent.filter((m) => m.type === 'buttons').map((m) => m.text);

async function main() {
  const results = [];
  const scenario = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); } };

  for (const how of ['redeliver', 'scan']) {
    await scenario(`crash after the journal, before any send (${how}): the same jump resumes, one journal entry, keys jump:<id>:1.. and nothing doubled`, async () => {
      const r = crashThenRecover('before_send', how);
      assert.equal(r.jumps.length, 1, 'no second journal entry, no extra quota: ' + JSON.stringify(r.jumps));
      assert.equal(r.jumps[0].status, 'done');
      assert.deepEqual(texts(r), ['BRANCH B'], 'the branch ran once');
      assert.deepEqual(questions(r), ['Second?']);
      assert.ok(r.rows.length >= 2 && r.rows.every((row) => row.key.startsWith(`jump:${r.jumps[0].jumpId}:`)), 'all rows carry this jump id: ' + JSON.stringify(r.rows));
      assert.deepEqual(r.rows.map((row) => row.key).slice(0, 2), [`jump:${r.jumps[0].jumpId}:1`, `jump:${r.jumps[0].jumpId}:2`]);
    });

    await scenario(`crash after the first send was delivered (${how}): only what is missing is sent, the first message is not sent again`, async () => {
      const r = crashThenRecover('after_first_send', how);
      assert.equal(r.jumps.length, 1); assert.equal(r.jumps[0].status, 'done');
      assert.deepEqual(texts(r), [], 'BRANCH B was delivered before the crash and is not sent again');
      assert.deepEqual(questions(r), ['Second?'], 'the part that never started now goes out');
      const keys = r.rows.map((row) => row.key);
      assert.equal(new Set(keys).size, keys.length, 'no duplicate key');
      assert.equal(r.rows.find((row) => row.key.endsWith(':1')).status, 'sent');
    });

    await scenario(`crash while the SECOND send was in flight (${how}): uncertain, the delivered first message and the unknown second are not sent again`, async () => {
      const r = crashThenRecover('uncertain_second', how);
      assert.equal(r.jumps.length, 1); assert.equal(r.jumps[0].status, 'uncertain');
      assert.deepEqual(r.sent, [], 'nothing is sent again');
      assert.deepEqual(r.rows.map((row) => row.status), ['sent', 'uncertain']);
    });

    await scenario(`crash while the first send was in flight (${how}): the jump is uncertain, nothing is sent again`, async () => {
      const r = crashThenRecover('uncertain_first', how);
      assert.equal(r.jumps.length, 1); assert.equal(r.jumps[0].status, 'uncertain');
      assert.deepEqual(r.sent, [], 'no resend on an unknown outcome');
      assert.equal(r.rows[0].status, 'uncertain');
    });
  }

  await scenario('a handover to another client between the crash and the recovery: the jump is abandoned and nothing of the old run is sent', async () => {
    const r = crashThenRecover('after_first_send', 'handover');
    assert.equal(r.jumps.length, 1); assert.equal(r.jumps[0].status, 'abandoned');
    assert.deepEqual(r.sent, []);
  });

  // ---- same process: the shared "current run" check in delivery recovery and in the outbox retry
  Object.assign(process.env, { NODE_ENV: 'test', BOT_REPLY_DELAY_MS: '0', FLOW_STEP_FAILURE_CONTINUE_DELAY_MS: '10', META_ATTEMPT_CALLBACK_DATA: 'on', OUTBOX_RECOVERY_WINDOW_MS: '1000' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jump-rec-inproc-'));
  process.env.CONVERSATION_STATE_PATH = path.join(root, 'state.json');
  const { Storage } = require('../dist/storage');
  const { conversationState } = require('../dist/conversationState');
  const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
  const { startDeliveryRecovery } = require('../dist/deliveryRecovery');
  const { startOutboxDispatcher } = require('../dist/outboxDispatcher');
  const { computeFlowRev } = require('../dist/flowRev');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms, label) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(20); } throw new Error('timed out: ' + label); };
  const timeoutError = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };
  let seq = 0; let evN = 0;
  const transportOf = () => ({
    log: [], failText: 0,
    async resolvePhone(j) { return String(j).replace(/\D/g, ''); },
    async sendMessage(to, text) { this.log.push(['text', text]); if (this.failText > 0) { this.failText--; throw timeoutError(); } return { messageId: 'w' + this.log.length }; },
    async sendInteractiveButtons(to, text) { this.log.push(['buttons', text]); return { messageId: 'w' + this.log.length }; },
  });
  const jumpScene = async (tr, label) => {
    const st = new Storage(path.join(fs.mkdtempSync(path.join(root, 'st-')), 's.json'));
    const campaign = st.addCampaign({ name: label, triggerType: 1, triggerPhrase: label, suffix: '', active: true, conversation: conversationOf(flowOf()) });
    const phone = `97250556${String(1000 + (seq += 1))}`;
    await handleIncomingWhatsAppMessage(incoming(phone, { id: `s${++seq}`, body: label, isButtonReply: false }), st, tr, 'webhook');
    await handleIncomingWhatsAppMessage(incoming(phone, { id: `a${++seq}`, body: 'o1', isButtonReply: true }), st, tr, 'webhook');
    const run = st.getCurrentRun(phone);
    const rev = computeFlowRev(st.getCampaigns().find((c) => c.id === campaign.id).conversation);
    const pendingBefore = { ...conversationState.get(`whatsapp:${phone}`) };
    // Puts back a conversation state that still points at this run and at the unit's step: then only the run check can stop a replay.
    const restoreState = (stepId) => { conversationState.removeByPhone(phone); conversationState.set(`whatsapp:${phone}`, { ...pendingBefore, stepId }); };
    const jump = (id) => handleIncomingWhatsAppMessage(incoming(phone, { id, body: 'o2', isButtonReply: true, signedJump: { resultId: run.id, stepId: 'q1', optionId: 'o2', rev } }), st, tr, 'webhook');
    return { st, phone, run, jump, restoreState, jid: `whatsapp:${phone}` };
  };

  await scenario('recovery keeps the jump id: after an unknown delivery inside the branch, the replayed rest of the branch still gets jump:<id> keys', async () => {
    const tr = transportOf(); const { st, phone, jump } = await jumpScene(tr, 'rk-one');
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      tr.failText = 1;                                  // the first message of the branch: response lost
      await assert.rejects(() => jump('jr-1'));
      const row = st.getUncertainOutboxMessages()[0];
      assert.match(row.idempotencyKey, /^jump:j_/);
      const jumpId = st.getCurrentRun(phone).jumps[0].jumpId;
      assert.equal(st.getUnitContinuation(row.id).descriptor.jumpId, jumpId, 'the unit remembers the jump it belongs to');
      st.applyMetaStatus({ wamid: `wamid.EV${++evN}`, status: 'delivered', recipientId: phone, attemptId: st.getOutboxMessage(row.id).attemptId });
      await waitFor(() => tr.log.filter((x) => x[0] === 'buttons' && x[1] === 'Second?').length >= 1, 8000, 'recovery continued the branch');
      const asked = st.data.outboxMessages.filter((o) => o.text === 'Second?' && o.campaignResultId === st.getCurrentRun(phone).id);
      const created = asked[asked.length - 1];   // the first 'Second?' belongs to the original run, before the jump
      assert.ok(asked.length >= 2 && (created.idempotencyKey || '').startsWith(`jump:${jumpId}:`), 'the row created by the replay carries the jump key: ' + JSON.stringify(asked.map((o) => o.idempotencyKey)));
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('a handover before delivery recovery runs: the continuation is skipped and nothing of the old run is sent', async () => {
    const tr = transportOf(); const { st, phone, jump, jid, restoreState } = await jumpScene(tr, 'rk-two');
    const rec = startDeliveryRecovery(st, () => tr);
    try {
      tr.failText = 1;
      await assert.rejects(() => jump('jr-2'));
      const row = st.getUncertainOutboxMessages()[0];
      const before = tr.log.length;
      st.supersedeRunsFromOutsideNow(phone, 'to-other-client');      // another client took her over: no new result is created here
      restoreState(st.getUnitContinuation(row.id).descriptor.stepId);   // ... and her state still looks like she is in the run: only the run check can stop the replay
      st.applyMetaStatus({ wamid: `wamid.EV${++evN}`, status: 'delivered', recipientId: phone, attemptId: st.getOutboxMessage(row.id).attemptId });
      await waitFor(() => st.getUnitContinuation(row.id)?.state === 'skipped', 8000, 'continuation skipped');
      await sleep(400);
      assert.equal(tr.log.length, before, 'nothing was sent for the replaced run');
    } finally { await rec.stop(); conversationState.removeByPhone(phone); }
  });

  await scenario('the outbox retry of an old run is not sent after a handover (same shared check)', async () => {
    const tr = transportOf(); const { st, phone, jump, restoreState } = await jumpScene(tr, 'rk-three');
    let disp;
    try {
      tr.failText = 1;
      await assert.rejects(() => jump('jr-3'));
      const row = st.getUncertainOutboxMessages()[0];
      st.supersedeRunsFromOutsideNow(phone, 'to-other-client');
      for (const queued of st.data.outboxMessages.filter((o) => o.status === 'queued')) st.markOutboxFailed(queued.id, 'cancelled with the handover');   // only the unsent rows: the unknown one is what this scenario is about
      restoreState(st.getUnitContinuation(row.id).descriptor.stepId);
      const before = tr.log.length;
      disp = startOutboxDispatcher(st, () => tr, 150);
      await waitFor(() => st.getOutboxMessage(row.id).status === 'recoverable_failed', 10_000, 'the old message is not retried');
      await sleep(500);
      assert.equal(tr.log.length, before, 'the retry never reaches the provider: ' + JSON.stringify(tr.log.slice(before)));
      assert.equal(st.getOutboxMessage(row.id).attemptLog.length, 1, 'the only attempt is the original unknown one');
      assert.equal(st.getUnitContinuation(row.id).state, 'skipped');
    } finally { if (disp) await disp.stop(); conversationState.removeByPhone(phone); }
  });

  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) { console.info(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.info(failed ? `\n${failed} scenario(s) FAILED` : `\nJump recovery tests passed (${results.length} scenarios).`);
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
}

if (!mode) main();
