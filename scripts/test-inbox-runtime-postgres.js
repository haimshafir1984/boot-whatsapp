/**
 * Stage E / C3 - both inboxes wired into the real admin server (startAdminServer) with INBOX_BACKEND=postgres, against the
 * dedicated PostgreSQL test database (flowsbiz_inbox_test on 5433). Exit 3 = BLOCKED (never a skip).
 *
 *   Part A  store contract, run against BOTH the PostgreSQL store and the legacy JSON store behind the same async interface
 *   Part B  real server: receipt only after commit (client 202 / gateway 200), duplicates, processed, expired trigger -> review,
 *           held (and the next message is held too), ambiguous processing (worker died) -> NOT re-run + sender held,
 *           no fallback to JSON when PostgreSQL is unreachable (503, no file created), gateway inbox disabled on a plain client,
 *           shutdown (stop claiming, drain, close)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { inboxTestUrl, assertInboxTestDb, ensureInboxTestDb } = require('./inbox-test-db');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-runtime-'));
const RUN = `rt${process.pid}`;
Object.assign(process.env, {
  NODE_ENV: 'test', WHATSAPP_PROVIDER: 'META_CLOUD_API',
  STORAGE_PATH: path.join(root, 'client-storage.json'), OWNER_STORAGE_PATH: path.join(root, 'owner.json'),
  CONVERSATION_STATE_PATH: path.join(root, 'conv.json'), UPLOADS_PATH: path.join(root, 'uploads'),
  OWNER_ACCESS_TOKEN: 'rt-owner-token', CLIENT_ACCESS_TOKEN: 'rt-client-token', META_ACCESS_TOKEN: '',
  META_PHONE_NUMBER_ID: 'shared-phone-id', META_DISPLAY_PHONE_NUMBER: '15550001111', META_APP_SECRET: '',
  INBOX_NAMESPACE: RUN, INBOX_LEASE_MS: '1000', INBOX_SHUTDOWN_WAIT_MS: '2000',
});
delete process.env.INBOX_BACKEND; delete process.env.INBOX_DATABASE_URL; delete process.env.DATABASE_URL;

const { config } = require('../dist/config');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { createInboxPool, migrateInboxSchema } = require('../dist/inbox/schema');
const { PostgresInboxRepository } = require('../dist/inbox/postgresRepository');
const { readInboxConfig } = require('../dist/inbox/config');
const { JsonInboxStore, PostgresInboxStore, DisabledInboxStore } = require('../dist/inbox/store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(25); } throw new Error(`timed out (${ms}ms): ${label}`); }
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 4).join(' | ')]); } }

const PN = 'shared-phone-id';
const metaPayload = (id, from, { body = 'hello there', ageSeconds = 0 } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PN, display_phone_number: '15550001111' }, contacts: [{ profile: { name: 'P' }, wa_id: from }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000) - ageSeconds), type: 'text', text: { body } }] } }] }],
});
const post = (url, pathname, body, headers = {}) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request(url + pathname, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t })); });
  req.on('error', reject); req.end(data);
});
const captured = [];
const origLog = console.log; const origWarn = console.warn; const origErr = console.error;
const capture = (orig) => (...a) => { captured.push(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(' ')); orig.apply(console, a); };

let pool; let repoNs;
const rowOf = async (role, messageId) => (await pool.query('select * from inbox_items where namespace = $1 and role = $2 and message_id = $3', [RUN, role, messageId])).rows[0];

(async () => {
  await ensureInboxTestDb();
  pool = createInboxPool(inboxTestUrl(), { max: 10 });
  const identity = await assertInboxTestDb(pool);
  await migrateInboxSchema(pool);
  console.log('database:', JSON.stringify(identity));

  // ================================================================ Part A: the same contract on both stores
  const contract = async (label, makeStore) => {
    await scenario(`A [${label}] enqueue is idempotent; one item per sender; hold does not block; requeue works; cancel; counts`, async () => {
      const store = await makeStore(); await store.init();
      try {
        const mk = (id, from) => ({ id, payload: metaPayload(id, from) });
        await store.enqueueMany([mk('c1', '972501000101'), mk('c2', '972501000101'), mk('d1', '972501000102')]);
        await store.enqueueMany([mk('c1', '972501000101')]);                                   // duplicate: no second item
        let c = await store.claim(10);
        assert.deepEqual(c.claimed.map((x) => x.id).sort(), ['c1', 'd1'], 'one item per sender in flight');
        assert.equal((await store.claim(10)).claimed.length, 0);
        const c1 = c.claimed.find((x) => x.id === 'c1'), d1 = c.claimed.find((x) => x.id === 'd1');
        await store.hold(c1, new Error('sender held'));
        await store.complete(d1);
        c = await store.claim(10); assert.deepEqual(c.claimed.map((x) => x.id), ['c2'], 'the next message is offered although c1 is held');
        await store.hold(c.claimed[0], new Error('sender held'));
        const counts = await store.counts(); assert.equal(counts.held, 2); assert.equal(counts.completed >= 1, true);
        assert.equal(await store.resolveForPhone('972501000101', 'requeue', 'admin'), 2, 'both held messages are requeued');
        c = await store.claim(10); assert.equal(c.claimed.length, 1, 'requeued work is offered again (one per sender)');
        assert.equal(await store.cancelForPhone('972501000101'), 2, 'cancel supersedes the outstanding items of the phone');
        assert.equal((await store.claim(10)).claimed.length, 0);
      } finally { await store.close(); }
    });
    await scenario(`A [${label}] an expired trigger is NOT recorded as completed (review / failed-with-reason)`, async () => {
      const store = await makeStore(); await store.init();
      try {
        await store.enqueueMany([{ id: 'st1', payload: metaPayload('st1', '972501000111') }]);
        const [item] = (await store.claim(1)).claimed;
        await store.review(item, 'stale_trigger', { ageMs: 700000 });
        const counts = await store.counts();
        assert.equal(counts.completed >= 1 && label === 'JSON' ? counts.completed : 0, 0, 'never counted as completed');
        assert.equal(counts.review + counts.failed >= 1, true);
      } finally { await store.close(); }
    });
  };
  await contract('PostgreSQL', async () => new PostgresInboxStore({ ...readInboxConfig('client', { INBOX_BACKEND: 'postgres', INBOX_DATABASE_URL: inboxTestUrl(), INBOX_NAMESPACE: `${RUN}-A-${Math.random().toString(36).slice(2, 7)}` }) }));
  await contract('JSON', async () => new JsonInboxStore(path.join(root, `legacy-${Math.random().toString(36).slice(2, 7)}.json`), 'client'));

  await scenario('A config: PostgreSQL without a connection string REFUSES to start (no fallback to JSON); the gateway needs INBOX_DATABASE_URL', async () => {
    assert.throws(() => readInboxConfig('gateway', { INBOX_BACKEND: 'postgres' }), /INBOX_DATABASE_URL/);
    assert.throws(() => readInboxConfig('client', { INBOX_BACKEND: 'postgres' }), /DATABASE_URL/);
    assert.equal(readInboxConfig('client', { INBOX_BACKEND: 'postgres', DATABASE_URL: 'postgres://x' }).databaseUrl, 'postgres://x', 'a client may use its own database');
    assert.equal(readInboxConfig('gateway', {}).backend, 'json', 'default stays the legacy file until an explicit switch');
    assert.throws(() => readInboxConfig('client', { INBOX_BACKEND: 'sqlite' }), /INBOX_BACKEND/);
  });

  // ================================================================ Part B: the real server
  process.env.INBOX_BACKEND = 'postgres'; process.env.INBOX_DATABASE_URL = inboxTestUrl();
  const storage = new Storage(path.join(root, 'client-storage.json'));
  storage.addCampaign({ id: 'stale-campaign', name: 'stale', triggerType: 1, triggerPhrase: 'join stale', suffix: ' - Bot', active: true, runtimeStatus: 'active', conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: 'hi', followupMessages: [], decisionFlow: [] } });
  config.ADMIN_PORT = 0;
  const { startAdminServer, getAdminInboxWorker } = require('../dist/adminServer');
  console.log = capture(origLog); console.warn = capture(origWarn); console.error = capture(origErr);

  // ambiguous scenario needs a worker that "died" BEFORE the server starts
  const seedPool = createInboxPool(inboxTestUrl(), { max: 3 });
  const seedRepo = new PostgresInboxRepository(seedPool, { namespace: RUN, role: 'client' });
  await seedRepo.enqueueMany([{ messageId: 'amb1', phoneNumberId: PN, senderKey: `${PN}:972501000201`, senderPhone: '972501000201', payload: metaPayload('amb1', '972501000201', { body: 'join stale' }) }]);
  const dead = (await seedRepo.claim(1, { workerId: 'crashed-worker', leaseMs: 1000 })).claimed[0];
  assert.ok(dead, 'the "crashed" worker owned the item');
  storage.recordCampaignTrigger('stale-campaign', '972501000201', 'Crashed Worker Participant');   // the business EFFECT the dead worker had already produced
  assert.equal(storage.getCampaignResults().length, 1);
  await sleep(1300);                                   // its lease expires

  const server = startAdminServer(storage);
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const owner = { 'x-owner-token': 'rt-owner-token' };

  await scenario('B client receipt: 202 only AFTER the row is committed; a re-sent id creates no second row', async () => {
    const r = await post(url, '/internal/meta/whatsapp', metaPayload('rc1', '972501000301'), owner);
    assert.equal(r.status, 202);
    const row = await rowOf('client', 'rc1');
    assert.ok(row, 'the item was durable when the 202 was returned');
    const again = await post(url, '/internal/meta/whatsapp', metaPayload('rc1', '972501000301'), owner);
    assert.equal(again.status, 202);
    assert.equal((await pool.query("select count(*)::int n from inbox_items where namespace = $1 and role = 'client' and message_id = 'rc1'", [RUN])).rows[0].n, 1);
    await waitFor(async () => (await rowOf('client', 'rc1')).status === 'completed', 8000, 'the message was processed');
    assert.equal((await rowOf('client', 'rc1')).resolution, 'processed');
  });

  await scenario('B gateway receipt: 200 only AFTER the row is committed, then it is processed and recorded', async () => {
    const r = await post(url, '/webhooks/meta/whatsapp', metaPayload('gw1', '972501000302'));
    assert.equal(r.status, 200);
    assert.ok(await rowOf('gateway', 'gw1'), 'durable when the 200 was returned');
    await waitFor(async () => ['completed', 'retry', 'failed'].includes((await rowOf('gateway', 'gw1')).status), 8000, 'gateway item settled');
  });

  await scenario('B an EXPIRED trigger is kept for review (payload retained, alert path), NOT completed, and the campaign is NOT run', async () => {
    const r = await post(url, '/internal/meta/whatsapp', metaPayload('stale1', '972501000303', { body: 'join stale', ageSeconds: 11 * 60 }), owner);
    assert.equal(r.status, 202);
    await waitFor(async () => (await rowOf('client', 'stale1')).status !== 'queued' && (await rowOf('client', 'stale1')).status !== 'processing', 8000, 'settled');
    const row = await rowOf('client', 'stale1');
    assert.equal(row.status, 'review'); assert.equal(row.resolution, 'stale_trigger');
    assert.ok(row.payload && row.payload.entry, 'payload kept'); assert.ok(row.resolution_detail.ageMs >= 11 * 60 * 1000 - 5000);
    assert.equal(storage.getCampaignResults().filter((r) => r.phone === '972501000303').length, 0, 'the expired campaign was not run');
  });

  await scenario('B held: a sender under review -> the message is HELD (not completed); the next message of that sender is also visible as held', async () => {
    const jid = 'whatsapp:972501000304';
    conversationState.set(jid, { kind: 'needs_review', senderJid: jid, senderPhone: '972501000304', reason: 'admin decided', timestamp: Date.now() });
    await post(url, '/internal/meta/whatsapp', metaPayload('h1', '972501000304'), owner);
    await waitFor(async () => (await rowOf('client', 'h1'))?.status === 'held', 8000, 'first message held');
    await post(url, '/internal/meta/whatsapp', metaPayload('h2', '972501000304'), owner);
    await waitFor(async () => (await rowOf('client', 'h2'))?.status === 'held', 8000, 'second message held too');
    assert.equal((await rowOf('client', 'h1')).resolution, 'sender_held');
    conversationState.removeByPhone('972501000304');
  });

  await scenario('B AMBIGUOUS: a worker died after effects may have started -> NOT re-run, item review(ambiguous_processing), sender held for review', async () => {
    await waitFor(async () => (await rowOf('client', 'amb1'))?.status === 'review', 8000, 'ambiguous item parked');
    const row = await rowOf('client', 'amb1');
    assert.equal(row.resolution, 'ambiguous_processing');
    assert.equal(captured.some((l) => l.includes('[META_INBOUND]') && l.includes('amb1')), false, 'the handler never ran for it (no second execution)');
    assert.equal(storage.getCampaignResults().filter((r) => r.phone === '972501000201').length, 1, 'no duplicate result / contact / step: the campaign was NOT run a second time');
    await waitFor(() => conversationState.getNeedsReview('whatsapp:972501000201'), 5000, 'sender is on hold');
    assert.equal(conversationState.getNeedsReview('whatsapp:972501000201').source, 'inbox');
    conversationState.removeByPhone('972501000201');
  });

  await scenario('B D1 option 1: a participant held by an AMBIGUOUS inbox item who re-sends the exact trigger starts a new run, no admin; an ADMIN hold is NOT overridden', async () => {
    const jidA = 'whatsapp:972501000305'; const jidB = 'whatsapp:972501000306';
    conversationState.set(jidA, { kind: 'needs_review', senderJid: jidA, senderPhone: '972501000305', messageId: 'amb-old', source: 'inbox', reason: 'interrupted', timestamp: Date.now() });
    conversationState.set(jidB, { kind: 'needs_review', senderJid: jidB, senderPhone: '972501000306', messageId: 'adm-old', source: 'webhook', reason: 'admin decided', timestamp: Date.now() });
    // a message that is NOT a trigger does not release the ambiguous hold (it is held like before)
    await post(url, '/internal/meta/whatsapp', metaPayload('nt1', '972501000305', { body: 'hello there' }), owner);
    await waitFor(async () => (await rowOf('client', 'nt1'))?.status === 'held', 8000, 'a non-trigger message stays held');
    assert.ok(conversationState.getNeedsReview(jidA), 'the hold is still there after a non-trigger message');
    // the exact trigger releases it and starts a fresh run
    await post(url, '/internal/meta/whatsapp', metaPayload('rt1', '972501000305', { body: 'join stale' }), owner);
    await waitFor(async () => (await rowOf('client', 'rt1'))?.status === 'completed', 8000, 'the fresh trigger was processed');
    assert.ok(['processed', 'processed_late'].includes((await rowOf('client', 'rt1')).resolution), 'the fresh trigger ran (processed_late = the send retried past this test\'s short lease)');
    assert.equal(conversationState.getNeedsReview(jidA), undefined, 'the ambiguous hold was released by the participant re-trigger');
    assert.equal(storage.getCampaignResults().filter((r) => r.phone === '972501000305').length, 1, 'a NEW run started (one campaign result)');
    assert.ok(captured.some((l) => l.includes('INBOX_AMBIGUOUS_HOLD_SUPERSEDED_BY_TRIGGER') && l.includes('amb-old')), 'the release is logged, with the discarded held-message count');
    // an admin hold is untouched by the same trigger
    await post(url, '/internal/meta/whatsapp', metaPayload('rt2', '972501000306', { body: 'join stale' }), owner);
    await waitFor(async () => (await rowOf('client', 'rt2'))?.status === 'held', 8000, 'the trigger is held against an admin hold');
    assert.ok(conversationState.getNeedsReview(jidB), 'the admin hold is still in place');
    assert.equal(storage.getCampaignResults().filter((r) => r.phone === '972501000306').length, 0, 'no campaign was started for the admin-held participant');
    conversationState.removeByPhone('972501000306'); conversationState.removeByPhone('972501000305');
  });

  const jsonReq = async (method, pathname, body, cookie) => {
    const r = await fetch(url + pathname, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let parsed = null; try { parsed = await r.json(); } catch { /* no body */ }
    return { status: r.status, body: parsed, headers: r.headers };
  };
  const login = async (kind, code) => { const r = await fetch(`${url}/auth/${kind}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: code }) }); assert.equal(r.status, 200, kind + ' login'); return String(r.headers.get('set-cookie') || '').split(';')[0]; };

  await scenario('B REVIEW ENDPOINT: items that need attention are VISIBLE (status, reason, sender, preview - never the payload), filterable, paginated, and need auth', async () => {
    assert.equal((await jsonReq('GET', '/api/inbox/review')).status, 401, 'client endpoint needs a session');
    assert.equal((await jsonReq('GET', '/owner/api/inbox/review')).status, 401, 'owner endpoint needs a session');
    const cookie = await login('client', 'rt-client-token');
    const all = await jsonReq('GET', '/api/inbox/review?limit=500', undefined, cookie);
    assert.equal(all.status, 200); assert.equal(all.body.backend, 'postgres');
    const byId = Object.fromEntries(all.body.items.map((i) => [i.id, i]));
    for (const id of ['stale1', 'amb1', 'h1', 'h2']) assert.ok(byId[id], `${id} is listed`);
    assert.equal(byId.stale1.status, 'review'); assert.equal(byId.stale1.resolution, 'stale_trigger'); assert.equal(byId.stale1.bodyPreview, 'join stale'); assert.equal(byId.stale1.senderPhone, '972501000303');
    assert.equal(byId.amb1.resolution, 'ambiguous_processing'); assert.equal(byId.h1.status, 'held');
    assert.equal(JSON.stringify(all.body).includes('"payload"'), false, 'the raw payload is never returned');
    const onlyReview = await jsonReq('GET', '/api/inbox/review?status=review&limit=500', undefined, cookie);
    assert.ok(onlyReview.body.items.every((i) => i.status === 'review') && onlyReview.body.items.length >= 2);
    // pagination: walk one item at a time; every item appears exactly once
    const seen = []; let next = null;
    for (let guard = 0; guard < 50; guard++) {
      const q = `/api/inbox/review?limit=1${next ? `&afterUpdatedAt=${encodeURIComponent(next.updatedAt)}&afterId=${next.id}` : ''}`;
      const page = await jsonReq('GET', q, undefined, cookie); seen.push(...page.body.items.map((i) => `${i.status}:${i.id}`));
      next = page.body.next; if (!next) break;
    }
    assert.ok(seen.length >= all.body.items.length - 1 && new Set(seen).size === seen.length, 'each item exactly once across pages: ' + seen.length + ' vs ' + all.body.items.length);
    assert.equal((await jsonReq('GET', '/api/inbox/review?role=gateway', undefined, cookie)).status, 400, 'a client session cannot read the gateway inbox');
    const ownerCookie = await login('owner', 'rt-owner-token');
    const gw = await jsonReq('GET', '/owner/api/inbox/review?role=gateway', undefined, ownerCookie); assert.equal(gw.status, 200); assert.equal(gw.body.role, 'gateway');
    assert.equal((await jsonReq('GET', '/owner/api/inbox/review?role=client&status=review', undefined, ownerCookie)).body.items.length >= 2, true);
  });

  await scenario('B REVIEW RESOLVE: no default action; requeue of held works; an interrupted item needs an explicit duplicate-risk acknowledgement; discard is audited', async () => {
    const cookie = await login('client', 'rt-client-token');
    assert.equal((await jsonReq('POST', '/api/inbox/review/resolve', { phone: '972501000304' }, cookie)).status, 400, 'no default action');
    assert.equal((await jsonReq('POST', '/api/inbox/review/resolve', { phone: '972501000304', action: 'requeue', statuses: ['held'] })).status, 401);
    const held = await jsonReq('POST', '/api/inbox/review/resolve', { phone: '972501000304', action: 'requeue', statuses: ['held'] }, cookie);
    assert.equal(held.body.resolved, 2); await waitFor(async () => ['completed', 'held', 'retry'].includes((await rowOf('client', 'h1')).status), 8000, 'requeued messages were picked up again');
    const noAck = await jsonReq('POST', '/api/inbox/review/resolve', { phone: '972501000201', action: 'requeue', statuses: ['review'] }, cookie);
    assert.equal(noAck.body.resolved, 0, 'an ambiguous item is NOT replayed without acknowledgement'); assert.equal((await rowOf('client', 'amb1')).status, 'review');
    const stale = await jsonReq('POST', '/api/inbox/review/resolve', { phone: '972501000303', action: 'discard', statuses: ['review'], actor: 'tester' }, cookie);
    assert.equal(stale.body.resolved, 1); const st = await rowOf('client', 'stale1'); assert.equal(st.status, 'failed'); assert.equal(st.resolution, 'admin_discarded');
    const audit = await pool.query("select actor, action from inbox_admin_audit where item_id = $1", [st.id]); assert.deepEqual(audit.rows[0], { actor: 'tester', action: 'discard' });
    const ack = await jsonReq('POST', '/api/inbox/review/resolve', { phone: '972501000201', action: 'requeue', statuses: ['review'], acknowledgeDuplicateRisk: true }, cookie);
    assert.equal(ack.body.resolved, 1, 'with the acknowledgement the interrupted item is replayed');
  });

  await scenario('B no JSON files are ever written by a PostgreSQL inbox', async () => {
    const stray = fs.readdirSync(root).filter((f) => /inbox.*\.json(\.bak|\.tmp)?$/.test(f) && !f.startsWith('legacy-'));
    assert.deepEqual(stray, []);
  });

  await scenario('B shutdown: stop() ends claiming, waits for in-flight, closes the pools; new work stays queued (not lost)', async () => {
    await new Promise((r) => server.close(() => r()));
    const worker = getAdminInboxWorker(); assert.ok(worker, 'the worker is exposed for the shutdown chain');
    await worker.stop();
    const repo = new PostgresInboxRepository(seedPool, { namespace: RUN, role: 'client' });
    await repo.enqueueMany([{ messageId: 'after-stop', phoneNumberId: PN, senderKey: `${PN}:972501000305`, senderPhone: '972501000305', payload: metaPayload('after-stop', '972501000305') }]);
    await sleep(1200);
    assert.equal((await rowOf('client', 'after-stop')).status, 'queued', 'nothing is claimed after stop');
  });

  // ---- PostgreSQL unreachable: fail closed, no file fallback
  process.env.INBOX_DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';
  process.env.INBOX_NAMESPACE = `${RUN}-down`;
  const downServer = startAdminServer(storage);
  if (!downServer.listening) await new Promise((r) => downServer.once('listening', r));
  const downUrl = `http://127.0.0.1:${downServer.address().port}`;
  await scenario('B PostgreSQL UNREACHABLE: receipts are answered 503 (never acknowledged), an init alert path runs, and NO JSON file is created', async () => {
    const a = await post(downUrl, '/internal/meta/whatsapp', metaPayload('down1', '972501000401'), owner);
    const b = await post(downUrl, '/webhooks/meta/whatsapp', metaPayload('down2', '972501000402'));
    assert.equal(a.status, 503); assert.equal(b.status, 503);
    assert.ok(captured.some((l) => l.includes('[INBOX_INIT_FAILED]')));
    assert.deepEqual(fs.readdirSync(root).filter((f) => /inbox.*\.json/.test(f) && !f.startsWith('legacy-')), [], 'no fallback file');
  });
  await new Promise((r) => downServer.close(() => r()));
  await getAdminInboxWorker().stop();

  // ---- a plain client (no managed clients, no gateway database): the gateway inbox refuses, never acknowledges
  delete process.env.INBOX_DATABASE_URL; process.env.DATABASE_URL = inboxTestUrl(); process.env.INBOX_NAMESPACE = `${RUN}-plain`;
  const plainServer = startAdminServer(storage);
  if (!plainServer.listening) await new Promise((r) => plainServer.once('listening', r));
  const plainUrl = `http://127.0.0.1:${plainServer.address().port}`;
  await scenario('B a plain client (no gateway database): the gateway webhook is REFUSED (503), the client inbox works on its own DATABASE_URL', async () => {
    assert.equal((await post(plainUrl, '/webhooks/meta/whatsapp', metaPayload('plain-gw', '972501000501'))).status, 503);
    assert.equal((await post(plainUrl, '/internal/meta/whatsapp', metaPayload('plain-c', '972501000502'), owner)).status, 202);
    const row = (await pool.query("select status from inbox_items where namespace = $1 and role = 'client' and message_id = 'plain-c'", [`${RUN}-plain`])).rows[0];
    assert.ok(row);
  });
  const capturedBeforeStop = captured.length;
  // Make the claim slow (300ms) so it is DETERMINISTICALLY in flight when stop() is called.
  const origClaim = PostgresInboxRepository.prototype.claim;
  PostgresInboxRepository.prototype.claim = async function slowClaim(...a) { await sleep(300); return origClaim.apply(this, a); };
  await post(plainUrl, '/internal/meta/whatsapp', metaPayload('stop-race', '972501000503'), owner);
  await sleep(60);                                   // the receipt-triggered drain is now inside its (slow) claim
  await new Promise((r) => plainServer.close(() => r()));
  await getAdminInboxWorker().stop();
  await scenario('B shutdown race: stop() while a claim is in flight waits for it and for its handler - no store failure, item completed', async () => {
    await sleep(300);
    assert.equal(captured.slice(capturedBeforeStop).some((l) => l.includes('[INBOX_STORE_FAILED]')), false, 'no outcome was written to a closed pool');
    const st = (await pool.query("select status from inbox_items where namespace = $1 and role = 'client' and message_id = 'stop-race'", [`${RUN}-plain`])).rows[0].status;
    PostgresInboxRepository.prototype.claim = origClaim;
    assert.equal(st, 'completed', 'stop() waited for the in-flight claim and its handler, then closed the pools - got ' + st);
  });

  console.log = origLog; console.warn = origWarn; console.error = origErr;
  await pool.query("delete from inbox_items where namespace like $1", [RUN + '%']); await pool.query("delete from inbox_senders where namespace like $1", [RUN + '%']);
  await seedPool.end(); await pool.end();
  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log(`inbox-runtime-postgres: ${results.length - failed} passed, ${failed} failed (${identity.db}:${identity.port}, PostgreSQL ${identity.version})`);
  fs.rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})().catch((e) => { console.log = origLog; console.error(e); process.exit(1); });
