/**
 * The client endpoint /internal/meta/whatsapp answers 2xx for a status ONLY when it is durable - on the REAL storage path
 * (PostgreSQL backend), read back from the DATABASE, not from memory.
 *
 * Why PostgreSQL: with the JSON backend getStorageHealth().pendingWrites is always 0 and persistence is synchronous, so the
 * fix (`flush when statusChanged OR pendingWrites > 0`) cannot even be exercised there - the older test D1 in
 * test-meta-status-forwarding.js reads getOutboxMessage().deliveryStatus from MEMORY and passes with or without the fix.
 *
 * Scenario (the broken path from the review):
 *   1. a real outbox row, sent with a known wamid and attempt id, durable in the database
 *   2. the storage backend's database connection starts failing (injected at pool.connect, i.e. the real write path)
 *   3. status delivered  -> applied in memory, flush fails            -> MUST be 503
 *   4. the gateway's retry (the same status = a duplicate, statusChanged=false, but the write is STILL not durable)
 *                                                                      -> MUST be 503 too (the bug answered 200 here)
 *   5. the database comes back, the backend's own retry commits
 *   6. the retry once more                                             -> 200, and the DATABASE now holds `delivered`
 *   7. a fresh Storage/backend loaded from the database sees `delivered`
 *   8. a request that changes nothing while nothing is pending does NOT flush (the fix must not add a flush per request)
 *
 *   STATUS_TEST_DIST=<dir containing the compiled build>  (default ../dist) - run it against a build WITHOUT the fix to see it fail.
 * Needs TEST_DATABASE_URL (local PostgreSQL 18 test server, port 5433); uses its own schema in flowsbiz_inbox_test.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { inboxTestUrl, assertInboxTestDb, ensureInboxTestDb } = require('./inbox-test-db');

const DIST = path.resolve(process.env.STATUS_TEST_DIST || path.join(__dirname, '..', 'dist'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-flush-'));
Object.assign(process.env, {
  NODE_ENV: 'test', WHATSAPP_PROVIDER: 'META_CLOUD_API', META_ATTEMPT_CALLBACK_DATA: 'on',
  STORAGE_PATH: path.join(root, 'client.json'), OWNER_STORAGE_PATH: path.join(root, 'owner.json'), CONVERSATION_STATE_PATH: path.join(root, 'conv.json'), UPLOADS_PATH: path.join(root, 'uploads'),
  OWNER_ACCESS_TOKEN: 'flush-owner-token', CLIENT_ACCESS_TOKEN: 'flush-client-token', META_ACCESS_TOKEN: '', META_PHONE_NUMBER_ID: 'shared-phone-id', META_DISPLAY_PHONE_NUMBER: '15550001111',
});
delete process.env.DATABASE_URL; delete process.env.INBOX_DATABASE_URL;   // the endpoint's inbox stays on its JSON file; only STORAGE is on PostgreSQL here
const { createPostgresBackend, migrateDatabase } = require(path.join(DIST, 'database'));
const { Storage, emptyStorageData } = require(path.join(DIST, 'storage'));
const { startAdminServer } = require(path.join(DIST, 'adminServer'));
const { config } = require(path.join(DIST, 'config'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusPayload = (statuses) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'shared-phone-id', display_phone_number: '15550001111' }, statuses } }] }] });

(async () => {
  let failed = 0; const results = [];
  const step = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { failed++; results.push(['FAIL', name, (e.message || String(e)).split('\n').slice(0, 4).join(' | ')]); } };

  await ensureInboxTestDb();
  const admin = new Pool({ connectionString: inboxTestUrl(), max: 2 });
  await assertInboxTestDb(admin);
  const schema = `dur_${Date.now().toString(36)}`;
  await admin.query(`create schema ${schema}`);
  const u = new URL(inboxTestUrl()); u.searchParams.set('options', `-c search_path=${schema}`); const schemaUrl = u.toString();
  await migrateDatabase(schemaUrl);

  const backend = await createPostgresBackend(schemaUrl);
  const storage = new Storage(path.join(root, 'client-setup.json'), { initialData: (await backend.loadSnapshot()) ?? emptyStorageData(), backend });
  // 1. a real outbox row: queued -> claimed (gets its attempt id) -> sent with a known provider id; durable
  const to = '972500000042'; const wamid = 'wamid.DURABLE1';
  const queued = storage.enqueueOutboxMessage({ kind: 'text', to, text: 'x' });
  const claimed = storage.claimOutboxMessage(queued.id);
  storage.markOutboxSent(queued.id, wamid);
  await storage.flush();

  const dbRow = async () => (await admin.query(`select data from ${schema}.outbox_messages where id = $1`, [queued.id])).rows[0]?.data;
  assert.equal((await dbRow()).status, 'sent', 'precondition: the sent row is in the database'); assert.equal((await dbRow()).deliveryStatus, undefined);

  // the real endpoint, on this storage
  const port = await new Promise((resolve) => { const p = http.createServer(); p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => resolve(n)); }); });
  config.ADMIN_PORT = port;
  const srv = startAdminServer(storage); if (!srv.listening) await new Promise((r) => srv.once('listening', r));
  const body = JSON.stringify(statusPayload([{ id: wamid, status: 'delivered', timestamp: '1700000000', recipient_id: to, biz_opaque_callback_data: claimed.attemptId }]));
  const send = async () => (await fetch(`http://127.0.0.1:${port}/internal/meta/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-token': 'flush-owner-token' }, body })).status;

  // count the flushes the ENDPOINT performs (on the instance the endpoint uses)
  let flushCalls = 0; const realFlush = storage.flush.bind(storage); storage.flush = async () => { flushCalls += 1; return realFlush(); };
  // 2. the database starts failing, at the point the real write path takes its connection
  let dbDown = true; const realConnect = backend.pool.connect.bind(backend.pool);
  backend.pool.connect = (...a) => (dbDown ? Promise.reject(new Error('injected: database unavailable')) : realConnect(...a));

  await step('3. first attempt: applied in memory, flush fails -> 503 (and the database does NOT have it)', async () => {
    assert.equal(await send(), 503);
    assert.equal(storage.getOutboxMessage(queued.id).deliveryStatus, 'delivered', 'applied in memory');
    assert.equal((await dbRow()).deliveryStatus, undefined, 'not durable');
  });
  await step('4. the gateway retry (duplicate, nothing newly changed, write STILL not durable) must NOT be acknowledged', async () => {
    const st = await send();
    assert.equal(st, 503, `got ${st}: a 2xx here tells the gateway the status is safe while it exists only in memory`);
    assert.equal((await dbRow()).deliveryStatus, undefined, 'still not in the database');
  });
  dbDown = false;   // 5. the database is back; the backend's own backoff retry commits
  await step('5. the backend retries on its own and commits', async () => {
    const t0 = Date.now(); while (Date.now() - t0 < 15000) { const h = storage.getStorageHealth(); if (h.pendingWrites === 0 && !h.lastError) break; await sleep(100); }
    assert.equal(storage.getStorageHealth().pendingWrites, 0, 'the retry did not commit in time');
  });
  await step('6. the retry is now acknowledged (200) and the DATABASE holds `delivered`', async () => {
    assert.equal(await send(), 200);
    const row = await dbRow(); assert.equal(row.deliveryStatus, 'delivered'); assert.equal(row.attemptLog[0].deliveryStatus, 'delivered');
  });
  await step('7. a fresh Storage loaded from the database sees `delivered`', async () => {
    const b2 = await createPostgresBackend(schemaUrl);
    const s2 = new Storage(path.join(root, 'reloaded.json'), { initialData: await b2.loadSnapshot(), backend: b2 });
    assert.equal(s2.getOutboxMessage(queued.id).deliveryStatus, 'delivered'); await b2.close();
  });
  await step('8. a repeat that changes nothing, with nothing pending, does NOT flush (no flush added per request)', async () => {
    const before = flushCalls; assert.equal(storage.getStorageHealth().pendingWrites, 0);
    assert.equal(await send(), 200);
    assert.equal(flushCalls, before, `flush() was called ${flushCalls - before} time(s) for a request that changed nothing`);
  });
  await step('9. ... while a request that DOES change something flushes once', async () => {
    const q2 = storage.enqueueOutboxMessage({ kind: 'text', to: '972500000043', text: 'y' }); const c2 = storage.claimOutboxMessage(q2.id); storage.markOutboxSent(q2.id, 'wamid.DURABLE2'); await realFlush();
    const before = flushCalls;
    const st = await (await fetch(`http://127.0.0.1:${port}/internal/meta/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-token': 'flush-owner-token' }, body: JSON.stringify(statusPayload([{ id: 'wamid.DURABLE2', status: 'delivered', timestamp: '1700000001', recipient_id: '972500000043', biz_opaque_callback_data: c2.attemptId }])) })).status;
    assert.equal(st, 200); assert.equal(flushCalls - before, 1);
    assert.equal((await admin.query(`select data from ${schema}.outbox_messages where id = $1`, [q2.id])).rows[0].data.deliveryStatus, 'delivered');
  });

  for (const [s, name, err] of results) console.log(`${s}  ${name}${err ? '\n      ' + err : ''}`);
  console.log(`\nstatus-flush-durability (${path.basename(path.dirname(DIST))}/${path.basename(DIST)}): ${results.length - failed} passed, ${failed} failed`);
  srv.closeAllConnections(); await new Promise((r) => srv.close(r));
  dbDown = false; await backend.close().catch(() => {});
  await admin.query(`drop schema ${schema} cascade`).catch(() => {}); await admin.end();
  setTimeout(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(failed ? 1 : 0); }, 300);
})().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
