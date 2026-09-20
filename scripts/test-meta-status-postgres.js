/**
 * Stage B2 / step 2 - applied delivery statuses (callbacks) survive restarts in REAL PostgreSQL (TEST_DATABASE_URL, local
 * database whose name contains "test"). Exit 3 (BLOCKED) if it is not set - never a silent skip.
 * WARNING: like the other PG tests this TRUNCATES the application tables of the test database.
 */
process.env.NODE_ENV = 'test';
process.env.META_ATTEMPT_CALLBACK_DATA = 'on';   // the tagged-callback path is what these tests are about
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
  const { newAttemptId } = require('../dist/sendAttempt');

  await scenario('a callback that identifies an attempt whose POST response was lost is applied, durable, and survives TWO restarts; foreign/mismatched ones write nothing', async () => {
    await clear();
    const s1 = await boot();
    const m = s1.enqueueOutboxMessage({ kind: 'text', to: '972570000001', text: 'x' });
    const attemptId = s1.claimOutboxMessage(m.id).attemptId;
    s1.markOutboxUncertain(m.id, 'timeout');          // response lost
    await s1.flush();
    const before = JSON.stringify(await rawRow(m.id));
    assert.equal(s1.applyMetaStatus({ wamid: 'wamid.X', status: 'delivered', recipientId: '972570000001', attemptId: newAttemptId() }).result, 'foreign');
    assert.equal(s1.applyMetaStatus({ wamid: 'wamid.X', status: 'delivered', recipientId: '972599999999', attemptId }).result, 'mismatch');
    await s1.flush();
    assert.equal(JSON.stringify(await rawRow(m.id)), before, 'foreign / mismatched callbacks changed nothing in PostgreSQL');
    assert.equal(s1.applyMetaStatus({ wamid: 'wamid.LOSTRESP', status: 'delivered', recipientId: '972570000001', attemptId }).result, 'applied');
    await s1.flush();
    const raw = await rawRow(m.id);
    assert.equal(raw.attemptLog[0].providerMessageId, 'wamid.LOSTRESP'); assert.equal(raw.attemptLog[0].deliveryStatus, 'delivered'); assert.equal(raw.deliveryStatus, 'delivered');
    await s1.close();
    for (let restart = 1; restart <= 2; restart++) {
      const s = await boot();
      const row = s.getOutboxMessage(m.id);
      assert.equal(row.attemptLog[0].providerMessageId, 'wamid.LOSTRESP', `restart ${restart}`);
      assert.equal(row.deliveryStatus, 'delivered');
      assert.equal(s.applyMetaStatus({ wamid: 'wamid.LOSTRESP', status: 'delivered', recipientId: '972570000001', attemptId }).result, 'duplicate', 'a repeat after restart is a no-op');
      assert.equal(s.applyMetaStatus({ wamid: 'wamid.LATE', status: 'sent', recipientId: '972570000001', attemptId }).result, restart === 1 ? 'applied' : 'duplicate', 'an additional provider id for the same attempt is recorded once and survives the restart');
      assert.deepEqual(s.getOutboxMessage(m.id).attemptLog[0].providerMessageIds, ['wamid.LATE']);
      await s.flush(); await s.close();
      // reset the extra id so the next loop iteration is identical
    }
  });

  await pool.end();
  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log('status-postgres: ' + (results.length - failed) + ' passed, ' + failed + ' failed (real PostgreSQL ' + parsed.hostname + ':' + parsed.port + parsed.pathname + ')');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
