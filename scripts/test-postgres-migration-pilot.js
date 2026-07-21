#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { loadStorageDataFromFile } = require('../dist/storage');
const { loadStorageSnapshot } = require('../dist/database');

const ROOT = path.resolve(__dirname, '..');
const DATA_TABLES = {
  adminSettings: 'admin_settings',
  clientProfile: 'client_profile',
  campaigns: 'campaigns',
  campaignResults: 'campaign_results',
  campaignEvents: 'campaign_events',
  contactQueue: 'contact_queue',
  contacts: 'saved_contacts',
  uploadedFiles: 'uploaded_files',
  twilioTemplates: 'twilio_templates',
  outboxMessages: 'outbox_messages',
  pendingConversations: 'conversation_state',
  scheduledJobs: 'scheduled_jobs',
};

function storageCounts(data) {
  return {
    adminSettings: data?.adminSettings ? 1 : 0,
    clientProfile: data?.clientProfile ? 1 : 0,
    campaigns: data?.campaigns?.length ?? 0,
    campaignResults: data?.campaignResults?.length ?? 0,
    campaignEvents: data?.campaignEvents?.length ?? 0,
    contactQueue: data?.contactQueue?.length ?? 0,
    contacts: data?.contactsList?.length ?? 0,
    uploadedFiles: data?.uploadedFiles?.length ?? 0,
    twilioTemplates: data?.twilioTemplates?.length ?? 0,
    outboxMessages: data?.outboxMessages?.length ?? 0,
    pendingConversations: Object.keys(data?.conversationStateSnapshot?.conversations ?? {}).length,
    scheduledJobs: data?.scheduledJobs?.length ?? 0,
  };
}

function printStep(label, status, detail) {
  console.log(`[${status}] ${label}${detail ? ` - ${detail}` : ''}`);
}

function runNodeScript(label, script, args, env, expectedFailure) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();

  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (!expectedFailure && result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}.\n${output}`);
  }
  if (expectedFailure && result.status === 0) {
    throw new Error(`${label} unexpectedly succeeded.`);
  }

  printStep(label, 'PASS');
  return output;
}

async function tableCounts(pool) {
  const counts = {};
  for (const [label, table] of Object.entries(DATA_TABLES)) {
    const exists = await pool.query('select to_regclass($1) as name', [`public.${table}`]);
    if (!exists.rows[0]?.name) {
      counts[label] = 0;
      continue;
    }
    const result = await pool.query(`select count(*)::integer as count from "${table}"`);
    counts[label] = result.rows[0].count;
  }
  return counts;
}

function assertCountsMatch(expected, actual, source) {
  const differences = Object.keys(expected)
    .filter((key) => expected[key] !== actual[key])
    .map((key) => `${key}: JSON=${expected[key]}, ${source}=${actual[key]}`);
  if (differences.length) {
    throw new Error(`Count mismatch against ${source}:\n${differences.join('\n')}`);
  }
}

function safeDatabaseLabel(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return '(invalid DATABASE_URL)';
  }
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  const storagePathValue = String(process.env.STORAGE_PATH || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required and must point to an empty pilot database.');
  if (!storagePathValue) throw new Error('STORAGE_PATH is required and must point to the JSON snapshot.');

  const storagePath = path.resolve(storagePathValue);
  if (!fs.existsSync(storagePath) || !fs.statSync(storagePath).isFile()) {
    throw new Error(`STORAGE_PATH does not point to a readable file: ${storagePath}`);
  }

  const exportPath = process.env.POSTGRES_MIGRATION_PILOT_EXPORT_PATH
    ? path.resolve(process.env.POSTGRES_MIGRATION_PILOT_EXPORT_PATH)
    : path.join(os.tmpdir(), `flowsbiz-postgres-migration-pilot-${Date.now()}-${process.pid}.json`);
  if (fs.existsSync(exportPath)) {
    throw new Error(`Pilot export path already exists: ${exportPath}`);
  }
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });

  const source = loadStorageDataFromFile(storagePath);
  const sourceCounts = storageCounts(source);
  const pool = new Pool({ connectionString: databaseUrl });
  const childEnv = { ...process.env, DATABASE_URL: databaseUrl, STORAGE_PATH: storagePath };

  console.log('PostgreSQL migration pilot');
  console.log(`Database: ${safeDatabaseLabel(databaseUrl)}`);
  console.log(`Storage: ${storagePath}`);
  console.log(`Export: ${exportPath}`);
  console.log('No application server or background worker will be started.');

  try {
    await pool.query('select 1');
    const initialCounts = await tableCounts(pool);
    const populated = Object.entries(initialCounts).filter(([, count]) => count !== 0);
    if (populated.length) {
      throw new Error(`Pilot database is not empty: ${populated.map(([name, count]) => `${name}=${count}`).join(', ')}`);
    }
    printStep('Empty database preflight', 'PASS');

    runNodeScript('Migration dry-run', 'scripts/migrate-json-to-postgres.js', [], childEnv, false);
    const afterDryRunCounts = await tableCounts(pool);
    const dryRunWrites = Object.entries(afterDryRunCounts).filter(([, count]) => count !== 0);
    if (dryRunWrites.length) {
      throw new Error(`Dry-run wrote application data: ${dryRunWrites.map(([name, count]) => `${name}=${count}`).join(', ')}`);
    }
    printStep('Dry-run left application data empty', 'PASS');

    const firstApply = runNodeScript(
      'First migration apply',
      'scripts/migrate-json-to-postgres.js',
      ['--apply'],
      childEnv,
      false,
    );
    if (!/Import completed/i.test(firstApply)) {
      throw new Error(`First apply did not report a completed import.\n${firstApply}`);
    }

    const secondApply = runNodeScript(
      'Second migration apply',
      'scripts/migrate-json-to-postgres.js',
      ['--apply'],
      childEnv,
      false,
    );
    if (!/Import skipped:.*identical JSON snapshot/i.test(secondApply)) {
      throw new Error(`Second apply did not report an identical skipped snapshot.\n${secondApply}`);
    }
    printStep('Second apply was idempotent', 'PASS', 'identical snapshot skipped');

    const postgresSnapshot = await loadStorageSnapshot(databaseUrl);
    if (!postgresSnapshot) throw new Error('PostgreSQL did not contain a storage snapshot after apply.');

    runNodeScript(
      'First PostgreSQL export',
      'scripts/export-postgres-to-json.js',
      ['--output', exportPath],
      childEnv,
      false,
    );
    if (!fs.existsSync(exportPath)) throw new Error(`Export file was not created: ${exportPath}`);

    const secondExport = runNodeScript(
      'Second PostgreSQL export without --force',
      'scripts/export-postgres-to-json.js',
      ['--output', exportPath],
      childEnv,
      true,
    );
    if (!/Output already exists:.*--force/is.test(secondExport)) {
      throw new Error(`Second export failed for an unexpected reason.\n${secondExport}`);
    }
    printStep('Existing export was protected', 'PASS', 'overwrite refused without --force');

    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    const postgresCounts = storageCounts(postgresSnapshot);
    const exportedCounts = storageCounts(exported);
    const relationalCounts = await tableCounts(pool);
    assertCountsMatch(sourceCounts, postgresCounts, 'PostgreSQL snapshot');
    assertCountsMatch(sourceCounts, relationalCounts, 'PostgreSQL tables');
    assertCountsMatch(sourceCounts, exportedCounts, 'exported JSON');
    printStep('JSON/PostgreSQL/export counts match', 'PASS');

    console.table(Object.fromEntries(
      Object.keys(sourceCounts).map((key) => [key, {
        JSON: sourceCounts[key],
        PostgreSQL: postgresCounts[key],
        Tables: relationalCounts[key],
        Export: exportedCounts[key],
      }]),
    ));
    console.log(`\nPOSTGRES MIGRATION PILOT: PASS\nExport file: ${exportPath}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\nPOSTGRES MIGRATION PILOT: FAIL\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
