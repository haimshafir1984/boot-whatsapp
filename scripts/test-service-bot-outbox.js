/**
 * Stage B2 / step 2 - the service bot used to call the transport directly (12 sites + follow-ups), i.e. without an
 * outbox row, without an attempt id and without outcome classification. Decision: it now goes through the outbox.
 *
 * Proven here: every service-bot send (text, buttons, list, follow-up) leaves ONE outbox row with an attempt id;
 * over MetaCloudProvider each POST carries that id (when tagging is on); an unknown outcome is parked and NOT resent;
 * a rejected send is not retried blindly; non-service-bot behaviour is unchanged (idempotent wrapper).
 */
process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.META_ACCESS_TOKEN = 'test-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';
process.env.META_ATTEMPT_CALLBACK_DATA = 'on';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config } = require('../dist/config');
const { emptyStorageData, Storage } = require('../dist/storage');
const { tryHandleServiceBotMessage, deliverServiceBotFollowUp } = require('../dist/serviceBot');
const { createOutboxTrackedTransport } = require('../dist/messageFlow');
const { MetaCloudProvider } = require('../dist/providers/MetaCloudProvider');
const { ProviderSendError } = require('../dist/sendOutcome');
const { conversationState } = require('../dist/conversationState');

config.CLIENT_SERVICE_BOT_ENABLED = true;
const dirs = []; const realFetch = global.fetch;
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.message || String(e)).split('\n').slice(0, 3).join(' | ')]); } finally { global.fetch = realFetch; } }
const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

function makeStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-outbox-')); dirs.push(dir);
  const storage = new Storage(path.join(dir, 's.json'), { initialData: emptyStorageData() });
  storage.updateServiceBot({
    enabled: true, name: 'SB', triggerText: 'sbmenu', mainMenuNodeId: 'main', fallbackText: 'fallback',
    nodes: [
      { id: 'main', title: 'Main', type: 'menu', text: 'How can we help?', options: [{ id: 'a', label: 'Info', targetNodeId: 'info' }, { id: 'b', label: 'Other', targetNodeId: 'info' }] },
      { id: 'info', title: 'Info', type: 'message', text: 'Some information' },
    ],
  });
  return storage;
}
const fakeTransport = (sent) => ({
  async resolvePhone(j) { return String(j).split('@')[0]; },
  async sendMessage(to, text) { sent.push(['text', text]); return { messageId: 'w' + sent.length }; },
  async sendInteractiveButtons(to, text, items) { sent.push(['buttons', text]); return { messageId: 'w' + sent.length }; },
  async sendInteractiveList(to, text, bt, items) { sent.push(['list', text]); return { messageId: 'w' + sent.length }; },
});

(async () => {
  await scenario('every service-bot send leaves an outbox row with an attempt id (buttons for the menu, text for the info node)', async () => {
    const storage = makeStorage(); const sent = []; const t = fakeTransport(sent);
    assert.equal(await tryHandleServiceBotMessage('sbmenu', 'whatsapp:972500800001', '972500800001', storage, t), true);
    await tryHandleServiceBotMessage('1', 'whatsapp:972500800001', '972500800001', storage, t);
    const rows = storage.getOutboxMessages(20).reverse();
    assert.ok(rows.length >= 2 && rows.length === sent.length, `rows ${rows.length} vs sends ${sent.length}`);
    assert.ok(rows.every((r) => r.status === 'sent' && /^fba1_/.test(r.attemptId) && r.providerMessageId), 'each send: sent row + attempt id + provider id');
    assert.deepEqual(rows.map((r) => r.kind).slice(0, 1), ['interactive_buttons']);
    conversationState.removeByPhone('972500800001');
  });

  await scenario('over MetaCloudProvider each service-bot POST carries the attempt id of ITS outbox row', async () => {
    const storage = makeStorage(); const bodies = [];
    global.fetch = async (url, init) => { const b = JSON.parse(init.body); if (b.to) bodies.push(b); return ok({ messages: [{ id: 'wamid.' + bodies.length }] }); };
    await tryHandleServiceBotMessage('sbmenu', 'whatsapp:972500800002', '972500800002', storage, new MetaCloudProvider());
    assert.ok(bodies.length >= 1);
    for (const b of bodies) { const found = storage.findOutboxByAttemptId(b.biz_opaque_callback_data); assert.ok(found, 'tag resolves to a row'); assert.equal(found.attempt.status, 'accepted'); }
    conversationState.removeByPhone('972500800002');
  });

  await scenario('unknown outcome (timeout) on a service-bot send: ONE POST, row parked uncertain, NOT resent, error surfaces (sender held upstream)', async () => {
    const storage = makeStorage(); let posts = 0;
    global.fetch = async (url, init) => { const b = JSON.parse(init.body); if (!b.to) return ok({}); posts++; const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
    await assert.rejects(() => tryHandleServiceBotMessage('sbmenu', 'whatsapp:972500800003', '972500800003', storage, new MetaCloudProvider()), (e) => e.outcome === 'uncertain');
    assert.equal(posts, 1, 'the service bot must not resend after an unknown outcome');
    assert.equal(storage.getOutboxHealth().uncertain, 1);
    conversationState.removeByPhone('972500800003');
  });

  await scenario('a rejected (4xx) service-bot send is recorded failed with its attempt and is not retried', async () => {
    const storage = makeStorage(); let calls = 0;
    const t = { ...fakeTransport([]), async sendInteractiveButtons() { calls++; throw new ProviderSendError('400', 'rejected_permanent', { status: 400 }); }, async sendMessage() { calls++; throw new ProviderSendError('400', 'rejected_permanent', { status: 400 }); } };
    await tryHandleServiceBotMessage('sbmenu', 'whatsapp:972500800004', '972500800004', storage, t).catch(() => {});
    assert.ok(calls >= 1);
    const rows = storage.getOutboxMessages(10);
    assert.ok(rows.every((r) => r.status === 'failed' && r.attemptLog.length === 1), 'one attempt each, no blind retry');
    conversationState.removeByPhone('972500800004');
  });

  await scenario('follow-up delivery is tracked too', async () => {
    const storage = makeStorage(); const sent = []; const t = fakeTransport(sent);
    await tryHandleServiceBotMessage('sbmenu', 'whatsapp:972500800005', '972500800005', storage, t);
    const session = storage.getServiceBotSession('972500800005'); const bot = storage.getServiceBots()[0];
    const before = storage.getOutboxMessages(50).length;
    await deliverServiceBotFollowUp({ id: 'f1', botId: bot.id, phone: '972500800005', to: 'whatsapp:972500800005', nodeId: session.nodeId, text: 'reminder', runAt: new Date().toISOString() }, storage, t);
    const rows = storage.getOutboxMessages(50);
    assert.equal(rows.length, before + 1); assert.ok(rows.some((r) => r.text === 'reminder' && r.status === 'sent' && r.attemptId));
    conversationState.removeByPhone('972500800005');
  });

  await scenario('wrapper is idempotent, passes other methods through, and does not invent interactive support', async () => {
    const storage = makeStorage(); const base = { async resolvePhone() { return 'x'; }, async sendMessage() { return { messageId: 'm' }; } };
    const w = createOutboxTrackedTransport(storage, base);
    assert.equal(createOutboxTrackedTransport(storage, w), w, 'no double wrapping');
    assert.equal(w.sendInteractiveButtons, undefined, 'a transport without buttons still has none (the service bot falls back to text)');
    assert.equal(await w.resolvePhone(), 'x');
  });

  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log('service-bot-outbox: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
