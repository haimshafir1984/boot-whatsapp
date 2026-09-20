/**
 * Stage B / 6.3 - the `uncertain` outbox state must be durable across crash and restart,
 * verified against REAL PostgreSQL (TEST_DATABASE_URL, local database whose name contains
 * "test"). The failure mode if it is not persisted correctly is a duplicate message to a
 * real participant after a restart.
 *
 * No TEST_DATABASE_URL -> exits 3 (BLOCKED). Never a silent skip, never a pass.
 * WARNING: like test-postgres-transactions.js this TRUNCATES the application tables of the
 * test database.
 */
process.env.NODE_ENV = 'test';
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
const timeoutError = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };

const pool = new Pool({ connectionString: url });
async function clear() {
  const sb = await pool.query("select to_regclass('public.service_bot_state') as name");
  if (sb.rows[0]?.name) await pool.query('truncate table service_bot_state restart identity');
  await pool.query(`truncate table scheduled_jobs, conversation_state, outbox_messages, twilio_templates,
    uploaded_files, saved_contacts, contact_queue, campaign_events, campaign_results, campaigns,
    client_profile, admin_settings, app_state restart identity`);
}
async function rawStatus(id) {
  const r = await pool.query('select status, data->>\'status\' as data_status, attempts from outbox_messages where id = $1', [id]);
  return r.rows[0];
}
/** "Restart": a brand-new backend + Storage populated ONLY from what PostgreSQL holds. */
async function boot() {
  const backend = await createPostgresBackend(url);
  const snapshot = await backend.loadSnapshot();
  return new Storage('unused-outbox-uncertain.json', { initialData: snapshot ?? emptyStorageData(), backend });
}
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 3).join(' | ')]); } }

(async () => {
  await migrateDatabase(url);

  await scenario('timeout -> uncertain is persisted; after crash+restart it is STILL uncertain and NOT re-sent (and blocks its recipient); other recipients unaffected', async () => {
    await clear();
    const s1 = await boot();
    const m1 = s1.enqueueOutboxMessage({ kind: 'text', to: '972550000001', text: 'm1 (times out)' });
    await sleep(3);
    const m2 = s1.enqueueOutboxMessage({ kind: 'text', to: '972550000001', text: 'm2 (dependent)' });
    const n = s1.enqueueOutboxMessage({ kind: 'text', to: '972550000002', text: 'n (other recipient)' });
    await s1.flush();
    const calls1 = [];
    const d1 = startOutboxDispatcher(s1, () => ({ async sendMessage(to, t) { calls1.push(t); if (t.startsWith('m1')) throw timeoutError(); return { messageId: 'wamid.n' }; } }), 60_000);
    await waitFor(() => s1.getOutboxMessage(n.id).status === 'sent' && s1.getOutboxMessage(m1.id).status === 'uncertain', 3000, 'n sent, m1 uncertain');
    await d1.stop(); await s1.flush();
    assert.deepEqual(await rawStatus(m1.id), { status: 'uncertain', data_status: 'uncertain', attempts: 1 }, 'PostgreSQL row must say uncertain');
    await s1.close();

    for (let restart = 1; restart <= 2; restart++) {
      const s2 = await boot();
      assert.equal(s2.getOutboxMessage(m1.id).status, 'uncertain', `restart ${restart}: loaded state`);
      const calls2 = [];
      const d2 = startOutboxDispatcher(s2, () => ({ async sendMessage(to, t) { calls2.push(t); return { messageId: 'x' }; } }), 60_000);
      await sleep(400);
      await d2.stop(); await s2.flush();
      assert.deepEqual(calls2, [], `restart ${restart}: nothing may be sent - not the uncertain message, not its dependent one`);
      assert.equal(s2.getOutboxMessage(m1.id).status, 'uncertain');
      assert.equal(s2.getOutboxMessage(m2.id).status, 'queued');
      assert.equal((await rawStatus(m1.id)).status, 'uncertain');
      await s2.close();
    }
    assert.equal(calls1.filter((t) => t.startsWith('m1')).length, 1, 'm1 was handed to the provider exactly once in total');
  });

  await scenario('crash while `processing` (row persisted as processing) -> restart parks it as uncertain in PostgreSQL, zero sends, survives another restart', async () => {
    await clear();
    const s1 = await boot();
    const m = s1.enqueueOutboxMessage({ kind: 'text', to: '972550000010', text: 'in flight during crash' });
    assert.ok(s1.claimOutboxMessage(m.id));
    await s1.flush();
    assert.equal((await rawStatus(m.id)).status, 'processing');
    await s1.close(); // the process "dies" here: only what PostgreSQL holds survives

    const s2 = await boot();
    assert.equal(s2.getOutboxMessage(m.id).status, 'processing', 'PostgreSQL still says processing after the crash');
    const sends = [];
    const d = startOutboxDispatcher(s2, () => ({ async sendMessage(to, t) { sends.push(t); return {}; } }), 60_000);
    await waitFor(() => s2.getOutboxMessage(m.id).status === 'uncertain', 2000, 'orphan parked');
    await sleep(300);
    await d.stop(); await s2.flush();
    assert.deepEqual(sends, [], 'HEAD re-claimed a stale processing row after 2 minutes and sent it again');
    assert.equal((await rawStatus(m.id)).status, 'uncertain', 'the parking is durable, not only in memory');
    await s2.close();

    const s3 = await boot();
    assert.equal(s3.getOutboxMessage(m.id).status, 'uncertain');
    assert.equal(s3.getUncertainOutboxMessages().length, 1);
    await s3.close();
  });

  await scenario('operator resolution is durable: not_sent -> retry -> sent exactly once; sent -> stays sent', async () => {
    await clear();
    const s1 = await boot();
    const a = s1.enqueueOutboxMessage({ kind: 'text', to: '972550000020', text: 'a' });
    const b = s1.enqueueOutboxMessage({ kind: 'text', to: '972550000021', text: 'b' });
    for (const m of [a, b]) { s1.claimOutboxMessage(m.id); s1.markOutboxUncertain(m.id, 'timeout'); }
    await s1.flush();
    assert.equal(s1.resolveOutboxUncertain(b.id, 'sent', 'wamid.b'), true);
    assert.equal(s1.resolveOutboxUncertain(a.id, 'not_sent'), true);
    await s1.flush();
    assert.equal((await rawStatus(a.id)).status, 'retry'); assert.equal((await rawStatus(b.id)).status, 'sent');
    await s1.close();
    const s2 = await boot(); const sends = [];
    const d = startOutboxDispatcher(s2, () => ({ async sendMessage(to, t) { sends.push(t); return { messageId: 'x' }; } }), 60_000);
    await waitFor(() => s2.getOutboxMessage(a.id).status === 'sent', 2000, 'a sent after operator said not_sent');
    await sleep(200); await d.stop(); await s2.flush();
    assert.deepEqual(sends, ['a'], 'only the message the operator declared not-sent is sent, exactly once');
    await s2.close();
  });

  await pool.end();
  let failed = 0;
  for (const [name, status, err] of results) { if (status === 'FAIL') failed++; console.log(`${status}  ${name}${err ? '\n      ' + err : ''}`); }
  console.log(`\nuncertain-postgres: ${results.length - failed} passed, ${failed} failed (real PostgreSQL ${parsed.hostname}:${parsed.port}${parsed.pathname})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
