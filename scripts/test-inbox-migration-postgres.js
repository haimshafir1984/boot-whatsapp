/**
 * Stage E / C5 - JSON -> PostgreSQL inbox migration and rollback, against REAL PostgreSQL (dedicated flowsbiz_inbox_test on 5433).
 * Exit 3 = BLOCKED (never a skip). Covers: a dry-run that changes nothing, blocking-issue reports, backup + checksum before anything,
 * idempotent import, an interruption at every checkpoint, refusal on a moving / corrupt / conflicting source, verification BEFORE
 * activation, no dual writers (startup guards), rollback that restores the untouched original, and a rollback after SQL work
 * that loses no message (verified export).
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inboxTestUrl, assertInboxTestDb, ensureInboxTestDb } = require('./inbox-test-db');
const { createInboxPool, migrateInboxSchema } = require('../dist/inbox/schema');
const { PostgresInboxRepository } = require('../dist/inbox/postgresRepository');
const { MetaGatewayInbox } = require('../dist/metaGatewayInbox');
const mig = require('../dist/inbox/migration');
const { createInboxStore } = require('../dist/inbox/store');
const { readInboxConfig } = require('../dist/inbox/config');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-mig-'));
const RUN = `mg${process.pid}`;
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 4).join(' | ')]); } }
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const PN = '1207335449126872';
const payload = (id, from, pn = PN) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: pn, display_phone_number: '15550001111' }, messages: [{ from, id, timestamp: '1700000000', type: 'text', text: { body: 'hi' } }] } }] }] });
const key = (from, pn = PN) => `${pn}:${from}`;
let n = 0;
const fresh = (name) => { const dir = path.join(root, `${name}-${++n}`); fs.mkdirSync(dir, { recursive: true }); return { dir, file: path.join(dir, 'inbox.json'), backups: path.join(dir, 'backups'), ns: `${RUN}-${name}-${n}` }; };

/** A realistic legacy file built with the REAL legacy class: every status, several senders, an interrupted item. */
function buildLegacy(file) {
  const inbox = new MetaGatewayInbox(file, 1_000);
  const t = (s) => new Date(Date.parse('2026-09-01T00:00:00Z') + s * 1000);
  const items = [
    ['q1', '972501000001', 0], ['q2', '972501000001', 1],            // sender 1: two queued (order matters)
    ['c1', '972501000002', 2], ['r1', '972501000003', 3], ['h1', '972501000004', 4], ['f1', '972501000005', 5], ['p1', '972501000006', 6], ['p2', '972501000006', 7],
  ];
  for (const [id, from, s] of items) inbox.enqueue(id, payload(id, from), t(s));
  const claimed = inbox.claimBatch(20, (i) => key(i.payload.entry[0].changes[0].value.messages[0].from), t(10));   // one per sender
  const byId = Object.fromEntries(claimed.map((c) => [c.id, c]));
  inbox.markCompleted('c1', t(11)); inbox.markRetry('r1', new Error('routing incomplete'), new Date(t(12).getTime() + 3_600_000), t(12));
  inbox.markHeld('h1', 'sender held', t(13)); inbox.markFailed('f1', new Error('boom'), t(14));
  // q1 and p1 stay `processing` (interrupted); q2, p2 stay queued behind them.
  assert.ok(byId.q1 && byId.p1);
  return { total: items.length };
}
const opts = (t, role = 'client', extra = {}) => ({ role, namespace: t.ns, sourceFile: t.file, backupDir: t.backups, batchSize: 3, quietMs: 50, confirmStopped: true, ...extra });
const counts = async (pool, ns, role = 'client') => Object.fromEntries((await pool.query('select status, count(*)::int n from inbox_items where namespace = $1 and role = $2 group by status', [ns, role])).rows.map((r) => [r.status, r.n]));
const dbStats = async (pool) => JSON.stringify((await pool.query("select relname, n_tup_ins, n_tup_upd, n_tup_del from pg_stat_user_tables where relname like 'inbox_%' order by relname")).rows);

(async () => {
  await ensureInboxTestDb();
  const pool = createInboxPool(inboxTestUrl(), { max: 8 });
  const identity = await assertInboxTestDb(pool);
  await migrateInboxSchema(pool);
  console.log('database:', JSON.stringify(identity));

  await scenario('DRY-RUN changes NOTHING: source, .bak, directory, and every inbox table (no insert/update/delete/schema/ledger), with and without a database URL', async () => {
    const t = fresh('dry'); buildLegacy(t.file);
    const before = { sha: sha(t.file), dir: fs.readdirSync(t.dir).sort().join(','), stats: null };
    await pool.query('select pg_stat_force_next_flush()'); before.stats = await dbStats(pool);
    const r1 = await mig.dryRun(pool, opts(t));
    const r2 = await mig.dryRun(null, opts(t));
    await pool.query('select pg_stat_force_next_flush()');
    assert.equal(sha(t.file), before.sha); assert.equal(fs.readdirSync(t.dir).sort().join(','), before.dir, 'no backup / marker / file was created');
    assert.equal(await dbStats(pool), before.stats, 'no row was inserted, updated or deleted in any inbox table');
    assert.equal(r1.analysis.total, 8); assert.equal(r1.analysis.blocking, 0);
    assert.deepEqual(r1.analysis.byStatus, { queued: 2, processing: 2, completed: 1, retry: 1, held: 1, failed: 1 });
    assert.equal(r1.analysis.processingPlan.count, 2); assert.match(r1.analysis.processingPlan.becomes, /review/);
    assert.equal(r1.wouldImport, 8); assert.equal(r1.target.schema, 'present'); assert.equal(r1.target.ledger, null);
    assert.equal(r2.target.schema, 'not inspected (no database URL given)');
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'inbox-migrate.js'), 'dry-run', '--role', 'client', '--source-file', t.file, '--namespace', t.ns], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).analysis.total, 8);
    assert.equal(sha(t.file), before.sha);
  });

  await scenario('the report names every problem: duplicates, missing identity, malformed payload, invalid timestamps, unknown status - and blocking ones are marked', async () => {
    const t = fresh('bad');
    const items = [
      { id: 'a', payload: payload('a', '972501000010'), status: 'queued', attempts: 0, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
      { id: 'a', payload: payload('a', '972501000010'), status: 'retry', attempts: 1, createdAt: '2026-09-01T00:00:01Z', updatedAt: '2026-09-01T00:00:01Z' },   // duplicate identity
      { id: 'b', payload: { entry: [{ changes: [{ value: { messages: [{ from: '972501000011', id: 'b' }] } }] }] }, status: 'completed', attempts: 1, createdAt: '2026-09-01T00:00:02Z' },   // no phone_number_id: warning
      { id: 'c', payload: 'not an object', status: 'queued', createdAt: '2026-09-01T00:00:03Z' },                                                                                        // malformed + outstanding: blocking
      { id: 'd', payload: payload('d', '972501000012'), status: 'held', createdAt: 'yesterday' },                                                                                        // invalid createdAt: blocking
      { id: 'e', payload: payload('e', '972501000013'), status: 'weird', createdAt: '2026-09-01T00:00:04Z' },
    ];
    fs.writeFileSync(t.file, JSON.stringify({ version: 1, items }));
    const a = mig.analyze('client', mig.readSource(t.file));
    const codes = a.issues.map((i) => `${i.code}${i.blocking ? '!' : ''}`);
    for (const expected of ['duplicate_identity!', 'missing_phone_number_id', 'malformed_payload!', 'invalid_timestamp!', 'unknown_status!']) assert.ok(codes.includes(expected), `${expected} in ${codes}`);
    assert.ok(a.blocking >= 4);
    const c = fresh('corrupt'); fs.writeFileSync(c.file, '{ "items": [ {'); fs.writeFileSync(c.file + '.bak', JSON.stringify({ version: 1, items: [] }));
    const ca = mig.analyze('client', mig.readSource(c.file));
    assert.equal(ca.issues[0].code, 'source_unreadable'); assert.match(ca.issues[0].detail, /\.bak copy is NOT used/); assert.equal(ca.source.bakExists, true);
  });

  await scenario('APPLY (client): backup + checksum BEFORE, import, counts/identity/payload/order verified, invariants clean, source RENAMED (not deleted), marker, ledger active; processing => review (not re-run)', async () => {
    const t = fresh('apply'); buildLegacy(t.file);
    const originalSha = sha(t.file);
    const r = await mig.applyMigration(pool, opts(t));
    assert.match(r.result, /activated/);
    assert.ok(fs.existsSync(r.backup.path) && sha(r.backup.path) === originalSha, 'the immutable backup matches the source byte-for-byte');
    assert.equal(fs.readFileSync(r.backup.path + '.sha256', 'utf8').split(' ')[0], originalSha);
    assert.equal(fs.existsSync(t.file), false, 'the source is not where a JSON backend would read it'); assert.ok(fs.existsSync(r.migratedFile) && sha(r.migratedFile) === originalSha, 'renamed, never deleted');
    assert.ok(fs.existsSync(mig.markerPath(t.file)));
    const c = await counts(pool, t.ns);
    assert.deepEqual(c, { queued: 2 - 1 + 0 + 0 + 1 - 1 + 1, ...c }, 'sanity');   // replaced below by explicit expectations
    assert.deepEqual(c, { queued: 2, review: 2, completed: 1, retry: 1, held: 1, failed: 1 }, 'source counts, processing -> review');
    assert.equal(r.verification.ok, true); assert.equal(r.verification.invariantViolations, 0);
    const ledger = (await pool.query('select status from inbox_import_ledger where source_id = $1', [mig.sourceIdOf(opts(t))])).rows[0]; assert.equal(ledger.status, 'active');
    const repo = new PostgresInboxRepository(pool, { namespace: t.ns, role: 'client' });
    const review = (await repo.getByMessage(PN, 'q1')); assert.equal(review.status, 'review'); assert.equal(review.resolution, 'ambiguous_processing'); assert.equal(review.effectsState, 'possible');
    const claimed = (await repo.claim(50, { workerId: 'post-migration' })).claimed.map((x) => x.item.messageId).sort();
    // Fixed 2026-09-22 (finding #2): a migrated ambiguous_processing review item parks its sender exactly like
    // one created at runtime does - q2/p2 (queued behind q1/p1's interrupted 'processing') stay unclaimable
    // until an admin or a fresh trigger resolves the review item. Only r1, whose sender has no review item at
    // all, is offered. Previously q2 and p2 were claimed right alongside it - the bug this fixes.
    assert.deepEqual(claimed, ['r1'], 'only the sender with no ambiguous review item is offered; q2/p2 stay parked behind q1/p1. got: ' + JSON.stringify(claimed));
    assert.deepEqual((await repo.enqueueMany([{ messageId: 'c1', phoneNumberId: PN, senderKey: key('972501000002'), senderPhone: '972501000002', payload: {} }])).duplicates, ['c1'], 'a migrated message id is deduplicated');
    assert.equal((await repo.checkInvariants()).length, 0);
  });

  await scenario('APPLY (gateway): processing => retry due now (safe re-run), claimable immediately', async () => {
    const t = fresh('gw'); buildLegacy(t.file);
    await mig.applyMigration(pool, opts(t, 'gateway'));
    const c = await counts(pool, t.ns, 'gateway'); assert.deepEqual(c, { queued: 2, retry: 3, completed: 1, held: 1, failed: 1 });
    const repo = new PostgresInboxRepository(pool, { namespace: t.ns, role: 'gateway' });
    const claimed = (await repo.claim(50, { workerId: 'w' })).claimed.map((x) => x.item.messageId).sort();
    assert.ok(claimed.includes('q1') && claimed.includes('p1'), 'the interrupted items are re-offered: ' + claimed);
  });

  await scenario('INTERRUPTION at every checkpoint: a crash after any batch leaves the source untouched and NOT active; the rerun completes with no duplicate and no loss', async () => {
    for (const failAfter of [1, 2, 3]) {
      const t = fresh(`crash${failAfter}`); buildLegacy(t.file); const originalSha = sha(t.file);
      await assert.rejects(() => mig.applyMigration(pool, opts(t, 'client', { failAfterBatch: failAfter })), /injected failure/);
      assert.equal(sha(t.file), originalSha, 'source untouched'); assert.equal(fs.existsSync(mig.markerPath(t.file)), false, 'not active');
      const ledger = (await pool.query('select status from inbox_import_ledger where source_id = $1', [mig.sourceIdOf(opts(t))])).rows[0]; assert.equal(ledger.status, 'importing');
      const partial = Object.values(await counts(pool, t.ns)).reduce((a, b) => a + b, 0); assert.ok(partial > 0 && (failAfter < 3 ? partial < 8 : partial === 8), `partial import visible only in the inactive target (${partial})`);
      const r = await mig.applyMigration(pool, opts(t));
      assert.equal(r.verification.ok, true, JSON.stringify(r.verification.problems));
      assert.equal(Object.values(await counts(pool, t.ns)).reduce((a, b) => a + b, 0), 8, 'exactly the source items, no duplicates');
    }
  });

  await scenario('REFUSALS write nothing: corrupt input, duplicate identity, a writer still active, missing --confirm-stopped, already active, source changed since a partial import', async () => {
    const corrupt = fresh('r-corrupt'); fs.writeFileSync(corrupt.file, '{ "items": ['); const cSha = sha(corrupt.file);
    await assert.rejects(() => mig.applyMigration(pool, opts(corrupt)), /blocking issue/); assert.equal(fs.existsSync(corrupt.backups), false, 'no backup for a refused import');
    const dup = fresh('r-dup'); fs.writeFileSync(dup.file, JSON.stringify({ version: 1, items: [{ id: 'x', payload: payload('x', '972501000020'), status: 'queued', createdAt: '2026-09-01T00:00:00Z' }, { id: 'x', payload: payload('x', '972501000020'), status: 'failed', createdAt: '2026-09-01T00:00:01Z' }] }));
    await assert.rejects(() => mig.applyMigration(pool, opts(dup)), /duplicate_identity/); assert.deepEqual(await counts(pool, dup.ns), {});
    const moving = fresh('r-moving'); buildLegacy(moving.file);
    const writer = setTimeout(() => fs.appendFileSync(moving.file, ' '), 60);
    await assert.rejects(() => mig.applyMigration(pool, opts(moving, 'client', { quietMs: 400 })), /writer is still active/); clearTimeout(writer);
    assert.deepEqual(await counts(pool, moving.ns), {}, 'nothing imported while the source was moving');
    const nostop = fresh('r-nostop'); buildLegacy(nostop.file);
    await assert.rejects(() => mig.applyMigration(pool, opts(nostop, 'client', { confirmStopped: false })), /--confirm-stopped/);
    const done = fresh('r-done'); buildLegacy(done.file); await mig.applyMigration(pool, opts(done));
    await assert.rejects(() => mig.applyMigration(pool, opts(done)), /already active|blocking issue/, 'a second apply after activation does nothing');
    const changed = fresh('r-changed'); buildLegacy(changed.file);
    await assert.rejects(() => mig.applyMigration(pool, opts(changed, 'client', { failAfterBatch: 1 })), /injected/);
    const inbox = new MetaGatewayInbox(changed.file); inbox.enqueue('late-arrival', payload('late-arrival', '972501000099'));       // the source changed after a partial import
    await assert.rejects(() => mig.applyMigration(pool, opts(changed)), /source changed since it was \(partially\) imported/);
    assert.equal(fs.existsSync(mig.markerPath(changed.file)), false);
  });

  await scenario('VERIFICATION runs BEFORE activation: a conflicting row with the same identity in the target is never overwritten and blocks activation (source stays the truth)', async () => {
    const t = fresh('verify'); buildLegacy(t.file); const originalSha = sha(t.file);
    await migrateInboxSchema(pool);
    await pool.query(`insert into inbox_senders(namespace, role, sender_key, sender_phone, next_seq) values ($1,'client',$2,'972501000002',2)`, [t.ns, key('972501000002')]);
    await pool.query(`insert into inbox_items(namespace, role, phone_number_id, message_id, sender_key, sender_phone, sender_seq, status, payload) values ($1,'client',$2,'c1',$3,'972501000002',1,'failed','{"foreign":true}'::jsonb)`, [t.ns, PN, key('972501000002')]);
    await assert.rejects(() => mig.applyMigration(pool, opts(t)), /verification failed/);
    assert.equal(sha(t.file), originalSha); assert.equal(fs.existsSync(mig.markerPath(t.file)), false, 'not activated');
    assert.equal((await pool.query("select payload->>'foreign' f from inbox_items where namespace = $1 and message_id = 'c1'", [t.ns])).rows[0].f, 'true', 'the foreign row was not overwritten');
    assert.equal((await pool.query('select status from inbox_import_ledger where source_id = $1', [mig.sourceIdOf(opts(t))])).rows[0].status, 'failed_verification');
  });

  await scenario('NO DUAL WRITERS: JSON backend refuses to start once the marker exists; PostgreSQL backend refuses to start over an unmigrated legacy file; neither ignores data silently', async () => {
    const t = fresh('guard'); buildLegacy(t.file);
    const cfgPg = readInboxConfig('client', { INBOX_BACKEND: 'postgres', INBOX_DATABASE_URL: inboxTestUrl(), INBOX_NAMESPACE: t.ns });
    const cfgJson = readInboxConfig('client', { INBOX_BACKEND: 'json' });
    assert.throws(() => createInboxStore(cfgPg, t.file), /has not been migrated/, 'postgres over an unmigrated file');
    createInboxStore(cfgJson, t.file);                                                       // legacy default keeps working before migration
    await mig.applyMigration(pool, opts(t));
    assert.throws(() => createInboxStore(cfgJson, t.file), /migrated to PostgreSQL and is ACTIVE/, 'json after activation');
    createInboxStore(cfgPg, t.file);                                                         // postgres after activation: the file was renamed away
    const empty = fresh('guard-empty'); fs.writeFileSync(empty.file, JSON.stringify({ version: 1, items: [] }));
    createInboxStore(cfgPg, empty.file);                                                     // an empty legacy file is nothing to lose
  });

  await scenario('ROLLBACK before SQL did any work: the untouched original is restored BYTE-FOR-BYTE; the guards then allow JSON again and refuse PostgreSQL', async () => {
    const t = fresh('rb'); buildLegacy(t.file); const originalSha = sha(t.file);
    await mig.applyMigration(pool, opts(t));
    const r = await mig.rollback(pool, { role: 'client', namespace: t.ns, sourceFile: t.file, confirmStopped: true });
    assert.match(r.result, /byte-for-byte/); assert.equal(sha(t.file), originalSha); assert.equal(fs.existsSync(mig.markerPath(t.file)), false);
    assert.equal((await pool.query('select status from inbox_import_ledger where source_id = $1', [mig.sourceIdOf(opts(t))])).rows[0].status, 'rolled_back');
    createInboxStore(readInboxConfig('client', { INBOX_BACKEND: 'json' }), t.file);
    assert.throws(() => createInboxStore(readInboxConfig('client', { INBOX_BACKEND: 'postgres', INBOX_DATABASE_URL: inboxTestUrl(), INBOX_NAMESPACE: t.ns }), t.file), /has not been migrated/);
    await assert.rejects(() => mig.rollback(pool, { role: 'client', namespace: t.ns, sourceFile: t.file, confirmStopped: true }), /nothing to roll back/);
  });

  await scenario('ROLLBACK after SQL received/processed work: the plain rollback REFUSES (it would lose work); a verified export keeps EVERY message; nothing is lost', async () => {
    const t = fresh('rb2'); buildLegacy(t.file);
    await mig.applyMigration(pool, opts(t));
    const repo = new PostgresInboxRepository(pool, { namespace: t.ns, role: 'client' });
    await repo.enqueueMany([{ messageId: 'new-after-migration', phoneNumberId: PN, senderKey: key('972501000077'), senderPhone: '972501000077', payload: payload('new-after-migration', '972501000077') }]);   // new work
    const [claimed] = (await repo.claim(1, { workerId: 'w' })).claimed;                                                                                                                  // work SQL processed
    await repo.complete(claimed.item.id, claimed.leaseToken);
    const before = (await pool.query('select message_id from inbox_items where namespace = $1 and role = $2 order by message_id', [t.ns, 'client'])).rows.map((r) => r.message_id);
    await assert.rejects(() => mig.rollback(pool, { role: 'client', namespace: t.ns, sourceFile: t.file, confirmStopped: true }), /would LOSE it/);
    assert.equal(fs.existsSync(t.file), false, 'the refusal changed nothing');
    await assert.rejects(() => mig.exportLegacy(pool, { role: 'client', namespace: t.ns, outFile: path.join(t.dir, 'x.json'), confirmStopped: false }), /--confirm-stopped/);
    const out = path.join(t.dir, 'export.json');
    const ex = await mig.exportLegacy(pool, { role: 'client', namespace: t.ns, outFile: out, confirmStopped: true });
    assert.equal(ex.exported, before.length);
    const exportedIds = mig.readSource(out).items.map((i) => i.id).sort();
    assert.deepEqual(exportedIds, before, 'every message (migrated + new) is in the export');
    await mig.rollback(pool, { role: 'client', namespace: t.ns, sourceFile: t.file, useExport: out, confirmStopped: true });
    const legacy = new MetaGatewayInbox(t.file);                                           // the old backend reads it
    assert.equal(Object.values(legacy.counts()).reduce((a, b) => a + b, 0), before.length, 'no message lost');
    assert.equal(fs.existsSync(mig.markerPath(t.file)), false);
    assert.equal((await pool.query('select status from inbox_import_ledger where source_id = $1', [mig.sourceIdOf(opts(t))])).rows[0].status, 'rolled_back_via_export');
    const q = legacy.claimBatch(20, (i) => i.payload.entry[0].changes[0].value.messages[0].from);        // and it still works
    assert.ok(Array.isArray(q));
  });

  await pool.query("delete from inbox_items where namespace like $1", [RUN + '%']); await pool.query("delete from inbox_senders where namespace like $1", [RUN + '%']);
  await pool.query("delete from inbox_meta where namespace like $1", [RUN + '%']); await pool.query("delete from inbox_import_ledger where source_id like $1", ['%:' + RUN + '%']);
  await pool.end();
  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log(`inbox-migration-postgres: ${results.length - failed} passed, ${failed} failed (${identity.db}:${identity.port}, PostgreSQL ${identity.version})`);
  fs.rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})().catch((e) => { console.error(e); process.exit(1); });
