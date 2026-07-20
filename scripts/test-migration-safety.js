const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { emptyStorageData } = require('../dist/storage');
const { loadStorageSnapshot, replaceStorageSnapshot } = require('../dist/database');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsbiz-db-export-'));
  const output = path.join(dir, 'rollback.json');
  try {
    await clearData(pool);
    const original = emptyStorageData();
    original.adminSettings.invalidReplyText = 'original';

    const first = await replaceStorageSnapshot(databaseUrl, original);
    if (first !== 'imported') throw new Error('First import was not applied.');
    const repeated = await replaceStorageSnapshot(databaseUrl, original);
    if (repeated !== 'unchanged') throw new Error('Identical import was not treated as idempotent.');

    const changed = JSON.parse(JSON.stringify(original));
    changed.adminSettings.invalidReplyText = 'changed';
    let refused = false;
    try {
      await replaceStorageSnapshot(databaseUrl, changed);
    } catch (err) {
      refused = String(err).includes('Refusing to overwrite');
    }
    if (!refused) throw new Error('Different snapshot was overwritten without force.');

    const stillOriginal = await loadStorageSnapshot(databaseUrl);
    if (stillOriginal.adminSettings.invalidReplyText !== 'original') {
      throw new Error('Refused import changed PostgreSQL data.');
    }

    await replaceStorageSnapshot(databaseUrl, changed, { force: true });
    const exported = spawnSync(
      process.execPath,
      ['scripts/export-postgres-to-json.js', '--output', output],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        encoding: 'utf8',
      },
    );
    if (exported.status !== 0) throw new Error(`Export failed: ${exported.stderr || exported.stdout}`);
    const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (parsed.adminSettings.invalidReplyText !== 'changed') {
      throw new Error('Exported JSON does not match PostgreSQL snapshot.');
    }

    const overwriteAttempt = spawnSync(
      process.execPath,
      ['scripts/export-postgres-to-json.js', '--output', output],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        encoding: 'utf8',
      },
    );
    if (overwriteAttempt.status === 0) throw new Error('Export overwrote an existing file without --force.');

    console.log('Migration guard and PostgreSQL export test passed.');
  } finally {
    await clearData(pool).catch(() => {});
    await pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

