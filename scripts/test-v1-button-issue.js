'use strict';
/**
 * Issuing signed v1 buttons (P2): off by default (legacy ids exactly as before); on, every question's buttons and list rows carry a v1 id that
 * the client verifies; the question she is on is answered through the webhook as an ordinary answer, an older one is not acted on yet; an id
 * that does not fit or a half-configured client is a configuration error (alert, text fallback), never a silent legacy id.
 */
process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-issue-'));
const { deriveRouteKey } = require('../dist/buttonToken');
const MASTER = Buffer.alloc(32, 7); const FULL = Buffer.alloc(32, 3); const ME = 'client-me';
Object.assign(process.env, { WHATSAPP_PROVIDER: 'META_CLOUD_API', STORAGE_PATH: path.join(root, 'storage.json'), OWNER_STORAGE_PATH: path.join(root, 'owner.json'),
  CONVERSATION_STATE_PATH: path.join(root, 'state.json'), OWNER_ACCESS_TOKEN: 'synthetic-owner', CLIENT_ACCESS_TOKEN: 'synthetic-client', META_ACCESS_TOKEN: '',
  DOKPLOY_META_ACCESS_TOKEN: '', META_PHONE_NUMBER_ID: '', SESSION_PATH: path.join(root, 'session') });
const KEYS = { META_BUTTON_CLIENT_ID: ME, META_BUTTON_ROUTE_KEYS: `k1:${deriveRouteKey(MASTER, ME).toString('base64url')}`, META_BUTTON_FULL_KEYS: `k1:${FULL.toString('base64url')}` };
const setIssue = (on, extra = {}) => {
  for (const k of Object.keys(KEYS)) delete process.env[k];
  delete process.env.META_BUTTON_V1_ISSUE; delete process.env.META_BUTTON_ISSUE_KID; delete process.env.META_BUTTON_REVOKED_KIDS;
  if (on) Object.assign(process.env, KEYS, { META_BUTTON_V1_ISSUE: '1' }, extra);
};

const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { verifyClientButton, loadClientButtonKeys } = require('../dist/buttonVerify');
const { createButtonIssuer, oversizedButtonOptions, ButtonConfigError } = require('../dist/buttonIssuer');
const { config } = require('../dist/config');
const storage = new Storage(process.env.STORAGE_PATH);

let wamid = 0;
class FakeTransport {
  constructor() { this.sent = []; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  record(entry) { entry.wamid = `wamid.I${++wamid}`; this.sent.push(entry); return { messageId: entry.wamid }; }
  async sendMessage(to, text) { return this.record({ type: 'text', to, text }); }
  async sendInteractiveButtons(to, text, buttons) { return this.record({ type: 'buttons', to, text, buttons }); }
  async sendInteractiveList(to, text, buttonText, items) { return this.record({ type: 'list', to, text, buttonText, items }); }
}
const conversationOf = (decisionFlow) => ({ askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow,
  decisionTimeoutMinutes: 30, decisionTimeoutText: '', decisionTimeoutMode: 'message', decisionTimeoutNextStepId: '', invalidReplyText: '', flowRecoveryText: '',
  humanHandoffEnabled: false, humanHandoffText: '', humanHandoffPhone: '' });
const flow = (firstId = 'q1') => [
  { id: firstId, kind: 'question', presentation: 'buttons', text: 'First?', timeoutMinutes: 30, options: [{ id: 'o1', text: 'Yes', nextStepId: 'q2' }, { id: 'o2', text: 'No', nextStepId: 'q2' }] },
  { id: 'q2', kind: 'question', presentation: 'list', text: 'Second?', timeoutMinutes: 30, options: [{ id: 'l1', text: 'Alpha', nextStepId: 'end' }, { id: 'l2', text: 'Beta', nextStepId: 'end' }] },
  { id: 'end', kind: 'message', text: 'THE END' },
];
let seq = 0; let pseq = 0;
const campaignFor = (decisionFlow) => storage.addCampaign({ name: `C${++seq}`, triggerType: 1, triggerPhrase: `trigger-${seq}`, suffix: '', active: true, conversation: conversationOf(decisionFlow) });
const startRun = async (campaign, transport) => {
  const phone = `97250666${String(1000 + (pseq += 1))}`;
  await handleIncomingWhatsAppMessage({ id: `m${++seq}`, from: `whatsapp:${phone}`, body: campaign.triggerPhrase, hasUserSignal: true, isButtonReply: false,
    timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'T'; } }, storage, transport, 'webhook');
  return phone;
};
const lookups = {
  findResult: (id, phone) => storage.getResultsForPhoneKey(phone).find((r) => r.id === id),
  getCampaign: (id) => storage.getCampaigns().find((c) => c.id === id),
  getCurrentRun: (p) => storage.getCurrentRun(p),
};
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 6).join(' | ')]); }
}
const lines = [];
for (const level of ['log', 'warn', 'error']) { const o = console[level].bind(console); console[level] = (...a) => { lines.push(a.map(String).join(' ')); o(...a); }; }

(async () => {
  await scenario('off (default): ids are the option ids, exactly as before', async () => {
    setIssue(false);
    const transport = new FakeTransport(); const c = campaignFor(flow());
    await startRun(c, transport);
    assert.deepEqual(transport.sent.find((m) => m.type === 'buttons').buttons.map((b) => b.id), ['o1', 'o2']);
  });

  await scenario('on: the buttons carry v1 ids that the client verifies, signed for this result, step and option, valid 24 hours from now', async () => {
    setIssue(true);
    const transport = new FakeTransport(); const c = campaignFor(flow());
    const phone = await startRun(c, transport);
    const message = transport.sent.find((m) => m.type === 'buttons');
    const keys = loadClientButtonKeys(process.env);
    const run = storage.getCurrentRun(phone);
    assert.equal(message.buttons.length, 2);
    for (const [index, button] of message.buttons.entries()) {
      assert.ok(button.id.startsWith('v1.') && button.id.length <= 200, String(button.id.length));
      const v = verifyClientButton(button.id, phone, keys, lookups);
      assert.equal(v.kind, 'verified', JSON.stringify(v));
      assert.equal(v.claims.optionId, ['o1', 'o2'][index]); assert.equal(v.claims.stepId, 'q1'); assert.equal(v.claims.resultId, run.id);
      assert.ok(Math.abs(v.claims.exp * 1000 - (Date.now() + 24 * 3600_000)) < 60_000, 'exp is send time + 24h');
    }
  });

  await scenario('on: list rows are signed too; the visible titles are unchanged', async () => {
    setIssue(true);
    const transport = new FakeTransport(); const c = campaignFor(flow());
    const phone = await startRun(c, transport);
    const q1 = transport.sent.find((m) => m.type === 'buttons');
    // the flow still understands the plain option id as the answer (what the webhook hands it after verifying a signed tap)
    await handleIncomingWhatsAppMessage({ id: `a${++seq}`, from: `whatsapp:${phone}`, body: 'o1', hasUserSignal: true, isButtonReply: true, replyToMessageId: q1.wamid,
      timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'T'; } }, storage, transport, 'webhook');
    const list = transport.sent.find((m) => m.type === 'list');
    assert.ok(list, 'the second question was sent');
    const keys = loadClientButtonKeys(process.env);
    for (const item of list.items) assert.equal(verifyClientButton(item.id, phone, keys, lookups).kind, 'verified');
    assert.deepEqual(list.items.map((i) => i.text), ['1', '2'], 'titles untouched by signing');
  });

  await scenario('a step id that makes the id too long is a configuration error: alert, no legacy id, the question still goes out as text', async () => {
    setIssue(true);
    const before = lines.length;
    const transport = new FakeTransport(); const c = campaignFor(flow('q'.repeat(150)));
    await startRun(c, transport);
    assert.ok(!transport.sent.some((m) => m.type === 'buttons'), 'no buttons were sent');
    assert.ok(transport.sent.some((m) => m.type === 'text' && /First\?/.test(m.text)), 'the question went out as text');
    assert.ok(lines.slice(before).some((l) => l.includes('[BUTTON_V1_CONFIG_ERROR]')));
    assert.equal(oversizedButtonOptions(c.conversation).length, 2, 'save-time check names both options');
    assert.equal(oversizedButtonOptions(campaignFor(flow()).conversation).length, 0);
    setIssue(false);
    assert.deepEqual(oversizedButtonOptions(c.conversation), [], 'nothing is checked while issuing is off');
  });

  await scenario('half-configured (flag on, key missing / revoked / wrong kid) refuses to issue, and never falls back to legacy buttons', async () => {
    setIssue(true); delete process.env.META_BUTTON_FULL_KEYS;
    assert.throws(() => createButtonIssuer(process.env), ButtonConfigError);
    setIssue(true); delete process.env.META_BUTTON_CLIENT_ID;
    assert.throws(() => createButtonIssuer(process.env), ButtonConfigError);
    setIssue(true, { META_BUTTON_ISSUE_KID: 'nope' });
    assert.throws(() => createButtonIssuer(process.env), ButtonConfigError);
    setIssue(true, { META_BUTTON_REVOKED_KIDS: 'k1' });
    assert.throws(() => createButtonIssuer(process.env), ButtonConfigError);
    setIssue(false);
    assert.equal(createButtonIssuer(process.env), undefined);
    setIssue(true); delete process.env.META_BUTTON_FULL_KEYS;
    const before = lines.length;
    const transport = new FakeTransport(); const c = campaignFor(flow());
    await startRun(c, transport);
    assert.ok(!transport.sent.some((m) => m.type === 'buttons') && transport.sent.some((m) => m.type === 'text'), 'text fallback, not legacy buttons');
    assert.ok(lines.slice(before).some((l) => l.includes('[BUTTON_V1_CONFIG_ERROR]') || /falling back to text/.test(l)));
  });

  // Through the real webhook of the client: only the question she is on is answered.
  config.ADMIN_PORT = 0;
  setIssue(true);
  const server = require('../dist/adminServer').startAdminServer(storage);
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  const tap = async (phone, buttonId) => {
    n += 1; const id = `wamid.issue${n}`;
    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'x', display_phone_number: '15550001111' }, contacts: [{ wa_id: phone, profile: { name: 'T' } }],
      messages: [{ id, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId, title: 'Yes' } }, context: { id: 'wamid.Q' } }] } }] }] };
    const res = await fetch(base + '/internal/meta/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-token': 'synthetic-owner' }, body: JSON.stringify(payload) });
    assert.ok(res.status === 200 || res.status === 202);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !lines.some((l) => l.includes(id))) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 200));
    return lines.filter((l) => l.includes(id));
  };

  await scenario('webhook: a signed tap on the CURRENT question is an ordinary answer (the flow gets the option id)', async () => {
    setIssue(true);
    const transport = new FakeTransport(); const c = campaignFor(flow());
    const phone = await startRun(c, transport);
    const q1 = transport.sent.find((m) => m.type === 'buttons');
    const current = await tap(phone, q1.buttons[0].id);
    assert.ok(current.some((l) => l.includes('[META_V1_BUTTON_ANSWER]')), current.join(' | '));
    assert.ok(current.some((l) => l.includes('[META_INBOUND]') && l.includes(' o1 ')), 'the flow was handed the plain option id: ' + current.join(' | '));
  });

  await scenario('webhook: a signed tap on a question she has already moved past is verified but not acted on yet', async () => {
    setIssue(true);
    const transport = new FakeTransport(); const c = campaignFor(flow());
    const phone = await startRun(c, transport);
    const q1 = transport.sent.find((m) => m.type === 'buttons');
    // she answers q1 (through the fake transport, so the flow really moves on to the list question)
    await handleIncomingWhatsAppMessage({ id: `b${++seq}`, from: `whatsapp:${phone}`, body: 'o1', hasUserSignal: true, isButtonReply: true, replyToMessageId: q1.wamid,
      timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'T'; } }, storage, transport, 'webhook');
    assert.ok(transport.sent.some((m) => m.type === 'list'));
    const older = await tap(phone, q1.buttons[1].id);
    assert.ok(older.some((l) => l.includes('[META_V1_BUTTON_VERIFIED]') && l.includes('no_action_yet')), older.join(' | '));
    assert.ok(!older.some((l) => l.includes('[META_INBOUND]')), 'an older button is not run');
  });

  server.closeAllConnections(); server.close();
  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) { console.info(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.info(failed ? `\n${failed} scenario(s) FAILED` : `\nV1 button issuing tests passed (${results.length} scenarios).`);
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})().catch((e) => { console.error(e); process.exit(1); });
