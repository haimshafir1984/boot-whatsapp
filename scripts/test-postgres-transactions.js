'use strict';

/**
 * B2-1: PostgreSQL transactions must run on ONE dedicated connection.
 *
 * The old code assembled a transaction from pool.query('begin'),
 * pool.query(sql), pool.query('commit') - each call can be handed a
 * different pooled connection. When a second query interleaves on the pool
 * between BEGIN and COMMIT, the BEGIN connection is left `idle in
 * transaction` forever, holding a RowExclusiveLock that never releases, and
 * the COMMIT that lands on another connection is a silent no-op. Verified
 * directly against Postgres (pg_stat_activity / pg_locks) - that is the
 * check that reproduced the original bug.
 *
 * writeSnapshotDelta / writeSnapshot / applyMigrations now each take one
 * connection from pool.connect(), carry begin..commit and every statement
 * between on it, and release() it in finally - exactly like
 * loadRuntimeSnapshot already did.
 *
 * Runs against a REAL local Postgres (same convention as
 * test-postgres-delta.js), never a mock. It proves:
 *
 *   1. A fast parallel write flood leaves ZERO `idle in transaction`
 *      backends and ZERO locks held by idle backends for the test app.
 *   2. Under genuine pool contention (other queries competing for
 *      connections while a delta commits), the delta's transaction stays
 *      pinned - still zero idle-in-transaction afterward.
 *   3. A failure mid-transaction (NOT NULL violation on the second table of
 *      a delta) rolls the whole delta back - the first table's write does
 *      not survive - and the connection is returned to the pool healthy.
 *   4. applyMigrations (via migrateDatabase) under the same kind of
 *      contention - not just writeSnapshotDelta, the hot path.
 *   5. writeSnapshot, the full-rewrite path (via replaceStorageSnapshot),
 *      under contention too.
 *
 * Checks 4 and 5 close a gap flagged in code review: the fix applies the
 * same pool.connect()-plus-dedicated-client pattern to all three entry
 * points, but the original test only put load-bearing pressure on
 * writeSnapshotDelta. The code path is identical for all three, so this is
 * confirmatory rather than exploratory - but it's cheap and it means nothing
 * is asserted purely by code-reading.
 *
 * The mutation proof (revert one client.query to pool.query, watch check 1
 * fail) is done by hand and recorded in
 * docs/flush-transaction-fix-results-2026-09-02.md.
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { Pool } = require('pg');
const {
  createPostgresBackend,
  loadStorageSnapshot,
  writeSnapshotDelta,
  migrateDatabase,
  replaceStorageSnapshot,
} = require('../dist/database');
const { emptyStorageData, Storage } = require('../dist/storage');

const APP_NAME = 'flowsbiz_txn_test';

function assertSafeTestDatabase(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const testName = parsed.pathname.toLowerCase().includes('test');
  if (!local || !testName) {
    throw new Error('Refusing to run: TEST_DATABASE_URL must point to a local database whose name contains "test".');
  }
}

function withAppName(databaseUrl, appName) {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.set('application_name', appName);
  return parsed.toString();
}

async function clearData(pool) {
  const serviceBotTable = await pool.query("select to_regclass('public.service_bot_state') as name");
  if (serviceBotTable.rows[0]?.name) {
    await pool.query('truncate table service_bot_state restart identity');
  }
  await pool.query(`truncate table
    scheduled_jobs, conversation_state, outbox_messages, twilio_templates,
    uploaded_files, saved_contacts, contact_queue, campaign_events,
    campaign_results, campaigns, client_profile, admin_settings, app_state
    restart identity`);
}

/**
 * The decisive check. `diagPool` is a SEPARATE pool with its own
 * application_name, so it never counts itself. Everything it reports is
 * attributable to the code under test.
 */
async function transactionLeak(diagPool) {
  const { rows } = await diagPool.query(
    `select
       (select count(*)::int from pg_stat_activity
         where application_name = $1 and state = 'idle in transaction') as idle_in_txn,
       (select count(*)::int from pg_locks l
          join pg_stat_activity a on a.pid = l.pid
         where a.application_name = $1
           and a.state = 'idle in transaction') as locks_held_by_idle_txn`,
    [APP_NAME],
  );
  return rows[0];
}

// Poll briefly: a correctly committed+released connection turns 'idle'
// almost immediately, but give the driver a beat to release.
async function waitForQuiet(diagPool, label) {
  let last;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    last = await transactionLeak(diagPool);
    if (last.idle_in_txn === 0 && last.locks_held_by_idle_txn === 0) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${label}: ${JSON.stringify(last)} - a connection was left idle in transaction (B2-1 regression)`);
  return last;
}

async function main() {
  const baseUrl = process.env.TEST_DATABASE_URL
    || 'postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test';
  assertSafeTestDatabase(baseUrl);
  const backendUrl = withAppName(baseUrl, APP_NAME);

  const diagPool = new Pool({ connectionString: withAppName(baseUrl, 'flowsbiz_txn_test_diag') });
  const setupPool = new Pool({ connectionString: withAppName(baseUrl, 'flowsbiz_txn_test_setup') });

  try {
    await clearData(setupPool);

    // ---- 1. Parallel write flood ------------------------------------------
    // Real Storage, real backend, real Postgres. One write per macrotask
    // tick (setImmediate, not setTimeout) so writes arrive faster than a
    // single drain cycle finishes and the backend coalesces many of them.
    {
      const backend = await createPostgresBackend(backendUrl);
      const storage = new Storage('unused-txn-test.json', { initialData: emptyStorageData(), backend });
      await storage.flush();

      const N = 250;
      const started = Date.now();
      for (let i = 0; i < N; i += 1) {
        storage.enqueueOutboxMessage({ kind: 'text', to: `whatsapp:97250${String(i).padStart(7, '0')}`, text: `flood-${i}` });
        await new Promise((r) => setImmediate(r));
      }
      await storage.flush();
      const elapsedMs = Date.now() - started;

      const leak = await waitForQuiet(diagPool, '1. after parallel flood');
      assert.equal(leak.idle_in_txn, 0);
      assert.equal(leak.locks_held_by_idle_txn, 0);

      const reloaded = await loadStorageSnapshot(baseUrl);
      const landed = reloaded.outboxMessages.filter((m) => m.text && m.text.startsWith('flood-')).length;
      assert.equal(landed, N, `all ${N} flooded writes must be durable, got ${landed}`);

      console.log(`1. ${N} coalesced writes in ${elapsedMs}ms -> 0 idle-in-transaction, 0 locks held by idle txn, all ${landed} rows durable.`);
      await backend.close();
    }

    // ---- 2. Commit under pool contention --------------------------------
    // Other queries fight for connections on the SAME pool while a delta
    // commits. With begin/commit pinned to one client this is a non-event;
    // with the old pool.query() pattern the BEGIN connection gets stolen and
    // stranded.
    {
      const pool = new Pool({ connectionString: backendUrl, max: 5 });
      const prev = emptyStorageData();

      const pressure = Array.from({ length: 4 }, () => (async () => {
        for (let i = 0; i < 30; i += 1) await pool.query('select pg_sleep(0.01)');
      })());

      for (let round = 0; round < 6; round += 1) {
        const data = emptyStorageData();
        data.campaigns.push({ id: `c-contend-${round}`, triggerPhrase: `t${round}`, active: false });
        for (let i = 0; i < 5; i += 1) {
          data.outboxMessages.push({
            id: `ob-contend-${round}-${i}`, kind: 'text', to: `whatsapp:9725111${round}${i}`,
            status: 'queued', attempts: 0, text: 'x',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          });
        }
        await writeSnapshotDelta(pool, prev, data, new Set(['campaigns', 'outboxMessages']), {});
      }
      await Promise.all(pressure);

      const leak = await waitForQuiet(diagPool, '2. after contended commits');
      assert.equal(leak.idle_in_txn, 0);
      assert.equal(leak.locks_held_by_idle_txn, 0);
      const persisted = await diagPool.query("select count(*)::int as n from campaigns where id like 'c-contend-%'");
      assert.equal(persisted.rows[0].n, 6, 'all 6 contended deltas must have committed');
      console.log('2. 6 deltas committed while 4 workers fought for pool connections -> 0 idle-in-transaction, all committed.');

      await pool.end();
    }

    // ---- 3. Rollback on mid-transaction failure -------------------------
    // A delta touches campaigns (valid) then outbox_messages (recipient
    // NULL -> NOT NULL violation). The whole delta must roll back: the
    // campaign row must NOT survive, and the connection must return to the
    // pool usable.
    {
      await clearData(setupPool);
      const pool = new Pool({ connectionString: backendUrl, max: 3 });
      const prev = emptyStorageData();

      const broken = emptyStorageData();
      broken.campaigns.push({ id: 'c-should-rollback', triggerPhrase: 'nope', active: false });
      broken.outboxMessages.push({
        id: 'ob-broken', kind: 'text', to: null, status: 'queued', attempts: 0, text: 'x',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      await assert.rejects(
        () => writeSnapshotDelta(pool, prev, broken, new Set(['campaigns', 'outboxMessages']), {}),
        /null value|not-null|violates/i,
        'a NOT NULL violation inside the delta must reject',
      );

      const leak = await waitForQuiet(diagPool, '3. after failed delta');
      assert.equal(leak.idle_in_txn, 0);

      const partial = await diagPool.query("select count(*)::int as n from campaigns where id = 'c-should-rollback'");
      assert.equal(partial.rows[0].n, 0, 'the campaign written before the failing statement must have been rolled back');

      // Connection healthy: a clean delta on the same pool still works.
      const good = emptyStorageData();
      good.campaigns.push({ id: 'c-after-rollback', triggerPhrase: 'ok', active: false });
      await writeSnapshotDelta(pool, prev, good, new Set(['campaigns']), {});
      const recovered = await diagPool.query("select count(*)::int as n from campaigns where id = 'c-after-rollback'");
      assert.equal(recovered.rows[0].n, 1, 'the pool must be usable after a rolled-back delta');

      console.log('3. mid-delta NOT NULL violation -> full rollback (0 partial rows), 0 idle-in-transaction, pool still usable.');
      await pool.end();
    }

    // ---- 4. applyMigrations under contention -----------------------------
    // migrateDatabase opens its own pool and runs the whole migration set
    // (each one begin..DDL..insert into schema_migrations..commit on one
    // dedicated client). Drop schema_migrations first so every migration
    // actually executes its transaction instead of short-circuiting on the
    // "already applied" check - otherwise this would test nothing.
    {
      await setupPool.query('drop table if exists schema_migrations cascade');

      const pressureUrl = withAppName(baseUrl, 'flowsbiz_txn_test_pressure_migrate');
      const pressurePool = new Pool({ connectionString: pressureUrl, max: 4 });
      const pressure = Array.from({ length: 4 }, () => (async () => {
        for (let i = 0; i < 25; i += 1) await pressurePool.query('select pg_sleep(0.01)');
      })());

      const migrateUrl = withAppName(baseUrl, APP_NAME);
      await migrateDatabase(migrateUrl);
      await Promise.all(pressure);
      await pressurePool.end();

      const leak = await waitForQuiet(diagPool, '4. after applyMigrations under contention');
      assert.equal(leak.idle_in_txn, 0);
      assert.equal(leak.locks_held_by_idle_txn, 0);

      const applied = await diagPool.query('select count(*)::int as n from schema_migrations');
      assert.ok(applied.rows[0].n > 0, 'every migration must have committed its schema_migrations row');
      const tableExists = await diagPool.query("select to_regclass('public.outbox_messages') as name");
      assert.ok(tableExists.rows[0].name, 'migrated schema must actually be present (not just the registry row)');

      console.log(`4. applyMigrations under contention -> 0 idle-in-transaction, ${applied.rows[0].n} migrations committed, schema present.`);
    }

    // ---- 5. writeSnapshot (full rewrite) under contention -----------------
    // replaceStorageSnapshot opens its own pool and calls writeSnapshot,
    // which rewrites every table in one begin..commit on one dedicated
    // client - the path used by import/restore, not the per-message hot path.
    {
      await clearData(setupPool);

      const pressureUrl = withAppName(baseUrl, 'flowsbiz_txn_test_pressure_snapshot');
      const pressurePool = new Pool({ connectionString: pressureUrl, max: 4 });
      const pressure = Array.from({ length: 4 }, () => (async () => {
        for (let i = 0; i < 25; i += 1) await pressurePool.query('select pg_sleep(0.01)');
      })());

      const snapshotUrl = withAppName(baseUrl, APP_NAME);
      const data = emptyStorageData();
      data.campaigns.push({ id: 'c-full-snapshot', triggerPhrase: 'full', active: true });
      for (let i = 0; i < 20; i += 1) {
        data.outboxMessages.push({
          id: `ob-full-${i}`, kind: 'text', to: `whatsapp:9725222${String(i).padStart(4, '0')}`,
          status: 'queued', attempts: 0, text: 'x',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }
      await replaceStorageSnapshot(snapshotUrl, data, { force: true });
      await Promise.all(pressure);
      await pressurePool.end();

      const leak = await waitForQuiet(diagPool, '5. after writeSnapshot under contention');
      assert.equal(leak.idle_in_txn, 0);
      assert.equal(leak.locks_held_by_idle_txn, 0);

      const reloaded = await loadStorageSnapshot(baseUrl);
      assert.equal(reloaded.campaigns.length, 1, 'the full-rewrite snapshot must have landed');
      assert.equal(reloaded.outboxMessages.length, 20, 'every row from the full-rewrite snapshot must have landed');

      console.log('5. writeSnapshot (full rewrite) under contention -> 0 idle-in-transaction, full snapshot durable.');
    }

    console.log('\nPostgreSQL transaction test passed: transactions are pinned to one connection, nothing is stranded, failures roll back whole.');
  } finally {
    await clearData(setupPool).catch(() => {});
    await diagPool.end().catch(() => {});
    await setupPool.end().catch(() => {});
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
