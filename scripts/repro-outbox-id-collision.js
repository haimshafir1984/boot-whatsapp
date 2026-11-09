'use strict';
/**
 * REPRODUCTION (not a regression test; not in the manifest): two outbox messages that receive the same id.
 *
 * Why: scripts/test-flush-scoped-wait.js occasionally ends with exactly ONE row missing in PostgreSQL after a 1.2s flood (~5,700 writes;
 * ~3 failures in ~31 runs, also on a clean master). storage.generateId() is Date.now() in base-36 + 4 random base-36 characters, and an
 * outbox row is written with `insert ... on conflict (id) do update`, so two messages with the same id would stay two rows in memory but
 * become ONE row in the database. This script forces that collision deterministically (Date.now and Math.random frozen for exactly two
 * synchronous enqueue calls, restored before any await) and prints what the memory array and the database end up holding.
 *
 * Run against a LOCAL TEST database only:  node scripts/repro-outbox-id-collision.js
 * Exit code 0 = no data was lost (after a fix), 2 = a message was lost (the current behaviour), 1 = the script itself failed.
 */
process.env.NODE_ENV = 'test';
const { Pool } = require('pg');
const { createPostgresBackend, loadStorageSnapshot } = require('../dist/database');
const { emptyStorageData, Storage } = require('../dist/storage');

function assertSafeTestDatabase(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (!local || !parsed.pathname.toLowerCase().includes('test')) {
    throw new Error('Refusing to run: TEST_DATABASE_URL must point to a local database whose name contains "test".');
  }
}

async function clearOutbox(pool) {
  await pool.query('truncate table outbox_messages restart identity');
}

/** Run fn with Date.now and Math.random frozen. fn must be synchronous so nothing else can observe the frozen clock. */
function frozen(fn) {
  const realNow = Date.now; const realRandom = Math.random;
  Date.now = () => 1_800_000_000_000; Math.random = () => 0.123456789;
  try { return fn(); } finally { Date.now = realNow; Math.random = realRandom; }
}

(async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL || 'postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test';
  assertSafeTestDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await clearOutbox(pool);
    const backend = await createPostgresBackend(databaseUrl);
    const storage = new Storage('unused-collision.json', { initialData: emptyStorageData(), backend });
    await storage.flush();

    // Two DIFFERENT messages (different recipients and text) enqueued in the same millisecond with the same random draw.
    const [a, b] = frozen(() => [
      storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000001', text: 'message A' }),
      storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000002', text: 'message B' }),
    ]);
    await storage.flush();

    const inMemory = storage.data.outboxMessages;
    const reloaded = await loadStorageSnapshot(databaseUrl);
    const dbRows = reloaded.outboxMessages;
    const dbRow = dbRows.find((m) => m.id === a.id);
    console.log('--- result');
    console.log(`ids returned by enqueue:  A=${a.id}  B=${b.id}  ${a.id === b.id ? '(IDENTICAL)' : '(distinct)'}`);
    console.log(`rows in memory:           ${inMemory.length}   unique ids in memory: ${new Set(inMemory.map((m) => m.id)).size}`);
    console.log(`rows in PostgreSQL:       ${dbRows.length}`);
    if (dbRow) console.log(`the surviving DB row is:  to=${dbRow.to} text="${dbRow.text}"`);
    const lost = a.id === b.id && dbRows.length < inMemory.length;
    console.log(lost
      ? 'LOST: two messages shared an id, memory holds both, the database holds one (the other was overwritten).'
      : 'OK: no message lost.');
    await backend.close();
    process.exitCode = lost ? 2 : 0;
  } finally {
    await pool.end();
  }
})().catch((err) => { console.error('repro failed:', err); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
