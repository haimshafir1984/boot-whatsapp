/**
 * Delivery evidence received while the POST was in the air survives a crash and a restart in REAL PostgreSQL
 * (TEST_DATABASE_URL, local database whose name contains "test"). Exit 3 = BLOCKED, never a skip.
 * WARNING: like the other PG tests this TRUNCATES the application tables of the test database.
 */
process.env.NODE_ENV = 'test';
process.env.META_ATTEMPT_CALLBACK_DATA = 'on';
process.env.OUTBOX_RECOVERY_WINDOW_MS = '1000';
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createPostgresBackend, migrateDatabase } = require('../dist/database');
const { emptyStorageData, Storage, recoveryWindowMs } = require('../dist/storage');

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.error('BLOCKED: TEST_DATABASE_URL is not set (needs a local PostgreSQL test database).'); process.exit(3); }
const parsed = new URL(url);
if (!(['localhost', '127.0.0.1'].includes(parsed.hostname)) || !parsed.pathname.toLowerCase().includes('test')) { console.error('Refusing to run: TEST_DATABASE_URL must be a local database whose name contains "test".'); process.exit(1); }
const pool = new Pool({ connectionString: url });
async function clear() {
  const sb = await pool.query("select to_regclass('public.service_bot_state') as name");
  if (sb.rows[0]?.name) await pool.query('truncate table service_bot_state restart identity');
  await pool.query('truncate table scheduled_jobs, conversation_state, outbox_messages, twilio_templates, uploaded_files, saved_contacts, contact_queue, campaign_events, campaign_results, campaigns, client_profile, admin_settings, app_state restart identity');
}
const raw = async (id) => (await pool.query('select data from outbox_messages where id = $1', [id])).rows[0]?.data;
async function boot() { const backend = await createPostgresBackend(url); const snapshot = await backend.loadSnapshot(); return new Storage('unused-evsend.json', { initialData: snapshot ?? emptyStorageData(), backend }); }
const afterWindow = () => new Date(Date.now() + recoveryWindowMs() + 50);
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 3).join(' | ')]); } }
const timeoutError = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };

(async () => {
  await migrateDatabase(url);

  await scenario('crash AFTER the delivery callback but BEFORE the send closed: the evidence survives the restart, the row is NOT an orphan, it ends sent and is never retried', async () => {
    await clear();
    const s1 = await boot();
    const m = s1.enqueueOutboxMessage({ kind: 'text', to: '972505000010', text: 'in the air' });
    const claimed = s1.claimOutboxMessage(m.id); await s1.flush();
    const r = s1.applyMetaStatus({ wamid: 'wamid.PGAIR', status: 'delivered', recipientId: '972505000010', attemptId: claimed.attemptId });
    assert.equal(r.result, 'applied'); assert.equal(s1.getOutboxMessage(m.id).status, 'processing');
    await s1.flush();
    const durable = await raw(m.id);
    assert.equal(durable.status, 'processing'); assert.equal(durable.attemptLog[0].deliveryStatus, 'delivered', 'the evidence is durable on the attempt record');
    assert.equal(durable.attemptLog[0].providerMessageId, 'wamid.PGAIR');
    await s1.close();                                                        // the process dies here: the POST never closed
    const s2 = await boot();
    const orphans = s2.recoverOrphanedOutboxProcessing(); await s2.flush();
    assert.equal(orphans.length, 0, 'not an orphan: nothing to alert or hold');
    let row = await raw(m.id);
    assert.equal(row.status, 'sent'); assert.equal(row.providerMessageId, 'wamid.PGAIR'); assert.equal(row.attemptLog.length, 1);
    assert.deepEqual(s2.advanceUncertainRecovery(afterWindow()), [], 'no retry');
    await s2.close();
    const s3 = await boot();
    assert.equal(s3.getOutboxMessage(m.id).status, 'sent'); assert.equal(s3.getOutboxMessage(m.id).attemptLog.length, 1);
    assert.equal(s3.hasOutstandingOutboxForRecipient('972505000010'), false);
    await s3.close();
  });

  await scenario('control: the same crash WITHOUT any evidence still becomes uncertain (unchanged)', async () => {
    await clear();
    const s1 = await boot();
    const m = s1.enqueueOutboxMessage({ kind: 'text', to: '972505000011', text: 'no evidence' });
    s1.claimOutboxMessage(m.id); await s1.flush(); await s1.close();
    const s2 = await boot();
    assert.equal(s2.recoverOrphanedOutboxProcessing().length, 1); await s2.flush();
    assert.equal((await raw(m.id)).status, 'uncertain');
    await s2.close();
  });

  await scenario('the callback and the timeout in one process, then restart: sent stays sent (PostgreSQL)', async () => {
    await clear();
    const s1 = await boot();
    const m = s1.enqueueOutboxMessage({ kind: 'text', to: '972505000012', text: 'x' });
    const claimed = s1.claimOutboxMessage(m.id);
    s1.applyMetaStatus({ wamid: 'wamid.PGT', status: 'sent', recipientId: '972505000012', attemptId: claimed.attemptId });
    assert.equal(s1.markOutboxUncertain(m.id, timeoutError()), true);
    await s1.flush(); await s1.close();
    const s2 = await boot();
    assert.equal(s2.getOutboxMessage(m.id).status, 'sent'); assert.deepEqual(s2.advanceUncertainRecovery(afterWindow()), []);
    await s2.close();
  });

  await pool.end();
  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log('evidence-during-send-postgres: ' + (results.length - failed) + ' passed, ' + failed + ' failed (real PostgreSQL ' + parsed.hostname + ':' + parsed.port + parsed.pathname + ')');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
