const { Pool } = require('pg');
const { createPostgresBackend, loadStorageSnapshot, replaceStorageSnapshot } = require('../dist/database');
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
  await pool.query(`truncate table
    scheduled_jobs, conversation_state, outbox_messages, twilio_templates,
    uploaded_files, saved_contacts, contact_queue, campaign_events,
    campaign_results, campaigns, client_profile, admin_settings, app_state
    restart identity`);
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL
    || 'postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test';
  assertSafeTestDatabase(databaseUrl);

  const pool = new Pool({ connectionString: databaseUrl });
  let backend;
  try {
    await clearData(pool);
    await replaceStorageSnapshot(databaseUrl, emptyStorageData());
    backend = await createPostgresBackend(databaseUrl);
    const storage = new Storage('unused-postgres-burst.json', {
      initialData: emptyStorageData(),
      backend,
    });

    const total = 2000;
    const started = Date.now();
    for (let index = 0; index < total; index += 1) {
      storage.enqueueOutboxMessage({
        kind: 'text',
        to: `97250${String(index).padStart(7, '0')}`,
        text: `burst-${index}`,
        idempotencyKey: `burst:${index}`,
      });
      if (storage.getStorageHealth().pendingWrites > 1) {
        throw new Error('PostgreSQL write coalescing queued more than one pending snapshot.');
      }
    }

    await storage.flush();
    const rows = await pool.query('select count(*)::int as count from outbox_messages');
    if (rows.rows[0].count !== total) {
      throw new Error(`Expected ${total} persisted rows, got ${rows.rows[0].count}.`);
    }
    const snapshot = await loadStorageSnapshot(databaseUrl);
    if (!snapshot || snapshot.outboxMessages.length !== total) {
      throw new Error(`Expected ${total} reconstructed snapshot messages.`);
    }
    const appState = await pool.query("select jsonb_array_length(data->'outboxMessages')::int as count from app_state where key = 'storage'");
    if (appState.rows[0].count !== 0) {
      throw new Error('Burst runtime writes unexpectedly rewrote app_state.');
    }

    const elapsedMs = Date.now() - started;
    console.log(`PostgreSQL burst test passed: ${total} writes, ${elapsedMs}ms.`);
    await storage.close();
    backend = null;
  } finally {
    if (backend) await backend.close().catch(() => {});
    await clearData(pool).catch(() => {});
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

