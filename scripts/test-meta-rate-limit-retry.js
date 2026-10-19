/**
 * Meta rate limits arrive as HTTP 400 with an error.code (130429 throughput, 131056 business/consumer pair limit, 80007 ...), not as 429.
 * They used to be classified rejected_permanent, so the message was lost (18.10.2026, 2 of 7,810 outbound messages in the Focus campaign).
 * They are refusals - Meta accepted nothing - so a bounded wait-and-retry is safe; everything else keeps its old behaviour.
 *
 * No network: MetaCloudProvider runs against a fake global.fetch; the flow runs against a fake transport.
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
const { MetaCloudProvider } = require('../dist/providers/MetaCloudProvider');
const { ProviderSendError, classifySendError, classifyMetaApiResponse, sendRetryDelayMs, rateLimitRetryAllowed, RATE_LIMIT_SEND_ATTEMPTS, RATE_LIMIT_MAX_WAIT_MS } = require('../dist/sendOutcome');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');

const dirs = [];
const mkdir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 4).join(' | ')]); }
}
const rateLimited = (code = 130429) => new ProviderSendError(`Meta message failed (400): code ${code}`, 'rejected_transient', { status: 400, rateLimited: true, metaCode: code, retryAfterMs: 5 });

(async () => {
  await scenario('classifier: rate-limit codes on HTTP 400 are transient with a wait hint; other 400s stay permanent', async () => {
    for (const [code, hint] of [[130429, 5000], [131056, 8000]]) {
      const c = classifyMetaApiResponse(400, { error: { code } });
      assert.equal(c.outcome, 'rejected_transient', `code ${code}`);
      assert.equal(c.rateLimited, true);
      assert.equal(c.retryAfterMs, hint);
    }
    assert.equal(classifyMetaApiResponse(400, { error: { code: 131026 } }).outcome, 'rejected_permanent', 'undeliverable is final');
    assert.equal(classifyMetaApiResponse(400, { error: { code: 131048 } }).outcome, 'rejected_permanent', 'spam rate limit is an account-quality problem: never retried');
    for (const unverified of [4, 17, 613, 80007]) assert.equal(classifyMetaApiResponse(400, { error: { code: unverified } }).outcome, 'rejected_permanent', `code ${unverified} is not in the verified list`);
    assert.equal(classifyMetaApiResponse(400, { error: { code: 131053 } }).outcome, 'rejected_permanent', 'media errors stay final');
    assert.equal(classifyMetaApiResponse(400, { error: { code: 100 } }).outcome, 'rejected_permanent');
    assert.equal(classifyMetaApiResponse(400, {}).outcome, 'rejected_permanent');
    assert.equal(classifyMetaApiResponse(500, { error: { code: 130429 } }).outcome, 'uncertain', 'a 5xx is never downgraded to "safe to retry" by its code');
    const c429 = classifyMetaApiResponse(429, {}, 7000);
    assert.equal(c429.outcome, 'rejected_transient');
    assert.equal(c429.retryAfterMs, 7000, 'a Retry-After header wins over the hint');
    assert.equal(classifyMetaApiResponse(400, { error: { code: 130429 } }, 9000).retryAfterMs, 9000);
  });

  await scenario('retry delay: fixed delay normally; Retry-After / hint for a rate limit, never below the base and never above the cap', async () => {
    assert.equal(sendRetryDelayMs(new ProviderSendError('x', 'rejected_transient'), 3000), 3000);
    assert.equal(sendRetryDelayMs(new Error('plain'), 3000), 3000);
    assert.equal(sendRetryDelayMs(rateLimited(), 3000), 3000, 'a tiny hint never shortens the base delay');
    assert.equal(sendRetryDelayMs(new ProviderSendError('x', 'rejected_transient', { rateLimited: true, retryAfterMs: 9000 }), 3000), 9000);
    assert.equal(sendRetryDelayMs(new ProviderSendError('x', 'rejected_transient', { rateLimited: true, retryAfterMs: 5 * 60_000 }), 3000), RATE_LIMIT_MAX_WAIT_MS);
  });

  const realFetch = global.fetch;
  const jsonRes = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  async function errOf(fetchImpl) {
    global.fetch = fetchImpl;
    try { await new MetaCloudProvider().sendMessage('972500200001', 'hi'); return null; } catch (e) { return e; } finally { global.fetch = realFetch; }
  }
  await scenario('MetaCloudProvider: real Meta shape - HTTP 400 {error:{code:130429}} -> transient + rateLimited; 131026 -> permanent', async () => {
    const e1 = await errOf(async () => jsonRes(400, { error: { message: '(#130429) Rate limit hit', code: 130429, type: 'OAuthException' } }));
    assert.equal(classifySendError(e1).outcome, 'rejected_transient');
    assert.equal(e1.rateLimited, true);
    assert.equal(e1.retryAfterMs, 5000);
    const e2 = await errOf(async () => jsonRes(400, { error: { message: '(#131056) pair rate limit hit', code: 131056 } }));
    assert.equal(e2.rateLimited, true);
    assert.equal(e2.retryAfterMs, 8000);
    const e3 = await errOf(async () => jsonRes(400, { error: { message: 'undeliverable', code: 131026 } }));
    assert.equal(classifySendError(e3).outcome, 'rejected_permanent');
    assert.equal(e3.rateLimited, false);
    const e4 = await errOf(async () => jsonRes(429, { error: {} }, { 'retry-after': '7' }));
    assert.equal(e4.rateLimited, true);
    assert.equal(e4.retryAfterMs, 7000);
  });

  // ---------------------------------------------------------------- message flow
  let msgN = 0;
  const inbound = (storage, transport, phone, body) => handleIncomingWhatsAppMessage({ id: `rl-${++msgN}`, from: `whatsapp:${phone}`, body, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'U'; } }, storage, transport, 'webhook');
  const textStorage = () => {
    const s = new Storage(path.join(mkdir('rl-flow-'), 's.json'));
    s.addCampaign({ name: 'RL', triggerType: 1, triggerPhrase: 'join', suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: 'Welcome text', followupMessages: [], decisionFlow: [] } });
    return s;
  };
  const base = { async resolvePhone(j) { return String(j).replace(/\D/g, ''); } };

  await scenario('flow text: rate-limited twice then accepted -> 3 calls, the message is accepted exactly once', async () => {
    const storage = textStorage();
    const phone = '972500400001';
    let calls = 0;
    const accepted = [];
    const transport = { ...base, async sendMessage(to, text) { calls++; if (calls <= 2) throw rateLimited(); accepted.push(text); return { messageId: 'ok' }; } };
    await inbound(storage, transport, phone, 'join');
    assert.equal(calls, 3);
    assert.equal(accepted.length, 1, 'accepted once, never duplicated');
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('flow text: a rate limit that never clears is bounded to RATE_LIMIT_SEND_ATTEMPTS calls (not infinite)', async () => {
    const storage = textStorage();
    const phone = '972500400002';
    let calls = 0;
    const transport = { ...base, async sendMessage() { calls++; throw rateLimited(131056); } };
    await inbound(storage, transport, phone, 'join').catch(() => {});
    assert.equal(calls, RATE_LIMIT_SEND_ATTEMPTS);
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('flow text: an ordinary permanent 400 is still NOT retried (1 call); ordinary transient keeps its 2-call budget', async () => {
    const s1 = textStorage();
    let a = 0;
    const p1 = '972500400003';
    await inbound(s1, { ...base, async sendMessage() { a++; throw new ProviderSendError('400', 'rejected_permanent', { status: 400 }); } }, p1, 'join').catch(() => {});
    assert.equal(a, 1);
    conversationState.remove(`whatsapp:${p1}`);
    const s2 = textStorage();
    let b = 0;
    const p2 = '972500400004';
    await inbound(s2, { ...base, async sendMessage() { b++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } }, p2, 'join').catch(() => {});
    assert.equal(b, 2);
    conversationState.remove(`whatsapp:${p2}`);
  });

  await scenario('flow buttons: rate-limited twice then accepted -> 3 button calls, NO text fallback of the same question', async () => {
    const storage = new Storage(path.join(mkdir('rl-btn-'), 's.json'));
    const phone = '972500400005';
    storage.addCampaign({ name: 'RLB', triggerType: 1, triggerPhrase: 'btn', suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [{ id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick one', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }] } });
    let buttons = 0;
    let texts = 0;
    const transport = { ...base, async sendMessage() { texts++; return { messageId: 't' }; }, async sendInteractiveButtons() { buttons++; if (buttons <= 2) throw rateLimited(); return { messageId: 'b' }; } };
    await inbound(storage, transport, phone, 'btn');
    assert.equal(buttons, 3);
    assert.equal(texts, 0);
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('MetaCloudProvider.sendFile: cached media id + 130429 -> exactly ONE message POST, no re-upload (a rate limit is not a stale media id)', async () => {
    const dir = mkdir('rl-file-');
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, Buffer.from('png-bytes-rl-' + Date.now()));
    let uploads = 0;
    let posts = 0;
    let mode = 'ok';
    global.fetch = async (url) => {
      if (String(url).endsWith('/media')) { uploads++; return jsonRes(200, { id: 'media-' + uploads }); }
      posts++;
      if (mode === 'limit') return jsonRes(400, { error: { message: '(#130429) Rate limit hit', code: 130429 } });
      return jsonRes(200, { messages: [{ id: 'wamid.' + posts }] });
    };
    try {
      await new MetaCloudProvider().sendFile('972500200002', file, 'c');   // populates the media cache
      assert.equal(uploads, 1);
      posts = 0;
      mode = 'limit';
      await assert.rejects(() => new MetaCloudProvider().sendFile('972500200003', file, 'c'), (e) => e.rateLimited === true);
      assert.equal(posts, 1, 'a rate-limit refusal must not trigger a second POST inside the same attempt');
      assert.equal(uploads, 1, 'and must not re-upload the media');
    } finally { global.fetch = realFetch; }
  });

  await scenario('flow buttons: every retry is its OWN durable attempt (one attempt = one POST); the refused attempt is persisted as `retry` between sends', async () => {
    const dir = mkdir('rl-attempt-');
    const file = path.join(dir, 's.json');
    const storage = new Storage(file);
    const phone = '972500400006';
    storage.addCampaign({ name: 'RLA', triggerType: 1, triggerPhrase: 'att', suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [{ id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick one', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }] } });
    const seen = [];
    let persistedBetween = null;
    const rowOf = () => storage.getOutboxMessages(50).find((m) => m.kind === 'interactive_buttons');
    const transport = { ...base, async sendMessage() { return { messageId: 't' }; },
      async sendInteractiveButtons() {
        const row = rowOf();
        seen.push({ attempts: row.attempts, attemptId: storage.getOutboxAttemptId(row.id), status: row.status });
        if (seen.length === 1) {
          // 1.5s into the 3s wait: a process that stopped now would find the row persisted as `retry` with ONE attempt, not `processing`.
          setTimeout(() => { const r = new Storage(file).getOutboxMessages(50).find((m) => m.kind === 'interactive_buttons'); persistedBetween = r && { status: r.status, attempts: r.attempts }; }, 1500);
          throw rateLimited();
        }
        return { messageId: 'b' };
      } };
    await inbound(storage, transport, phone, 'att');
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((x) => x.attempts), [1, 2], 'a new attempt (claim) per POST');
    assert.notEqual(seen[0].attemptId, seen[1].attemptId, 'a fresh attempt id per POST');
    assert.ok(seen.every((x) => x.status === 'processing'));
    assert.deepEqual(persistedBetween, { status: 'retry', attempts: 1 });
    assert.equal(rowOf().status, 'sent');
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('Retry-After longer than the budget is NOT undercut: no early inline retry (1 call)', async () => {
    assert.equal(rateLimitRetryAllowed(new ProviderSendError('x', 'rejected_transient', { rateLimited: true, retryAfterMs: RATE_LIMIT_MAX_WAIT_MS + 1 })), false);
    assert.equal(rateLimitRetryAllowed(new ProviderSendError('x', 'rejected_transient', { rateLimited: true, retryAfterMs: RATE_LIMIT_MAX_WAIT_MS })), true);
    const storage = textStorage();
    const phone = '972500400007';
    let calls = 0;
    const transport = { ...base, async sendMessage() { calls++; throw new ProviderSendError('429', 'rejected_transient', { status: 429, rateLimited: true, retryAfterMs: 5 * 60_000 }); } };
    await inbound(storage, transport, phone, 'join').catch(() => {});
    assert.equal(calls, 1, 'retrying 5 minutes early would just hit the limit again');
    conversationState.remove(`whatsapp:${phone}`);
  });

  global.fetch = realFetch;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) {
    console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`);
    if (status !== 'PASS') failed++;
  }
  console.log(failed ? `\n${failed} scenario(s) FAILED` : '\nRate-limit retry tests passed.');
  setImmediate(() => process.exit(failed ? 1 : 0));
})();
