/**
 * Stage B2 / step 3 - recovery state, continuation ownership and the early-status journal survive restarts in
 * REAL PostgreSQL (TEST_DATABASE_URL, local database whose name contains "test"). Exit 3 = BLOCKED, never a skip.
 * WARNING: like the other PG tests this TRUNCATES the application tables of the test database.
 */
process.env.NODE_ENV = 'test';
process.env.META_ATTEMPT_CALLBACK_DATA = 'on';
process.env.OUTBOX_RECOVERY_WINDOW_MS = '1000';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { createPostgresBackend, migrateDatabase } = require('../dist/database');
const { emptyStorageData, Storage, recoveryWindowMs } = require('../dist/storage');

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.error('BLOCKED: TEST_DATABASE_URL is not set (needs a local PostgreSQL test database).'); process.exit(3); }
const parsed = new URL(url);
if (!(['localhost', '127.0.0.1'].includes(parsed.hostname)) || !parsed.pathname.toLowerCase().includes('test')) { console.error('Refusing to run: TEST_DATABASE_URL must be a local database whose name contains "test".'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = new Pool({ connectionString: url });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recov-pg-'));
async function clear() {
  const sb = await pool.query("select to_regclass('public.service_bot_state') as name");
  if (sb.rows[0]?.name) await pool.query('truncate table service_bot_state restart identity');
  await pool.query('truncate table scheduled_jobs, conversation_state, outbox_messages, twilio_templates, uploaded_files, saved_contacts, contact_queue, campaign_events, campaign_results, campaigns, client_profile, admin_settings, app_state restart identity');
}
const raw = async (id) => (await pool.query('select data from outbox_messages where id = $1', [id])).rows[0]?.data;
async function boot() { const backend = await createPostgresBackend(url); const snapshot = await backend.loadSnapshot(); return new Storage('unused-recovery.json', { initialData: snapshot ?? emptyStorageData(), backend }); }
const afterWindow = () => new Date(Date.now() + recoveryWindowMs() + 50);
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 3).join(' | ')]); } }
const desc = { kind: 'decision_step', senderJid: 'whatsapp:972580000001', senderPhone: '972580000001', stepId: 'q1', campaignId: 'c1', campaignResultId: 'r1' };

(async () => {
  await migrateDatabase(url);

  await scenario('window, retry count, budget and terminal state persist across TWO restarts; recoverable_failed no longer blocks the recipient', async () => {
    await clear();
    const s1 = await boot();
    const m = s1.enqueueOutboxMessage({ kind: 'text', to: '972580000001', text: 'x', flowRef: { unitId: 'fu_1', index: 1 }, continuation: { descriptor: desc, state: 'pending' } });
    s1.claimOutboxMessage(m.id); s1.markOutboxUncertain(m.id, 'timeout'); await s1.flush();
    const r0 = await raw(m.id);
    assert.ok(r0.recovery.windowEndsAt); assert.equal(r0.continuation.state, 'pending'); assert.deepEqual(r0.flowRef, { unitId: 'fu_1', index: 1 });
    await s1.close();
    let s = await boot();
    assert.equal(s.getOutboxMessage(m.id).recovery.windowEndsAt, r0.recovery.windowEndsAt, 'restart 1: same window');
    s.advanceUncertainRecovery(afterWindow()); await s.flush(); await s.close();
    s = await boot();
    assert.equal(s.getOutboxMessage(m.id).status, 'retry'); assert.equal(s.getOutboxMessage(m.id).recovery.retriesGranted, 1);
    assert.deepEqual(s.advanceUncertainRecovery(afterWindow()), [], 'restart 2: the granted retry is not granted again');
    s.claimOutboxMessage(m.id); s.markOutboxUncertain(m.id, 'again'); s.advanceUncertainRecovery(afterWindow()); await s.flush();
    const end = await raw(m.id);
    assert.equal(end.status, 'recoverable_failed'); assert.equal(end.attemptLog.length, 2, 'exactly 2 POST attempts');
    await s.close();
    s = await boot();
    assert.equal(s.hasOutstandingOutboxForRecipient('972580000001'), false, 'not blocking after a restart either');
    assert.equal(s.getOutboxHealth().recoverable_failed, 1);
    await s.close();
  });

  await scenario('crash mid-send, restart, restart: one window (not reset); a TAGGED callback after the second restart resolves it as sent; continuation ownership persists', async () => {
    await clear();
    const s1 = await boot();
    const m = s1.enqueueOutboxMessage({ kind: 'text', to: '972580000002', text: 'in flight', flowRef: { unitId: 'fu_2', index: 1 }, continuation: { descriptor: { ...desc, senderJid: 'whatsapp:972580000002', senderPhone: '972580000002' }, state: 'pending' } });
    const attemptId = s1.claimOutboxMessage(m.id).attemptId; await s1.flush(); await s1.close();   // "dies" while processing
    let s = await boot(); s.recoverOrphanedOutboxProcessing(); await s.flush();
    const w1 = s.getOutboxMessage(m.id).recovery.windowEndsAt; await s.close();
    await sleep(250);
    s = await boot(); s.recoverOrphanedOutboxProcessing();
    assert.equal(s.getOutboxMessage(m.id).recovery.windowEndsAt, w1, 'second restart did not restart the wait');
    const out = s.applyMetaStatus({ wamid: 'wamid.PGEV', status: 'delivered', recipientId: '972580000002', attemptId });
    assert.equal(out.result, 'applied'); await s.flush();
    assert.equal((await raw(m.id)).status, 'sent');
    assert.ok(s.claimContinuation(m.id), 'ownership taken once'); assert.equal(s.claimContinuation(m.id), null, 'and never twice'); await s.flush();
    assert.equal((await raw(m.id)).continuation.state, 'running'); await s.close();
    s = await boot();
    assert.deepEqual(s.resetRunningContinuations(), [m.id], 'a restart mid-continuation makes it pending again (replay is idempotent)');
    await s.flush(); assert.equal((await raw(m.id)).continuation.state, 'pending'); await s.close();
  });

  await scenario('EARLY STATUS survives a restart: buffered (untagged, id not yet known), restart, applied when the id is recorded', async () => {
    await clear();
    const journal = path.join(tmp, 'early.jsonl');
    const s1 = await boot(); s1.attachEarlyStatusJournal(journal);
    assert.equal(s1.applyMetaStatus({ wamid: 'wamid.EARLYPG', status: 'delivered', recipientId: '972580000003' }).result, 'buffered');
    await s1.close();
    const s2 = await boot(); s2.attachEarlyStatusJournal(journal);
    const m = s2.enqueueOutboxMessage({ kind: 'text', to: '972580000003', text: 'x' }); s2.claimOutboxMessage(m.id); s2.markOutboxSent(m.id, 'wamid.EARLYPG');
    assert.equal(s2.getOutboxMessage(m.id).deliveryStatus, 'delivered', 'the status that arrived before the restart was not lost'); await s2.flush(); await s2.close();
  });

  await scenario('Baileys held messages keep their FULL replay data through PostgreSQL and a restart (a released hold cannot drop them)', async () => {
    await clear();
    const s1 = await boot();
    const jid = 'whatsapp:972580000004';
    const held = { messageId: 'bm1', source: 'baileys', bodyPreview: 'x'.repeat(200), timestamp: Date.now(), replay: { from: jid, senderPhone: '972580000004', body: 'y'.repeat(3000), hasUserSignal: true, messageTimestamp: 123, displayName: 'D', media: { kind: 'image', mimeType: 'image/jpeg' } } };
    s1.saveConversationStateSnapshot({ version: 1, savedAt: new Date().toISOString(), conversations: { [jid]: { kind: 'needs_review', senderJid: jid, senderPhone: '972580000004', reason: 'r', timestamp: Date.now(), recovery: { outboxId: 'o1' }, heldMessages: [held] } } });
    await s1.flush(); await s1.close();
    const s2 = await boot();
    const back = s2.loadConversationStateSnapshot().conversations[jid].heldMessages[0];
    assert.deepEqual(back.replay, held.replay); assert.equal(back.source, 'baileys');
    await s2.close();
  });

  await pool.end();
  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log('recovery-postgres: ' + (results.length - failed) + ' passed, ' + failed + ' failed (real PostgreSQL ' + parsed.hostname + ':' + parsed.port + parsed.pathname + ')');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
