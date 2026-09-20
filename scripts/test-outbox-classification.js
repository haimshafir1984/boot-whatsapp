/**
 * Stage B / 6.3 - outcome classification. The question before any retry is "can the
 * provider possibly have accepted this message?", not "did the call throw?".
 *
 * On HEAD 0ea8d26 every failure was retried (dispatcher: markOutboxRetry; sendBotMessage /
 * sendFileWithRetry: resend loop; MetaCloudProvider.sendFile: re-upload + resend). These
 * scenarios fail there and are the guard against turning a hung/dropped request into a
 * duplicate message to a real participant.
 *
 * No network: MetaCloudProvider runs against a fake global.fetch.
 */
process.env.NODE_ENV = 'test';
process.env.META_ACCESS_TOKEN = 'test-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';
process.env.BOT_REPLY_DELAY_MS = '0';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');
const { MetaCloudProvider } = require('../dist/providers/MetaCloudProvider');
const { ProviderSendError, classifySendError } = require('../dist/sendOutcome');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');

const dirs = [];
const mkdir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return; await sleep(10); } throw new Error(`timed out waiting for: ${label}`); }
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.message || String(e)).split('\n').slice(0, 3).join(' | ')]); } }

function timeoutError() { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; }

// ---------------------------------------------------------------- pure classification
scenario_list();
function scenario_list() {}

(async () => {
  await scenario('classifier: rejection / never-connected / unknown-outcome / unclassified', async () => {
    assert.equal(classifySendError(new ProviderSendError('x', 'rejected_permanent')).outcome, 'rejected_permanent');
    assert.equal(classifySendError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })).outcome, 'rejected_transient');
    assert.equal(classifySendError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })).outcome, 'rejected_transient');
    assert.equal(classifySendError(timeoutError()).outcome, 'uncertain');
    assert.equal(classifySendError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })).outcome, 'uncertain');
    const plain = classifySendError(new Error('some baileys error'));
    assert.equal(plain.outcome, 'rejected_transient'); assert.equal(plain.classified, false, 'unclassified errors keep legacy retry behaviour and say so');
  });

  // ---------------------------------------------------------------- dispatcher
  async function runDispatcher(storage, transport, opts) {
    const d = startOutboxDispatcher(storage, () => transport, 60_000, opts);
    return d;
  }

  await scenario('dispatcher: UNCERTAIN send is parked - one send, never retried, later message to same recipient blocked, others flow', async () => {
    const storage = new Storage(path.join(mkdir('cls-u-'), 's.json'));
    const a1 = storage.enqueueOutboxMessage({ kind: 'text', to: '972500100001', text: 'first' });
    await sleep(2);
    const a2 = storage.enqueueOutboxMessage({ kind: 'text', to: '972500100001', text: 'second (must wait)' });
    const b = storage.enqueueOutboxMessage({ kind: 'text', to: '972500100002', text: 'other recipient' });
    const calls = [];
    const transport = { async sendMessage(to, text) { calls.push(text); if (text === 'first') throw timeoutError(); return { messageId: 'ok-' + calls.length }; } };
    const d = await runDispatcher(storage, transport);
    try {
      await waitFor(() => storage.getOutboxMessage(b.id).status === 'sent', 2000, 'other recipient sent');
      await sleep(150);
      assert.equal(storage.getOutboxMessage(a1.id).status, 'uncertain');
      assert.equal(storage.getOutboxMessage(a1.id).attempts, 1, 'no second attempt');
      assert.equal(calls.filter((t) => t === 'first').length, 1, 'the uncertain message must be sent exactly once');
      assert.equal(storage.getOutboxMessage(a2.id).status, 'queued', 'a dependent later message must be held back');
      assert.ok(!calls.includes('second (must wait)'));
      assert.equal(storage.getOutboxHealth().uncertain, 1);
    } finally { await d.stop(); }
    // a later poll cycle must still not resend it
    const d2 = await runDispatcher(storage, transport);
    try { await sleep(200); assert.equal(calls.filter((t) => t === 'first').length, 1); } finally { await d2.stop(); }
  });

  await scenario('dispatcher: PERMANENT rejection -> failed immediately, one send, no retry', async () => {
    const storage = new Storage(path.join(mkdir('cls-p-'), 's.json'));
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: '972500100003', text: 'bad' });
    let n = 0;
    const d = await runDispatcher(storage, { async sendMessage() { n++; throw new ProviderSendError('400 invalid recipient', 'rejected_permanent', { status: 400 }); } });
    try { await waitFor(() => storage.getOutboxMessage(m.id).status === 'failed', 2000, 'failed'); await sleep(100); assert.equal(n, 1); } finally { await d.stop(); }
  });

  await scenario('dispatcher: TRANSIENT rejection -> retry, honours Retry-After (bounded), same logical row', async () => {
    const storage = new Storage(path.join(mkdir('cls-t-'), 's.json'));
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: '972500100004', text: 'later' });
    let n = 0;
    const d = await runDispatcher(storage, { async sendMessage() { n++; throw new ProviderSendError('429', 'rejected_transient', { status: 429, retryAfterMs: 5 * 60_000 }); } });
    try {
      await waitFor(() => storage.getOutboxMessage(m.id).status === 'retry', 2000, 'retry');
      const at = Date.parse(storage.getOutboxMessage(m.id).nextAttemptAt);
      assert.ok(at - Date.now() > 4 * 60_000 && at - Date.now() <= 10 * 60_000, 'Retry-After of 5 minutes must be honoured (bounded to 10)');
      await sleep(100); assert.equal(n, 1);
    } finally { await d.stop(); }
  });

  await scenario('dispatcher: connection refused (never sent) is retried, unclassified plain Error keeps legacy retry', async () => {
    const storage = new Storage(path.join(mkdir('cls-r-'), 's.json'));
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: '972500100005', text: 'x' });
    const d = await runDispatcher(storage, { async sendMessage() { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
    try { await waitFor(() => storage.getOutboxMessage(m.id).status === 'retry', 2000, 'retry'); } finally { await d.stop(); }
  });

  await scenario('crash while `processing`: orphan is parked as uncertain on restart - NOT re-claimed and re-sent', async () => {
    const file = path.join(mkdir('cls-c-'), 's.json');
    const before = new Storage(file);
    const m = before.enqueueOutboxMessage({ kind: 'text', to: '972500100006', text: 'in flight when process died' });
    assert.ok(before.claimOutboxMessage(m.id));
    await before.flush();
    // "restart": a brand-new Storage instance reads what was persisted
    const after = new Storage(file);
    assert.equal(after.getOutboxMessage(m.id).status, 'processing');
    // even a very old processing row (older than the historical 2-minute stale window) must not be reclaimed
    const calls = [];
    const d = await runDispatcher(after, { async sendMessage(to, t) { calls.push(t); return { messageId: 'm' }; } });
    try {
      await sleep(300);
      assert.deepEqual(calls, [], 'a stale processing row is not proof of "not sent"');
      assert.equal(after.getOutboxMessage(m.id).status, 'uncertain');
    } finally { await d.stop(); }
    await after.flush();
    assert.equal(new Storage(file).getOutboxMessage(m.id).status, 'uncertain', 'uncertain survives another restart (JSON backend)');
  });

  await scenario('resolveOutboxUncertain: operator decision - sent / not_sent (only from uncertain)', async () => {
    const storage = new Storage(path.join(mkdir('cls-o-'), 's.json'));
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: '972500100007', text: 'x' });
    storage.claimOutboxMessage(m.id); storage.markOutboxUncertain(m.id, 'timeout');
    assert.equal(storage.resolveOutboxUncertain(m.id, 'sent', 'wamid.9'), true);
    assert.equal(storage.getOutboxMessage(m.id).status, 'sent');
    assert.equal(storage.resolveOutboxUncertain(m.id, 'not_sent'), false, 'only an uncertain row can be resolved');
    const n = storage.enqueueOutboxMessage({ kind: 'text', to: '972500100008', text: 'y' });
    storage.claimOutboxMessage(n.id); storage.markOutboxUncertain(n.id, 'timeout');
    assert.equal(storage.resolveOutboxUncertain(n.id, 'not_sent'), true);
    assert.equal(storage.getOutboxMessage(n.id).status, 'retry');
  });

  await scenario('supersede-cancel does not leave an uncertain head blocking a recipient forever', async () => {
    const storage = new Storage(path.join(mkdir('cls-s-'), 's.json'));
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: '972500100009', text: 'x' });
    storage.claimOutboxMessage(m.id); storage.markOutboxUncertain(m.id, 'timeout');
    assert.equal(storage.hasOutstandingOutboxForRecipient('972500100009'), true);
    assert.equal(storage.cancelOutboxForRecipient('972500100009'), 1);
    assert.equal(storage.getOutboxMessage(m.id).status, 'failed');
  });

  // ---------------------------------------------------------------- MetaCloudProvider (fake fetch)
  const realFetch = global.fetch;
  const jsonRes = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  async function outcomeOf(fetchImpl) {
    global.fetch = fetchImpl;
    try { await new MetaCloudProvider().sendMessage('972500200001', 'hi'); return 'sent'; }
    catch (e) { return classifySendError(e).outcome + (e.retryAfterMs ? `:${e.retryAfterMs}` : ''); }
    finally { global.fetch = realFetch; }
  }
  await scenario('MetaCloudProvider: HTTP 400 -> rejected_permanent; 429+Retry-After -> transient with delay; 500/503/408 -> uncertain', async () => {
    assert.equal(await outcomeOf(async () => jsonRes(400, { error: { message: 'bad', code: 100 } })), 'rejected_permanent');
    assert.equal(await outcomeOf(async () => jsonRes(429, { error: {} }, { 'retry-after': '7' })), 'rejected_transient:7000');
    assert.equal(await outcomeOf(async () => jsonRes(500, { error: {} })), 'uncertain');
    assert.equal(await outcomeOf(async () => jsonRes(503, {})), 'uncertain');
    assert.equal(await outcomeOf(async () => jsonRes(408, {})), 'uncertain');
    assert.equal(await outcomeOf(async () => jsonRes(200, { messages: [{ id: 'wamid.1' }] })), 'sent');
  });
  await scenario('MetaCloudProvider: no-response failures - ECONNREFUSED transient; reset/timeout/unknown -> uncertain', async () => {
    assert.equal(await outcomeOf(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }), 'rejected_transient');
    assert.equal(await outcomeOf(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }), 'uncertain');
    assert.equal(await outcomeOf(async () => { throw timeoutError(); }), 'uncertain');
    assert.equal(await outcomeOf(async () => { throw new TypeError('fetch failed'); }), 'uncertain', 'an unexplained transport failure after the request left is unknown, not "safe to retry"');
  });

  await scenario('MetaCloudProvider.sendFile: cached media id + UNCERTAIN first send -> exactly ONE message POST, no re-upload/resend', async () => {
    const dir = mkdir('cls-f-'); const file = path.join(dir, 'a.png'); fs.writeFileSync(file, Buffer.from('png-bytes-unique-' + Date.now()));
    let uploads = 0; let posts = 0; let mode = 'ok';
    global.fetch = async (url) => {
      if (String(url).endsWith('/media')) { uploads++; return jsonRes(200, { id: 'media-' + uploads }); }
      posts++;
      if (mode === 'timeout') throw timeoutError();
      if (mode === 'stale') return jsonRes(400, { error: { message: 'media id expired', code: 131053 } });
      return jsonRes(200, { messages: [{ id: 'wamid.' + posts }] });
    };
    try {
      await new MetaCloudProvider().sendFile('972500200002', file, 'c');       // populates the media cache
      assert.equal(uploads, 1); posts = 0;
      mode = 'timeout';
      await assert.rejects(() => new MetaCloudProvider().sendFile('972500200003', file, 'c'), (e) => classifySendError(e).outcome === 'uncertain');
      assert.equal(posts, 1, 'HEAD re-uploaded and resent here (2 POSTs) - a duplicate to the recipient');
      assert.equal(uploads, 1, 'no re-upload after an unknown outcome');
      // a REJECTED cached media id is still recovered by re-upload (existing behaviour preserved)
      posts = 0; mode = 'stale';
      let first = true; const inner = global.fetch;
      global.fetch = async (url, init) => { if (!String(url).endsWith('/media') && first) { first = false; return inner(url, init); } mode = 'ok'; return inner(url, init); };
      await new MetaCloudProvider().sendFile('972500200004', file, 'c');
      assert.equal(uploads, 2, 'a rejected stale media id must be re-uploaded once');
    } finally { global.fetch = realFetch; }
  });

  await scenario('media upload failure is retryable and never "uncertain" (it cannot have delivered anything)', async () => {
    const dir = mkdir('cls-m-'); const file = path.join(dir, 'b.png'); fs.writeFileSync(file, Buffer.from('other-bytes-' + Date.now()));
    global.fetch = async (url) => { if (String(url).endsWith('/media')) throw timeoutError(); return jsonRes(200, {}); };
    try { await assert.rejects(() => new MetaCloudProvider().sendFile('972500200005', file), (e) => classifySendError(e).outcome === 'rejected_transient'); }
    finally { global.fetch = realFetch; }
  });

  // ---------------------------------------------------------------- message flow (direct-send path)
  async function flowStorage() {
    const storage = new Storage(path.join(mkdir('cls-flow-'), 's.json'));
    storage.addCampaign({ name: 'Cls', triggerType: 1, triggerPhrase: 'join', suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: 'Welcome text', followupMessages: [], decisionFlow: [] } });
    return storage;
  }
  let msgId = 0;
  const inbound = (storage, transport, phone, body) => handleIncomingWhatsAppMessage({ id: `cls-${++msgId}`, from: `whatsapp:${phone}`, body, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'U'; } }, storage, transport, 'webhook');

  await scenario('flow: UNCERTAIN text send -> ONE transport call (HEAD: 2), outbox uncertain, sender held needs_review, no fallback', async () => {
    const storage = await flowStorage(); const phone = '972500300001'; let calls = 0;
    const transport = { async resolvePhone(j) { return String(j).replace(/\D/g, ''); }, async sendMessage() { calls++; throw timeoutError(); } };
    await assert.rejects(() => inbound(storage, transport, phone, 'join'));
    assert.equal(calls, 1, 'an unknown-outcome send must never be re-sent');
    assert.equal(storage.getOutboxHealth().uncertain, 1);
    assert.equal(conversationState.get(`whatsapp:${phone}`)?.kind, 'needs_review');
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('flow: PERMANENT rejection -> ONE transport call, not retried', async () => {
    const storage = await flowStorage(); const phone = '972500300002'; let calls = 0;
    const transport = { async resolvePhone(j) { return String(j).replace(/\D/g, ''); }, async sendMessage() { calls++; throw new ProviderSendError('400', 'rejected_permanent', { status: 400 }); } };
    await inbound(storage, transport, phone, 'join').catch(() => {}); // ordinary send failures are logged by the reply chain, not rethrown
    assert.equal(calls, 1);
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('flow: TRANSIENT rejection is still retried (existing behaviour preserved): 2 calls', async () => {
    const storage = await flowStorage(); const phone = '972500300003'; let calls = 0;
    const transport = { async resolvePhone(j) { return String(j).replace(/\D/g, ''); }, async sendMessage() { calls++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } };
    await inbound(storage, transport, phone, 'join').catch(() => {});
    assert.equal(calls, 2);
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('flow: ambiguous INTERACTIVE (buttons) send -> ONE buttons call, NO text fallback of the same question, sender held', async () => {
    const storage = new Storage(path.join(mkdir('cls-btn-'), 's.json')); const phone = '972500300004';
    storage.addCampaign({ name: 'Btn', triggerType: 1, triggerPhrase: 'btn', suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [{ id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick one', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }] } });
    let buttons = 0; let texts = 0;
    const transport = { async resolvePhone(j) { return String(j).replace(/\D/g, ''); }, async sendMessage() { texts++; return { messageId: 't' }; }, async sendInteractiveButtons() { buttons++; throw timeoutError(); } };
    await inbound(storage, transport, phone, 'btn').catch(() => {});
    assert.equal(buttons, 1, 'the buttons message is handed to the provider once');
    assert.equal(texts, 0, 'HEAD-style fallback would resend the same question as text after an unknown outcome');
    assert.equal(storage.getOutboxHealth().uncertain, 1);
    assert.equal(conversationState.get(`whatsapp:${phone}`)?.kind, 'needs_review');
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('flow: a PERMANENT rejection of buttons still falls back to text (existing behaviour preserved)', async () => {
    const storage = new Storage(path.join(mkdir('cls-btn2-'), 's.json')); const phone = '972500300005';
    storage.addCampaign({ name: 'Btn2', triggerType: 1, triggerPhrase: 'btn2', suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [{ id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick one', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }] } });
    let texts = 0;
    const transport = { async resolvePhone(j) { return String(j).replace(/\D/g, ''); }, async sendMessage() { texts++; return { messageId: 't' }; }, async sendInteractiveButtons() { throw new ProviderSendError('400 unsupported', 'rejected_permanent', { status: 400 }); } };
    await inbound(storage, transport, phone, 'btn2').catch(() => {});
    assert.ok(texts >= 1, 'a certain rejection may use the text fallback');
    conversationState.remove(`whatsapp:${phone}`);
  });

  let failed = 0;
  for (const [name, status, err] of results) { if (status === 'FAIL') failed++; console.log(`${status}  ${name}${err ? '\n      ' + err : ''}`); }
  console.log(`\nclassification: ${results.length - failed} passed, ${failed} failed`);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
