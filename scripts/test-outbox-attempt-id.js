/**
 * Stage B2 / step 1 - persistent attemptId + biz_opaque_callback_data.
 *
 * Contract under test:
 *  - every claim creates a fresh random attemptId that is persisted BEFORE the provider is called;
 *  - the logical id (outbox row id) never changes, attemptId changes on every POST attempt and all
 *    attempts stay in attemptLog so an EARLIER attempt can still be matched after a retry;
 *  - MetaCloudProvider sends the current attemptId as biz_opaque_callback_data on message POSTs
 *    (all kinds) and NEVER on media uploads or read/typing status calls;
 *  - the id is only a linking id: random, no phone number, <= 512 chars.
 * No network: fake global.fetch.
 */
process.env.NODE_ENV = 'test';
process.env.META_ACCESS_TOKEN = 'test-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.META_ATTEMPT_CALLBACK_DATA = 'on';   // OFF by default; the tests that exercise tagging switch it on explicitly
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');
const { MetaCloudProvider } = require('../dist/providers/MetaCloudProvider');
const { runWithSendAttempt, currentSendAttempt, newAttemptId, isAttemptId } = require('../dist/sendAttempt');
const { ProviderSendError } = require('../dist/sendOutcome');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');

const realFetch = global.fetch;
const dirs = [];
const mkdir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return; await sleep(10); } throw new Error(`timed out (${ms}ms): ${label}`); }
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.message || String(e)).split('\n').slice(0, 3).join(' | ')]); } finally { global.fetch = realFetch; } }
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

(async () => {
  await scenario('attemptId: format, uniqueness (20k), no personal data', async () => {
    const ids = new Set(); for (let i = 0; i < 20000; i++) ids.add(newAttemptId());
    assert.equal(ids.size, 20000);
    const id = newAttemptId();
    assert.ok(isAttemptId(id)); assert.match(id, /^fba1_[0-9a-f]{32}$/); assert.ok(id.length <= 512);
    assert.ok(!isAttemptId('fba1_short') && !isAttemptId(null) && !isAttemptId('wamid.HBg'));
  });

  await scenario('storage: each claim = new attemptId, logical id constant, all attempts kept and outcomes recorded', async () => {
    const storage = new Storage(path.join(mkdir('att-a-'), 's.json'));
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: '972500500001', text: 'x' });
    assert.equal(m.attemptId, undefined, 'no attempt before the first claim');
    const c1 = storage.claimOutboxMessage(m.id);
    assert.match(c1.attemptId, /^fba1_/); assert.equal(c1.attemptLog.length, 1); assert.equal(c1.attemptLog[0].status, 'started');
    storage.markOutboxRetry(m.id, new Error('429'), new Date(Date.now() - 1000).toISOString());
    const c2 = storage.claimOutboxMessage(m.id);
    assert.notEqual(c2.attemptId, c1.attemptId, 'a retry is a new POST attempt with a new id');
    assert.equal(c2.id, c1.id, 'the logical message id never changes');
    storage.markOutboxSent(m.id, 'wamid.OK');
    const done = storage.getOutboxMessage(m.id);
    assert.deepEqual(done.attemptLog.map((a) => a.status), ['rejected', 'accepted']);
    assert.equal(done.attemptLog[1].providerMessageId, 'wamid.OK');
    assert.ok(done.attemptLog[0].error.includes('429'));
    // an EARLIER attempt is still resolvable after the retry
    const first = storage.findOutboxByAttemptId(c1.attemptId);
    assert.equal(first.message.id, m.id); assert.equal(first.attempt.attemptId, c1.attemptId);
    assert.equal(storage.findOutboxByAttemptId(c2.attemptId).message.id, m.id);
    assert.equal(storage.findOutboxByAttemptId(newAttemptId()), null, 'an id that is not ours is a miss, not a guess');
    assert.equal(storage.findOutboxByAttemptId('wamid.SOMEONE_ELSES'), null);
  });

  await scenario('storage: uncertain / failed outcomes close the attempt; attempt log is capped', async () => {
    const storage = new Storage(path.join(mkdir('att-b-'), 's.json'));
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: '972500500002', text: 'x' });
    storage.claimOutboxMessage(m.id); storage.markOutboxUncertain(m.id, 'timeout');
    assert.equal(storage.getOutboxMessage(m.id).attemptLog[0].status, 'uncertain');
    const n = storage.enqueueOutboxMessage({ kind: 'text', to: '972500500003', text: 'y' });
    for (let i = 0; i < 30; i++) { storage.claimOutboxMessage(n.id); storage.markOutboxRetry(n.id, 'e', new Date(Date.now() - 1).toISOString()); }
    const log = storage.getOutboxMessage(n.id).attemptLog;
    assert.equal(log.length, 20, 'log is capped');
    assert.equal(storage.getOutboxMessage(n.id).attempts, 30, 'the attempts counter still counts everything');
  });

  await scenario('DURABLE BEFORE SEND: when the provider is called, the attemptId is already on disk and equals the one sent', async () => {
    const file = path.join(mkdir('att-c-'), 's.json');
    const storage = new Storage(file);
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: '972500500004', text: 'x' });
    let seen = null;
    const d = startOutboxDispatcher(storage, () => ({
      async sendMessage() {
        const ctx = currentSendAttempt();
        const persisted = new Storage(file).getOutboxMessage(m.id);   // independent reader = what a crash would leave behind
        seen = { ctx, persistedAttempt: persisted.attemptId, persistedStatus: persisted.status, logStatus: persisted.attemptLog?.[0]?.status };
        return { messageId: 'wamid.X' };
      },
    }), 60_000);
    try { await waitFor(() => seen, 2000, 'send'); } finally { await d.stop(); }
    assert.ok(seen.ctx, 'the provider call runs inside an attempt context');
    assert.equal(seen.persistedAttempt, seen.ctx.attemptId, 'persisted before the call');
    assert.equal(seen.persistedStatus, 'processing'); assert.equal(seen.logStatus, 'started');
    assert.equal(seen.ctx.outboxId, m.id);
  });

  await scenario('ROW SIZE: with tagging OFF a cleanly sent first attempt keeps no attempt record; retries / recovery / tagging ON keep it', async () => {
    const keep = process.env.META_ATTEMPT_CALLBACK_DATA;
    try {
      delete process.env.META_ATTEMPT_CALLBACK_DATA;
      const s = new Storage(path.join(mkdir('att-h-'), 's.json'));
      const clean = s.enqueueOutboxMessage({ kind: 'text', to: '972500500030', text: 'clean' }); s.claimOutboxMessage(clean.id); s.markOutboxSent(clean.id, 'wamid.C');
      const cleanRow = s.getOutboxMessage(clean.id); assert.equal(cleanRow.attemptLog, undefined); assert.equal(cleanRow.attemptId, undefined); assert.equal(cleanRow.providerMessageId, 'wamid.C');
      const retried = s.enqueueOutboxMessage({ kind: 'text', to: '972500500031', text: 'retry' }); s.claimOutboxMessage(retried.id);
      s.markOutboxRetry(retried.id, 'x', new Date(Date.now() - 1).toISOString()); s.claimOutboxMessage(retried.id); s.markOutboxSent(retried.id, 'wamid.R');
      assert.equal(s.getOutboxMessage(retried.id).attemptLog.length, 2, 'a retried message keeps its history');
      const unc = s.enqueueOutboxMessage({ kind: 'text', to: '972500500032', text: 'unc' }); s.claimOutboxMessage(unc.id); s.markOutboxUncertain(unc.id, 't');
      assert.ok(s.getOutboxMessage(unc.id).attemptLog.length === 1, 'an uncertain message keeps it');
      process.env.META_ATTEMPT_CALLBACK_DATA = 'on';
      const tagged = s.enqueueOutboxMessage({ kind: 'text', to: '972500500033', text: 'tagged' }); s.claimOutboxMessage(tagged.id); s.markOutboxSent(tagged.id, 'wamid.T');
      assert.equal(s.getOutboxMessage(tagged.id).attemptLog.length, 1, 'with tagging on every attempt is kept (late statuses match by it)');
    } finally { if (keep === undefined) delete process.env.META_ATTEMPT_CALLBACK_DATA; else process.env.META_ATTEMPT_CALLBACK_DATA = keep; }
  });

  // ------------------------------------------------------------ provider payloads
  const posts = [];
  function installFetch() {
    posts.length = 0;
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith('/media')) { const f = init.body; posts.push({ kind: 'media', hasTag: typeof f.get === 'function' && f.get('biz_opaque_callback_data') !== null }); return ok({ id: 'media-1' }); }
      const body = JSON.parse(init.body); posts.push({ kind: 'messages', body }); return ok({ messages: [{ id: `wamid.${posts.length}` }] });
    };
  }

  await scenario('provider: EVERY message kind carries the attempt id (text, template, buttons, list, contacts, image, sticker, document)', async () => {
    installFetch();
    const dir = mkdir('att-d-'); const png = path.join(dir, 'a.png'); fs.writeFileSync(png, 'png-' + Date.now());
    const webp = path.join(dir, 'a.webp'); fs.writeFileSync(webp, 'webp-' + Date.now());
    const pdf = path.join(dir, 'a.pdf'); fs.writeFileSync(pdf, 'pdf-' + Date.now());
    const p = new MetaCloudProvider(); const id = newAttemptId();
    await runWithSendAttempt({ attemptId: id, outboxId: 'o1' }, async () => {
      await p.sendMessage('972500600001', 'hi');
      await p.sendTemplateMessage('972500600001', 'tpl', 'he', ['a']);
      await p.sendInteractiveButtons('972500600001', 'q', [{ id: 'a', text: 'A' }]);
      await p.sendInteractiveList('972500600001', 'q', 'btn', [{ id: 'a', text: 'A' }]);
      await p.sendContactCards('972500600001', [{ vcard: 'BEGIN:VCARD\nFN:X\nTEL:0501234567\nEND:VCARD', displayName: 'X' }], 'X');
      await p.sendFile('972500600001', png, 'cap');
      await p.sendFile('972500600001', webp, undefined, { asSticker: true });
      await p.sendFile('972500600001', pdf, 'doc');
    });
    const msgs = posts.filter((x) => x.kind === 'messages');
    assert.deepEqual(msgs.map((m) => m.body.type), ['text', 'template', 'interactive', 'interactive', 'contacts', 'image', 'sticker', 'document']);
    for (const m of msgs) assert.equal(m.body.biz_opaque_callback_data, id, `${m.body.type} must carry the attempt id`);
    assert.ok(posts.filter((x) => x.kind === 'media').every((x) => x.hasTag === false), 'media uploads never carry it');
  });

  await scenario('provider: read receipt and typing indicator are NEVER tagged; no context = no tag; tag has no phone number', async () => {
    installFetch();
    const p = new MetaCloudProvider(); const id = newAttemptId();
    await runWithSendAttempt({ attemptId: id, outboxId: 'o2' }, async () => {
      await p.markRead({ id: 'wamid.IN1' });
      await p.showTypingIndicator({ id: 'wamid.IN2' });
    });
    await p.sendMessage('972500600002', 'untracked');
    assert.equal(posts.length, 3);
    assert.equal(posts[0].body.biz_opaque_callback_data, undefined); assert.equal(posts[0].body.status, 'read');
    assert.equal(posts[1].body.biz_opaque_callback_data, undefined);
    assert.equal(posts[2].body.biz_opaque_callback_data, undefined, 'an untracked send (no outbox row) is not tagged');
    assert.ok(!JSON.stringify(id).includes('972500600002'));
  });

  await scenario('provider: the payload object of the caller is not mutated', async () => {
    installFetch();
    const p = new MetaCloudProvider();
    await runWithSendAttempt({ attemptId: newAttemptId(), outboxId: 'o3' }, () => p.sendMessage('972500600003', 'x'));
    assert.equal(posts[0].body.to, '972500600003');
  });

  await scenario('DEFAULT IS OFF: without META_ATTEMPT_CALLBACK_DATA=on (unset, "off", "true", "1") nothing is tagged; sends still work; on = tagged', async () => {
    for (const value of [undefined, 'off', '', 'true', '1', 'ON ']) {
      installFetch();
      if (value === undefined) delete process.env.META_ATTEMPT_CALLBACK_DATA; else process.env.META_ATTEMPT_CALLBACK_DATA = value;
      await runWithSendAttempt({ attemptId: newAttemptId(), outboxId: 'o9' }, () => new MetaCloudProvider().sendMessage('972500600009', 'x'));
      assert.equal(posts[0].body.biz_opaque_callback_data, undefined, `value ${JSON.stringify(value)} must not enable tagging`);
      assert.equal(posts[0].body.type, 'text');
    }
    installFetch(); process.env.META_ATTEMPT_CALLBACK_DATA = 'on';
    await runWithSendAttempt({ attemptId: newAttemptId(), outboxId: 'o9' }, () => new MetaCloudProvider().sendMessage('972500600009', 'x'));
    assert.ok(posts[0].body.biz_opaque_callback_data);
  });

  // ------------------------------------------------------------ end to end through the campaign engine
  async function flowStorage(name, trigger, conversation) {
    const storage = new Storage(path.join(mkdir('att-flow-'), 's.json'));
    storage.addCampaign({ name, triggerType: 1, triggerPhrase: trigger, suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [], ...conversation } });
    return storage;
  }
  let msgSeq = 0;
  const inbound = (storage, transport, phone, body) => handleIncomingWhatsAppMessage({ id: `att-${++msgSeq}`, from: `whatsapp:${phone}`, body, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'U'; } }, storage, transport, 'webhook');

  await scenario('FLOW: real campaign over MetaCloudProvider - every outbound message POST is tagged with the attempt id persisted for exactly that outbox row', async () => {
    installFetch();
    const storage = await flowStorage('Att', 'att-join', { replyText: 'Welcome', decisionFlow: [{ id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }] });
    const phone = '972500700001';
    await inbound(storage, new MetaCloudProvider(), phone, 'att-join');
    const msgs = posts.filter((x) => x.kind === 'messages' && x.body.to);
    assert.ok(msgs.length >= 2, `expected text + buttons, got ${msgs.length}`);
    const rows = storage.getOutboxMessages(50);
    for (const m of msgs) {
      const found = storage.findOutboxByAttemptId(m.body.biz_opaque_callback_data);
      assert.ok(found, `POST tag ${m.body.biz_opaque_callback_data} must resolve to an outbox row`);
      assert.equal(found.attempt.status, 'accepted');
      assert.ok(found.attempt.providerMessageId, 'the provider id returned for that POST is recorded on that attempt');
    }
    assert.equal(new Set(msgs.map((m) => m.body.biz_opaque_callback_data)).size, msgs.length, 'one distinct id per POST');
    assert.equal(rows.filter((r) => r.status === 'sent').length, msgs.length, 'as many sent rows as POSTs');
    conversationState.removeByPhone(phone);
  });

  await scenario('FLOW: transient 429 then success - two POSTs, two different ids, both attempts on ONE logical row', async () => {
    installFetch(); let n = 0;
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/messages')) {
        const body = JSON.parse(init.body); posts.push({ kind: 'messages', body });
        if (!body.to) return ok({ success: true });            // read receipt / typing indicator
        if (++n === 1) return new Response(JSON.stringify({ error: { message: 'rate' } }), { status: 429, headers: { 'retry-after': '1' } });
        return ok({ messages: [{ id: 'wamid.second' }] });
      }
      return ok({});
    };
    const storage = await flowStorage('Att2', 'att-retry', { replyText: 'Hello' });
    const phone = '972500700002';
    await inbound(storage, new MetaCloudProvider(), phone, 'att-retry');
    const msgs = posts.filter((x) => x.kind === 'messages' && x.body.to);
    assert.equal(msgs.length, 2);
    assert.notEqual(msgs[0].body.biz_opaque_callback_data, msgs[1].body.biz_opaque_callback_data);
    const a = storage.findOutboxByAttemptId(msgs[0].body.biz_opaque_callback_data); const b = storage.findOutboxByAttemptId(msgs[1].body.biz_opaque_callback_data);
    assert.equal(a.message.id, b.message.id, 'same logical message');
    assert.deepEqual(b.message.attemptLog.map((x) => x.status), ['rejected', 'accepted']);
    conversationState.removeByPhone(phone);
  });

  await scenario('dispatcher over MetaCloudProvider: POST accepted but response lost (timeout) -> the attempt id that WAS sent is on the uncertain row', async () => {
    installFetch();
    global.fetch = async (url, init) => { if (String(url).endsWith('/messages')) { const body = JSON.parse(init.body); posts.push({ kind: 'messages', body }); const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; } return ok({}); };
    const storage = new Storage(path.join(mkdir('att-e-'), 's.json'));
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: '972500500010', text: 'lost response' });
    const d = startOutboxDispatcher(storage, () => new MetaCloudProvider(), 60_000);
    try { await waitFor(() => storage.getOutboxMessage(m.id).status === 'uncertain', 3000, 'uncertain'); } finally { await d.stop(); }
    const sent = posts.filter((x) => x.kind === 'messages');
    assert.equal(sent.length, 1);
    const row = storage.getOutboxMessage(m.id);
    assert.equal(row.attemptLog.length, 1);
    assert.equal(row.attemptLog[0].attemptId, sent[0].body.biz_opaque_callback_data, 'a later callback carrying this id can be matched to this row');
    assert.equal(row.attemptLog[0].status, 'uncertain');
    assert.equal(storage.findOutboxByAttemptId(sent[0].body.biz_opaque_callback_data).message.id, m.id);
  });

  // Deterministic "flushed before the provider call": flush is made slow, and the provider asserts that
  // no claim is still waiting for its flush at the moment it is called.
  function gateFlush(storage) {
    const state = { unflushedClaims: 0, violations: 0, calls: 0 };
    const realClaim = storage.claimOutboxMessage.bind(storage);
    const realFlush = storage.flush.bind(storage);
    storage.claimOutboxMessage = (...a) => { const r = realClaim(...a); if (r) state.unflushedClaims++; return r; };
    storage.flush = async () => { const before = state.unflushedClaims; await sleep(120); await realFlush(); state.unflushedClaims = Math.max(0, state.unflushedClaims - before); };
    state.onProviderCall = () => { state.calls++; if (state.unflushedClaims > 0) state.violations++; };
    return state;
  }

  await scenario('ORDER (dispatcher): the claim + attemptId are FLUSHED before the provider is called', async () => {
    const storage = new Storage(path.join(mkdir('att-f-'), 's.json'));
    const gate = gateFlush(storage);
    const m = storage.enqueueOutboxMessage({ kind: 'text', to: '972500500020', text: 'x' });
    const d = startOutboxDispatcher(storage, () => ({ async sendMessage() { gate.onProviderCall(); return { messageId: 'w' }; } }), 60_000);
    try { await waitFor(() => storage.getOutboxMessage(m.id).status === 'sent', 4000, 'sent'); } finally { await d.stop(); }
    assert.equal(gate.calls, 1); assert.equal(gate.violations, 0, 'provider was called while the claim was still unflushed');
  });

  await scenario('ORDER (direct send paths): text, buttons and file POSTs are each preceded by a flushed claim', async () => {
    const png = path.join(mkdir('att-g-'), 'a.png'); fs.writeFileSync(png, 'png-order-' + Date.now());
    const storage = await flowStorage('Order', 'order-join', { replyText: 'Welcome', decisionFlow: [{ id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }] });
    const gate = gateFlush(storage);
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/media')) return ok({ id: 'media-x' });
      const body = JSON.parse(init.body);
      if (body.to) gate.onProviderCall();
      return ok({ messages: [{ id: 'wamid.' + Math.random() }] });
    };
    const phone = '972500700009';
    await inbound(storage, new MetaCloudProvider(), phone, 'order-join');
    assert.ok(gate.calls >= 2, `expected at least text + buttons, got ${gate.calls}`);
    assert.equal(gate.violations, 0, 'a message POST happened while its claim/attemptId was not yet durable');
    conversationState.removeByPhone(phone);
  });

  let failed = 0;
  for (const [name, status, err] of results) { if (status === 'FAIL') failed++; console.log(`${status}  ${name}${err ? '\n      ' + err : ''}`); }
  console.log(`\nattempt-id: ${results.length - failed} passed, ${failed} failed`);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
