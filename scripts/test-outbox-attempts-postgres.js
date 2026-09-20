/**
 * Stage B2 / step 1 - attempt ids survive restarts in REAL PostgreSQL (TEST_DATABASE_URL, local
 * database whose name contains "test"). Exit 3 (BLOCKED) if it is not set - never a silent skip.
 * WARNING: like the other PG tests this TRUNCATES the application tables of the test database.
 */
process.env.NODE_ENV = 'test';
process.env.META_ATTEMPT_CALLBACK_DATA = 'on';
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createPostgresBackend, migrateDatabase } = require('../dist/database');
const { emptyStorageData, Storage } = require('../dist/storage');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.error('BLOCKED: TEST_DATABASE_URL is not set (needs a local PostgreSQL test database).'); process.exit(3); }
const parsed = new URL(url);
if (!(['localhost', '127.0.0.1'].includes(parsed.hostname)) || !parsed.pathname.toLowerCase().includes('test')) {
  console.error('Refusing to run: TEST_DATABASE_URL must be a local database whose name contains "test".'); process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(10); } throw new Error(`timed out (${ms}ms): ${label}`); }
const pool = new Pool({ connectionString: url });
async function clear() {
  const sb = await pool.query("select to_regclass('public.service_bot_state') as name");
  if (sb.rows[0]?.name) await pool.query('truncate table service_bot_state restart identity');
  await pool.query(`truncate table scheduled_jobs, conversation_state, outbox_messages, twilio_templates,
    uploaded_files, saved_contacts, contact_queue, campaign_events, campaign_results, campaigns,
    client_profile, admin_settings, app_state restart identity`);
}
async function rawRow(id) { return (await pool.query('select data from outbox_messages where id = $1', [id])).rows[0]?.data; }
async function boot() {
  const backend = await createPostgresBackend(url);
  const snapshot = await backend.loadSnapshot();
  return new Storage('unused-attempts.json', { initialData: snapshot ?? emptyStorageData(), backend });
}
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 3).join(' | ')]); } }

(async () => {
  await migrateDatabase(url);

  await scenario('attempts persist across TWO restarts: ids, log, statuses, provider ids; earlier attempt still resolvable', async () => {
    await clear();
    const s1 = await boot();
    const m = s1.enqueueOutboxMessage({ kind: 'text', to: '972560000001', text: 'x' });
    const c1 = s1.claimOutboxMessage(m.id);
    s1.markOutboxRetry(m.id, new Error('429 rate'), new Date(Date.now() - 1000).toISOString());
    const c2 = s1.claimOutboxMessage(m.id);
    s1.markOutboxSent(m.id, 'wamid.PG1');
    await s1.flush();
    const raw = await rawRow(m.id);
    assert.equal(raw.attemptId, c2.attemptId, 'the raw PostgreSQL row holds the current attemptId');
    assert.deepEqual(raw.attemptLog.map((a) => a.attemptId), [c1.attemptId, c2.attemptId]);
    await s1.close();
    for (let restart = 1; restart <= 2; restart++) {
      const s = await boot();
      const row = s.getOutboxMessage(m.id);
      assert.deepEqual(row.attemptLog.map((a) => [a.attemptId, a.status]), [[c1.attemptId, 'rejected'], [c2.attemptId, 'accepted']], `restart ${restart}`);
      assert.equal(row.attemptLog[1].providerMessageId, 'wamid.PG1');
      assert.equal(s.findOutboxByAttemptId(c1.attemptId).message.id, m.id, 'index is rebuilt from PostgreSQL after restart');
      assert.equal(s.findOutboxByAttemptId('fba1_' + '0'.repeat(32)), null);
      await s.close();
    }
  });

  await scenario('attemptId is durable BEFORE the provider call: crash mid-send leaves the SAME id in PostgreSQL, marked uncertain on restart', async () => {
    await clear();
    const s1 = await boot();
    const m = s1.enqueueOutboxMessage({ kind: 'text', to: '972560000002', text: 'in flight' });
    await s1.flush();
    let inFlight = null; let release;
    const gate = new Promise((r) => { release = r; });
    const { currentSendAttempt } = require('../dist/sendAttempt');
    const d = startOutboxDispatcher(s1, () => ({ async sendMessage() { inFlight = currentSendAttempt().attemptId; await gate; return { messageId: 'never-recorded' }; } }), 60_000, { shutdownWaitMs: 50 });
    await waitFor(() => inFlight, 3000, 'send started');
    // At this instant the process "dies": what PostgreSQL holds is all that survives.
    const raw = await rawRow(m.id);
    assert.equal(raw.status, 'processing');
    assert.equal(raw.attemptId, inFlight, 'the id sent to the provider is already in PostgreSQL');
    await d.stop();   // the send is never released: like a dead process, that instance writes nothing more
    const s2 = await boot();
    const d2 = startOutboxDispatcher(s2, () => ({ async sendMessage() { throw new Error('must not be sent'); } }), 60_000);
    await waitFor(() => s2.getOutboxMessage(m.id).status === 'uncertain', 3000, 'orphan parked');
    await d2.stop(); await s2.flush();
    const row = (await rawRow(m.id));
    assert.equal(row.status, 'uncertain');
    assert.equal(row.attemptLog[0].attemptId, inFlight, 'the very id that went to Meta is the one a later callback will carry');
    assert.equal(row.attemptLog[0].status, 'uncertain');
    await s2.close();
    const s3 = await boot();
    assert.equal(s3.findOutboxByAttemptId(inFlight).message.status, 'uncertain');
    await s3.close();
  });

  await pool.end();
  let failed = 0;
  for (const [name, status, err] of results) { if (status === 'FAIL') failed++; console.log(`${status}  ${name}${err ? '\n      ' + err : ''}`); }
  console.log(`\nattempts-postgres: ${results.length - failed} passed, ${failed} failed (real PostgreSQL ${parsed.hostname}:${parsed.port}${parsed.pathname})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
