'use strict';
/**
 * Jump back to an older button (P4): a verified signed button of an OLDER question takes her back to that option's branch (only when
 * the campaign allows it), journaled BEFORE anything is sent, limited per run, never for a replaced run, with stable outbox keys, and
 * a repeated group-join request limited to 1/minute and 3/24h. Direct flow tests plus the real webhook wiring.
 */
process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.FLOW_STEP_FAILURE_CONTINUE_DELAY_MS = '10';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-jump-'));
const { deriveRouteKey } = require('../dist/buttonToken');
const MASTER = Buffer.alloc(32, 7); const FULL = Buffer.alloc(32, 3); const ME = 'client-me';
Object.assign(process.env, { WHATSAPP_PROVIDER: 'META_CLOUD_API', STORAGE_PATH: path.join(root, 'storage.json'), OWNER_STORAGE_PATH: path.join(root, 'owner.json'),
  CONVERSATION_STATE_PATH: path.join(root, 'state.json'), OWNER_ACCESS_TOKEN: 'synthetic-owner', CLIENT_ACCESS_TOKEN: 'synthetic-client', META_ACCESS_TOKEN: '',
  DOKPLOY_META_ACCESS_TOKEN: '', META_PHONE_NUMBER_ID: '', SESSION_PATH: path.join(root, 'session'),
  META_BUTTON_V1_ISSUE: '1', META_BUTTON_CLIENT_ID: ME, META_BUTTON_ROUTE_KEYS: `k1:${deriveRouteKey(MASTER, ME).toString('base64url')}`, META_BUTTON_FULL_KEYS: `k1:${FULL.toString('base64url')}` });

const { Storage } = require('../dist/storage');
const { grantButtonLease } = require('../dist/buttonLease');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { computeFlowRev } = require('../dist/flowRev');
const { config } = require('../dist/config');
grantButtonLease(600_000);
const storage = new Storage(process.env.STORAGE_PATH);

let wamid = 0;
class FakeTransport {
  constructor() { this.sent = []; this.onSend = null; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  record(entry) { entry.wamid = `wamid.J${++wamid}`; this.sent.push(entry); if (this.onSend) this.onSend(entry); return { messageId: entry.wamid }; }
  async sendMessage(to, text) { return this.record({ type: 'text', to, text }); }
  async sendInteractiveButtons(to, text, buttons) { return this.record({ type: 'buttons', to, text, buttons }); }
  async sendInteractiveList(to, text, buttonText, items) { return this.record({ type: 'list', to, text, buttonText, items }); }
}
const texts = (t) => t.sent.filter((m) => m.type === 'text').map((m) => m.text);
const conversationOf = (decisionFlow, extra = {}) => ({ askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow,
  decisionTimeoutMinutes: 30, decisionTimeoutText: '', decisionTimeoutMode: 'message', decisionTimeoutNextStepId: '', invalidReplyText: '', flowRecoveryText: '',
  humanHandoffEnabled: false, humanHandoffText: '', humanHandoffPhone: '', ...extra });
const flow = () => [
  { id: 'q1', kind: 'question', presentation: 'buttons', text: 'First?', timeoutMinutes: 30, options: [{ id: 'o1', text: 'Yes', nextStepId: 'mA' }, { id: 'o2', text: 'No', nextStepId: 'mB' }] },
  { id: 'mA', kind: 'message', text: 'BRANCH A', nextStepId: 'q2' },
  { id: 'mB', kind: 'message', text: 'BRANCH B', nextStepId: 'q2' },
  { id: 'q2', kind: 'question', presentation: 'buttons', text: 'Second?', timeoutMinutes: 30, options: [{ id: 'p1', text: 'Alpha', nextStepId: 'end' }, { id: 'p2', text: 'Beta', nextStepId: 'end' }] },
  { id: 'end', kind: 'message', text: 'THE END' },
];
let seq = 0; let pseq = 0;
const campaignFor = (decisionFlow, extra = {}) => storage.addCampaign({ name: `C${++seq}`, triggerType: 1, triggerPhrase: `trigger-${seq}`, suffix: '', active: true, conversation: conversationOf(decisionFlow, extra) });
const base = (phone) => ({ from: `whatsapp:${phone}`, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'T'; } });
const startRun = async (campaign, transport) => {
  const phone = `97250555${String(1000 + (pseq += 1))}`;
  await handleIncomingWhatsAppMessage({ ...base(phone), id: `m${++seq}`, body: campaign.triggerPhrase, isButtonReply: false }, storage, transport, 'webhook');
  return phone;
};
const answer = (phone, transport, body, replyTo) => handleIncomingWhatsAppMessage({ ...base(phone), id: `a${++seq}`, body, isButtonReply: true, replyToMessageId: replyTo }, storage, transport, 'webhook');
const jump = (phone, transport, campaign, stepId, optionId, id = `j${++seq}`) => {
  const run = storage.getCurrentRun(phone);
  const rev = computeFlowRev(storage.getCampaigns().find((c) => c.id === campaign.id).conversation);
  return handleIncomingWhatsAppMessage({ ...base(phone), id, body: optionId, isButtonReply: true, signedJump: { resultId: run.id, stepId, optionId, rev } }, storage, transport, 'webhook');
};
// Moves the clock forward (the flow ignores the SAME reply twice within 15 s, which would hide the limits being tested).
const realNow = Date.now.bind(Date); let skew = 0;
Date.now = () => realNow() + skew;
const later = (ms) => { skew += ms; };
const jumps = (phone) => (storage.getCurrentRun(phone)?.jumps ?? []);

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 6).join(' | ')]); }
}
const lines = [];
for (const level of ['log', 'warn', 'error']) { const o = console[level].bind(console); console[level] = (...a) => { lines.push(a.map(String).join(' ')); o(...a); }; }

(async () => {
  await scenario('a campaign that does not allow it: a jump is refused and nothing is sent', async () => {
    const t = new FakeTransport(); const c = campaignFor(flow());
    const phone = await startRun(c, t);
    const q1 = t.sent.find((m) => m.type === 'buttons');
    await answer(phone, t, 'o1', q1.wamid);
    const before = t.sent.length;
    await jump(phone, t, c, 'q1', 'o2');
    assert.equal(t.sent.length, before, 'nothing sent');
    assert.ok(lines.some((l) => l.includes('[JUMP_REJECTED] reason=jump_not_allowed')));
    assert.equal(jumps(phone).length, 0);
  });

  await scenario('allowed: an old button returns to its branch, the flow continues in order, and the jump is journaled as done', async () => {
    const t = new FakeTransport(); const c = campaignFor(flow(), { allowJumpBack: true });
    const phone = await startRun(c, t);
    const q1 = t.sent.find((m) => m.type === 'buttons');
    await answer(phone, t, 'o1', q1.wamid);
    assert.ok(texts(t).includes('BRANCH A'));
    const before = t.sent.length;
    await jump(phone, t, c, 'q1', 'o2');
    const after = t.sent.slice(before);
    assert.ok(after.some((m) => m.type === 'text' && m.text === 'BRANCH B'), 'the other branch ran: ' + JSON.stringify(after.map((m) => m.text)));
    assert.ok(after.some((m) => m.type === 'buttons' && m.text.includes('Second')), 'and the flow continued to the next question in order');
    const [entry] = jumps(phone);
    assert.equal(entry.status, 'done'); assert.equal(entry.toStepId, 'q1'); assert.equal(entry.optionId, 'o2'); assert.equal(entry.fromStepId, 'q2');
  });

  await scenario('the journal is on disk BEFORE the first send of the branch', async () => {
    const t = new FakeTransport(); const c = campaignFor(flow(), { allowJumpBack: true });
    const phone = await startRun(c, t);
    const q1 = t.sent.find((m) => m.type === 'buttons');
    await answer(phone, t, 'o1', q1.wamid);
    let onDisk;
    t.onSend = (entry) => {
      if (onDisk === undefined && entry.text === 'BRANCH B') {
        const saved = JSON.parse(fs.readFileSync(process.env.STORAGE_PATH, 'utf-8'));
        onDisk = (saved.campaignResults.find((r) => r.id === storage.getCurrentRun(phone).id).jumps ?? []).map((j) => j.status);
      }
    };
    await jump(phone, t, c, 'q1', 'o2');
    assert.deepEqual(onDisk, ['started'], 'at the moment BRANCH B was sent the file already said started');
  });

  await scenario('the branch sends carry stable keys jump:<jumpId>:...; a redelivery of the same message sends nothing again', async () => {
    const t = new FakeTransport(); const c = campaignFor(flow(), { allowJumpBack: true });
    const phone = await startRun(c, t);
    const q1 = t.sent.find((m) => m.type === 'buttons');
    await answer(phone, t, 'o1', q1.wamid);
    const id = `redeliver-${++seq}`;
    await jump(phone, t, c, 'q1', 'o2', id);
    const keys = storage.data.outboxMessages.filter((o) => (o.idempotencyKey || '').startsWith('jump:j_'));
    assert.ok(keys.length >= 2, 'keys on the branch rows: ' + keys.length);
    assert.equal(new Set(keys.map((k) => k.idempotencyKey)).size, keys.length, 'one key per send');
    const sentBefore = t.sent.length;
    await jump(phone, t, c, 'q1', 'o2', id);
    assert.equal(t.sent.length, sentBefore, 'same inbound message: nothing sent again');
    assert.equal(jumps(phone).length, 1, 'and not journaled twice');
  });

  await scenario('limits per run come from the journal: the next one over the hourly cap is refused with no send', async () => {
    process.env.JUMP_MAX_PER_HOUR = '2';
    try {
      const t = new FakeTransport(); const c = campaignFor(flow(), { allowJumpBack: true });
      const phone = await startRun(c, t);
      const q1 = t.sent.find((m) => m.type === 'buttons');
      await answer(phone, t, 'o1', q1.wamid);
      await jump(phone, t, c, 'q1', 'o2'); later(20_000); await jump(phone, t, c, 'q1', 'o1'); later(20_000);
      const before = t.sent.length;
      await jump(phone, t, c, 'q1', 'o2');
      assert.equal(t.sent.length, before, 'third jump in the hour: no action');
      assert.ok(lines.some((l) => l.includes('[JUMP_REJECTED] reason=rate_hour')));
      assert.equal(jumps(phone).length, 2);
      const reopened = new Storage(process.env.STORAGE_PATH);
      assert.equal(reopened.getCurrentRun(phone).jumps.length, 2, 'the counts survive a restart');
    } finally { delete process.env.JUMP_MAX_PER_HOUR; }
  });

  await scenario('a replaced run never jumps (a newer trigger of hers, even in the same campaign)', async () => {
    const t = new FakeTransport(); const c = campaignFor(flow(), { allowJumpBack: true });
    const phone = await startRun(c, t);
    const oldRun = storage.getCurrentRun(phone);
    const q1 = t.sent.find((m) => m.type === 'buttons');
    await answer(phone, t, 'o1', q1.wamid);
    storage.recordCampaignTrigger(c.id, phone, 'again');   // a newer run replaces the old one
    const before = t.sent.length;
    const rev = computeFlowRev(storage.getCampaigns().find((x) => x.id === c.id).conversation);
    await handleIncomingWhatsAppMessage({ ...base(phone), id: `old-${++seq}`, body: 'o2', isButtonReply: true, signedJump: { resultId: oldRun.id, stepId: 'q1', optionId: 'o2', rev } }, storage, t, 'webhook');
    assert.equal(t.sent.length, before);
    assert.ok(lines.some((l) => l.includes('[JUMP_REJECTED] reason=not_current_run')));
  });

  await scenario('an uncertain delivery inside the branch is journaled as uncertain (and rethrown for the normal hold handling)', async () => {
    const t = new FakeTransport(); const c = campaignFor(flow(), { allowJumpBack: true });
    const phone = await startRun(c, t);
    const q1 = t.sent.find((m) => m.type === 'buttons');
    await answer(phone, t, 'o1', q1.wamid);
    const { ProviderSendError } = require('../dist/sendOutcome');
    t.onSend = (entry) => { if (entry.text === 'BRANCH B') throw new ProviderSendError('connection reset after the request was written', 'uncertain'); };
    await assert.rejects(() => jump(phone, t, c, 'q1', 'o2'));
    assert.equal(jumps(phone)[0].status, 'uncertain', 'an unknown outcome stays uncertain: no resend, the usual hold');
    t.onSend = null;
  });

  await scenario('group join through a jump: repeated at most once a minute and 3 times in 24 hours, then no action', async () => {
    const gj = () => [
      { id: 'g1', kind: 'question', presentation: 'buttons', text: 'Join?', timeoutMinutes: 30, options: [{ id: 'join', text: 'Join', action: 'request_group_join', nextStepId: 'gmsg' }, { id: 'skip', text: 'Skip', nextStepId: 'gmsg' }] },
      { id: 'gmsg', kind: 'message', text: 'THANKS', nextStepId: 'g2' },
      { id: 'g2', kind: 'question', presentation: 'buttons', text: 'More?', timeoutMinutes: 30, options: [{ id: 'x1', text: 'A', nextStepId: 'gend' }, { id: 'x2', text: 'B', nextStepId: 'gend' }] },
      { id: 'gend', kind: 'message', text: 'BYE' },
    ];
    const t = new FakeTransport(); const c = campaignFor(gj(), { allowJumpBack: true, groupJoinManagerPhone: '972501112233' });
    const phone = await startRun(c, t);
    const q = t.sent.find((m) => m.type === 'buttons');
    await answer(phone, t, 'skip', q.wamid);
    const toManager = () => t.sent.filter((m) => String(m.to).includes('972501112233'));
    await jump(phone, t, c, 'g1', 'join');
    assert.equal(toManager().length, 1, 'first press through a jump: the request is sent');
    later(20_000);
    await jump(phone, t, c, 'g1', 'join');
    assert.equal(toManager().length, 1, 'again within a minute: no second request');
    assert.ok(lines.some((l) => l.includes('[GROUP_JOIN_REPEAT_LIMITED]')));
    const result = storage.getCurrentRun(phone);
    result.groupJoinRepeatsAt = [new Date(Date.now() - 3 * 3600_000).toISOString(), new Date(Date.now() - 2 * 3600_000).toISOString(), new Date(Date.now() - 3600_000).toISOString()];
    later(70_000);
    await jump(phone, t, c, 'g1', 'join');
    assert.equal(toManager().length, 1, '3 within 24 hours: none more');
  });

  // The real webhook: with META_BUTTON_JUMP=1 an older signed button becomes a jump; without it, nothing happens.
  config.ADMIN_PORT = 0;
  const server = require('../dist/adminServer').startAdminServer(storage);
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  const tap = async (phone, buttonId) => {
    n += 1; const id = `wamid.jump${n}`;
    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'x', display_phone_number: '15550001111' }, contacts: [{ wa_id: phone, profile: { name: 'T' } }],
      messages: [{ id, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId, title: 'No' } }, context: { id: 'wamid.Q' } }] } }] }] };
    const res = await fetch(baseUrl + '/internal/meta/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-token': 'synthetic-owner' }, body: JSON.stringify(payload) });
    assert.ok(res.status === 200 || res.status === 202);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !lines.some((l) => l.includes(id))) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 250));
    return lines.filter((l) => l.includes(id));
  };

  await scenario('webhook: flag off -> an older signed button is only reported; flag on -> it becomes a jump request for the flow', async () => {
    const t = new FakeTransport(); const c = campaignFor(flow(), { allowJumpBack: true });
    const phone = await startRun(c, t);
    const q1 = t.sent.find((m) => m.type === 'buttons');
    await answer(phone, t, 'o1', q1.wamid);
    delete process.env.META_BUTTON_JUMP;
    const off = await tap(phone, q1.buttons[1].id);
    assert.ok(off.some((l) => l.includes('no_action_yet')) && !off.some((l) => l.includes('[META_INBOUND]')), off.join(' | '));
    process.env.META_BUTTON_JUMP = '1';
    const on = await tap(phone, q1.buttons[1].id);
    assert.ok(on.some((l) => l.includes('[META_V1_BUTTON_JUMP]')), on.join(' | '));
    assert.ok(on.some((l) => l.includes('[META_INBOUND]') && l.includes(' o2 ')), 'the flow was handed the option: ' + on.join(' | '));
    delete process.env.META_BUTTON_JUMP;
  });

  server.closeAllConnections(); server.close();
  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) { console.info(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.info(failed ? `\n${failed} scenario(s) FAILED` : `\nV1 button jump tests passed (${results.length} scenarios).`);
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})().catch((e) => { console.error(e); process.exit(1); });
