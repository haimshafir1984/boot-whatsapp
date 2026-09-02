'use strict';

/**
 * flush() used to wait for the whole persistence layer to go quiet:
 *
 *   do { await this.pending } while (this.draining || this.queuedSnapshot);
 *
 * Under sustained write traffic - many senders' conversations, contact
 * saves and campaign events all persisting at overlapping times - a
 * caller's flush() waited for a moment of *global* quiet that might not
 * arrive for tens of seconds, even though its own write landed in the very
 * first drain cycle. This sits directly in the outbound path
 * (sendTrackedOutboxMessage flushes BEFORE calling Meta, to not lose an
 * outbox row on restart), so it showed up in production as exactly what
 * was measured: the trigger matches instantly, the first message to Meta
 * is delayed ~40s under load.
 *
 * flush() now captures writeSeq at call time and returns once durableSeq
 * has reached it - everything requested before the call, nothing queued
 * after. A failed cycle is remembered per generation, so the caller whose
 * own write failed throws, while a later caller whose generation has since
 * committed does not inherit the stale error.
 *
 * Runs against a REAL local Postgres (same convention as
 * test-postgres-delta.js). It proves:
 *
 *   1. 150+ unrelated writes flooding the backend do not delay a single
 *      caller's flush() - it returns on its own generation, while the
 *      flood is still arriving. Time is measured, not assumed.
 *   2. Nothing is lost under that flood: a fresh backend rebuilt from
 *      Postgres shows every flooded write and the awaited one.
 *   3. A deliberate write failure: flush() for that generation rejects
 *      with the real error; a LATER generation that commits afterwards
 *      resolves cleanly and never sees the old error.
 *   4. Shutdown: close() waits for every already-queued write to land,
 *      not just the generation current when it was called.
 *   5. Outbox order and idempotency survive a restart under load - reopen
 *      a backend on the same database: no duplicate ids, no duplicate
 *      idempotency keys, created_at order preserved.
 *
 * The mutation proof (restore the old global-quiet wait, watch check 1
 * fail) is done by hand and recorded in
 * docs/flush-transaction-fix-results-2026-09-02.md.
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createPostgresBackend, loadStorageSnapshot } = require('../dist/database');
const { emptyStorageData, Storage } = require('../dist/storage');

function assertSafeTestDatabase(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const testName = parsed.pathname.toLowerCase().includes('test');
  if (!local || !testName) {
    throw new Error('Refusing to run: TEST_DATABASE_URL must point to a local database whose name contains "test".');
  }
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

const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL
    || 'postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test';
  assertSafeTestDatabase(databaseUrl);

  const setupPool = new Pool({ connectionString: databaseUrl });

  try {
    // ================================================================
    // 1 & 2: flush() returns on its own generation under a write flood,
    //        and nothing is lost.
    // ================================================================
    {
      await clearData(setupPool);
      const backend = await createPostgresBackend(databaseUrl);
      const storage = new Storage('unused-flush-1.json', { initialData: emptyStorageData(), backend });
      await storage.flush();

      // A flood of unrelated writes on every macrotask tick for a fixed
      // wall-clock span, so queuedSnapshot keeps getting re-armed the whole
      // time - not a burst that drains on its own. Each write does real work.
      const FLOOD_DURATION_MS = 1200;
      let floodCount = 0;
      let floodEndedAt = 0;
      const floodStartedAt = Date.now();
      const flood = (async () => {
        while (Date.now() - floodStartedAt < FLOOD_DURATION_MS) {
          storage.enqueueOutboxMessage({ kind: 'text', to: `whatsapp:97250flood${floodCount}`, text: `flood-${floodCount}` });
          floodCount += 1;
          await tick();
        }
        floodEndedAt = Date.now();
      })();

      // Let the flood get genuinely underway (>= 150 writes in flight).
      while (floodCount < 150) await tick();

      // One caller's own write, queued mid-flood - exactly like
      // sendTrackedOutboxMessage's flush() before calling Meta.
      const mine = storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000001', text: 'my message' });
      const before = Date.now();
      await storage.flush();
      const myFlushAt = Date.now();
      const myFlushMs = myFlushAt - before;
      const floodAtFlush = floodCount;

      await flood;
      const totalFlood = floodCount;
      await storage.flush();

      assert.ok(myFlushAt < floodEndedAt,
        `flush() must return while the flood is still arriving (returned +${myFlushAt - floodStartedAt}ms, flood ended +${floodEndedAt - floodStartedAt}ms)`);
      assert.ok(myFlushMs < FLOOD_DURATION_MS,
        `flush() latency (${myFlushMs}ms) must not scale with the flood - it should be a drain cycle, not the whole ${FLOOD_DURATION_MS}ms span`);
      console.log(`1. flush() returned in ${myFlushMs}ms with ${floodAtFlush} unrelated writes already queued (flood reached ${totalFlood}); it did not wait for global quiet.`);

      // 2. Nothing lost: rebuild from Postgres with a fresh backend.
      const reloaded = await loadStorageSnapshot(databaseUrl);
      const ids = new Set(reloaded.outboxMessages.map((m) => m.id));
      assert.ok(ids.has(mine.id), 'the awaited write must be durable in Postgres');
      const floodLanded = reloaded.outboxMessages.filter((m) => m.to.startsWith('whatsapp:97250flood')).length;
      assert.equal(floodLanded, totalFlood, `every flooded write must land eventually (${floodLanded}/${totalFlood})`);
      console.log(`2. reload from Postgres: awaited write + all ${floodLanded} flooded writes present - nothing lost.`);

      await backend.close();
    }

    // ================================================================
    // 3: a failed generation throws for its own caller; a later
    //    generation that commits does NOT inherit the error.
    // ================================================================
    {
      await clearData(setupPool);
      const backend = await createPostgresBackend(databaseUrl);
      const storage = new Storage('unused-flush-3.json', { initialData: emptyStorageData(), backend });
      await storage.flush();

      // Force the next commit to fail: a CHECK constraint the pending row
      // violates. Applied out-of-band so the running app never sees it in a
      // migration.
      await setupPool.query("alter table outbox_messages add constraint tmp_flush_fail check (recipient <> 'whatsapp:BREAKME')");

      let sawError;
      try {
        storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:BREAKME', text: 'doomed' });
        await storage.flush();
      } catch (err) {
        sawError = err;
      }
      assert.ok(sawError, 'flush() for the failed generation must reject');
      assert.match(String(sawError.message), /tmp_flush_fail|check constraint|violates/i,
        `the real write error must surface, got: ${sawError && sawError.message}`);
      console.log(`3a. the caller whose write was in the failed batch got the real error: "${String(sawError.message).split('\n')[0]}".`);

      // Recover: drop the constraint, do a fresh write, flush a LATER
      // generation. It must resolve - not throw the stale error - and the
      // earlier doomed row is retried in the same cycle.
      await setupPool.query('alter table outbox_messages drop constraint tmp_flush_fail');
      const recovered = storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000009', text: 'after recovery' });
      await storage.flush(); // must NOT throw
      console.log('3b. a later generation that committed resolved cleanly - it did not inherit the failed batch\'s error.');

      const reloaded = await loadStorageSnapshot(databaseUrl);
      const rec = reloaded.outboxMessages.map((m) => m.to);
      assert.ok(rec.includes('whatsapp:972500000009'), 'the post-recovery write must be durable');
      assert.ok(rec.includes('whatsapp:BREAKME'), 'the retried doomed write must also be durable once the constraint is gone');
      assert.ok(reloaded.outboxMessages.some((m) => m.id === recovered.id));
      console.log('3c. reload: both the retried write and the recovery write are durable.');

      await backend.close();
    }

    // ================================================================
    // 4: close() drains every queued write, not just the generation
    //    current when it was called.
    // ================================================================
    {
      await clearData(setupPool);
      const backend = await createPostgresBackend(databaseUrl);
      const storage = new Storage('unused-flush-4.json', { initialData: emptyStorageData(), backend });
      await storage.flush();

      const TOTAL = 300;
      for (let i = 0; i < TOTAL; i += 1) {
        storage.enqueueOutboxMessage({ kind: 'text', to: `whatsapp:97253${String(i).padStart(7, '0')}`, text: `shutdown-${i}`, idempotencyKey: `shutdown:${i}` });
        if (i % 25 === 0) await tick(); // let some drain cycles start mid-stream
      }
      // "Closed to new writes" - stop enqueuing, now shut down. Every one of
      // the TOTAL writes above must be durable when close() returns.
      await storage.close();

      const reloaded = await loadStorageSnapshot(databaseUrl);
      assert.equal(reloaded.outboxMessages.length, TOTAL, `close() must flush all ${TOTAL} queued writes, found ${reloaded.outboxMessages.length}`);
      console.log(`4. close() waited for all ${TOTAL} queued writes to land before ending the pool.`);
    }

    // ================================================================
    // 5: outbox order + idempotency survive a restart under load.
    // ================================================================
    {
      await clearData(setupPool);
      let backend = await createPostgresBackend(databaseUrl);
      let storage = new Storage('unused-flush-5.json', { initialData: emptyStorageData(), backend });
      await storage.flush();

      const N = 200;
      const enqueued = [];
      for (let i = 0; i < N; i += 1) {
        const m = storage.enqueueOutboxMessage({ kind: 'text', to: `whatsapp:97254${String(i).padStart(7, '0')}`, text: `ordered-${i}`, idempotencyKey: `ordered:${i}` });
        enqueued.push(m.id);
        if (i % 10 === 0) await tick();
      }
      // Mark a slice as sent, interleaved, to exercise in-place updates too.
      for (let i = 0; i < N; i += 3) storage.markOutboxSent(enqueued[i], `prov-${i}`);
      await storage.flush();
      await storage.close();

      // Restart: brand-new backend on the same database.
      backend = await createPostgresBackend(databaseUrl);
      const snapshot = await backend.loadSnapshot();
      const rows = snapshot.outboxMessages;

      assert.equal(rows.length, N, `restart must reconstruct all ${N} rows, got ${rows.length}`);
      const uniqueIds = new Set(rows.map((r) => r.id));
      assert.equal(uniqueIds.size, N, 'no duplicate outbox ids after restart');
      const keys = rows.map((r) => r.idempotencyKey).filter(Boolean);
      assert.equal(new Set(keys).size, keys.length, 'no duplicate idempotency keys after restart');
      const createdAts = rows.map((r) => r.createdAt);
      const sorted = [...createdAts].sort();
      assert.deepEqual(createdAts, sorted, 'rows come back in created_at order');
      const sentCount = rows.filter((r) => r.status === 'sent').length;
      assert.equal(sentCount, Math.ceil(N / 3), 'in-place "sent" updates survived the restart');
      console.log(`5. restart under load: ${N} rows, ${uniqueIds.size} unique ids, ${new Set(keys).size} unique idempotency keys, created_at order intact, ${sentCount} sent.`);

      await backend.close();
    }

    console.log('\nflush() is scoped to its own write generation, loses nothing under load, surfaces failures to the right caller, and drains fully on shutdown.');
  } finally {
    await setupPool.query('alter table outbox_messages drop constraint if exists tmp_flush_fail').catch(() => {});
    await clearData(setupPool).catch(() => {});
    await setupPool.end().catch(() => {});
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
