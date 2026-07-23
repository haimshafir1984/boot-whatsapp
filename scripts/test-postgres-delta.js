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
    scheduled_jobs,
    conversation_state,
    outbox_messages,
    twilio_templates,
    uploaded_files,
    saved_contacts,
    contact_queue,
    campaign_events,
    campaign_results,
    campaigns,
    client_profile,
    admin_settings,
    app_state
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

    const storage = new Storage('unused-postgres-test.json', {
      initialData: emptyStorageData(),
      backend,
    });

    const first = storage.enqueueOutboxMessage({
      kind: 'text',
      to: '972501111111',
      text: 'first',
    });
    await storage.flush();
    const before = await pool.query(
      'select xmin::text as version from outbox_messages where id = $1',
      [first.id],
    );
    if (before.rowCount !== 1) throw new Error('First outbox row was not persisted.');

    const second = storage.enqueueOutboxMessage({
      kind: 'text',
      to: '972502222222',
      text: 'second',
    });
    await storage.flush();
    const afterInsert = await pool.query(
      'select id, status, xmin::text as version from outbox_messages order by created_at',
    );
    if (afterInsert.rowCount !== 2) throw new Error(`Expected 2 outbox rows, got ${afterInsert.rowCount}.`);
    const firstAfterInsert = afterInsert.rows.find((row) => row.id === first.id);
    if (firstAfterInsert.version !== before.rows[0].version) {
      throw new Error('Unchanged outbox row was rewritten when another row was inserted.');
    }

    storage.markOutboxSent(second.id, 'provider-message-2');
    await storage.flush();
    const afterUpdate = await pool.query(
      'select id, status, provider_message_id, xmin::text as version from outbox_messages order by created_at',
    );
    const firstAfterUpdate = afterUpdate.rows.find((row) => row.id === first.id);
    const secondAfterUpdate = afterUpdate.rows.find((row) => row.id === second.id);
    if (firstAfterUpdate.version !== before.rows[0].version) {
      throw new Error('Unchanged outbox row was rewritten when another row was updated.');
    }
    if (secondAfterUpdate.status !== 'sent' || secondAfterUpdate.provider_message_id !== 'provider-message-2') {
      throw new Error('Changed outbox row was not updated correctly.');
    }

    storage.saveConversationStateSnapshot({
      version: 1,
      savedAt: new Date().toISOString(),
      conversations: {
        '972501111111@c.us': {
          kind: 'decision',
          senderJid: '972501111111@c.us',
          senderPhone: '972501111111',
          flow: [],
          stepId: 'step-1',
          timestamp: Date.now(),
        },
      },
    });
    await storage.flush();
    const conversations = await pool.query('select jid from conversation_state');
    if (conversations.rowCount !== 1) throw new Error('Conversation state delta was not persisted.');

    storage.saveConversationStateSnapshot({
      version: 1,
      savedAt: new Date().toISOString(),
      conversations: {},
    });
    await storage.flush();
    const removed = await pool.query('select jid from conversation_state');
    if (removed.rowCount !== 0) throw new Error('Removed conversation state remained in PostgreSQL.');

    const unicodeCases = [
      { to: '972503333331', text: 'Broken high surrogate: \ud83d', forbidden: '\ud83d' },
      { to: '972503333332', text: 'Broken low surrogate: \udc00', forbidden: '\udc00' },
      { to: '972503333333', text: 'Embedded NUL: \u0000', forbidden: '\u0000' },
      { to: '972503333334', text: 'Valid emoji remains: \ud83d\ude42', expected: '\ud83d\ude42' },
    ];
    for (const item of unicodeCases) {
      storage.enqueueOutboxMessage({ kind: 'text', to: item.to, text: item.text });
    }
    await storage.flush();
    for (const item of unicodeCases) {
      const persisted = await pool.query(
        "select data->>'text' as text from outbox_messages where recipient = $1 order by created_at desc limit 1",
        [item.to],
      );
      if (persisted.rowCount !== 1) throw new Error(`Unicode outbox row was not persisted for ${item.to}.`);
      if (item.forbidden && persisted.rows[0].text.includes(item.forbidden)) {
        throw new Error(`Invalid Unicode was not sanitized for ${item.to}.`);
      }
      if (item.expected && !persisted.rows[0].text.includes(item.expected)) {
        throw new Error(`Valid Unicode was changed for ${item.to}.`);
      }
    }

    const runtimeSnapshot = await loadStorageSnapshot(databaseUrl);
    if (!runtimeSnapshot || runtimeSnapshot.outboxMessages.length !== 6) {
      throw new Error('Runtime snapshot was not reconstructed from normalized tables.');
    }
    const appState = await pool.query("select jsonb_array_length(data->'outboxMessages')::int as count from app_state where key = 'storage'");
    if (appState.rows[0].count !== 0) {
      throw new Error('Runtime delta unexpectedly rewrote the app_state checkpoint.');
    }

    await storage.close();
    backend = null;
    const restartedBackend = await createPostgresBackend(databaseUrl);
    const restartedSnapshot = await restartedBackend.loadSnapshot();
    if (!restartedSnapshot || restartedSnapshot.outboxMessages.length !== 6) {
      throw new Error('Restart did not reconstruct the latest normalized state.');
    }
    await restartedBackend.close();
    console.log('PostgreSQL delta persistence test passed.');
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

