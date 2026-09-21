#!/usr/bin/env node
/**
 * JSON -> PostgreSQL inbox migration tool (stage E / C5). Build first (npm run build).
 *
 *   node scripts/inbox-migrate.js dry-run  --role client|gateway --source-file F [--namespace N] [--database-url URL]
 *        READ-ONLY. Writes nothing (no backup, no schema, no ledger). Reports status counts, missing identities, duplicate
 *        conflicts, invalid timestamps, malformed payloads, how `processing` items would be classified, the state of the target.
 *   node scripts/inbox-migrate.js apply    ... --backup-dir D --confirm-stopped [--batch-size 500]
 *        Stop every writer first. Backup + checksum, idempotent checkpointed import, verification, THEN activation.
 *   node scripts/inbox-migrate.js status   ...   ledger + marker state
 *   node scripts/inbox-migrate.js export   ... --out FILE --confirm-stopped     legacy-format file with EVERY sql item (verified)
 *   node scripts/inbox-migrate.js rollback ... --confirm-stopped [--use-export FILE]
 *        Before SQL did any work: restores the untouched original byte-for-byte. After: refuses unless a verified export is given.
 * The database URL comes from --database-url, else INBOX_DATABASE_URL, else DATABASE_URL. Passwords are never printed.
 */
const path = require('node:path');
const { createInboxPool } = require('../dist/inbox/schema');
const m = require('../dist/inbox/migration');

const args = process.argv.slice(2);
const cmd = args[0];
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes('--' + n);
const role = arg('role');
const sourceFile = arg('source-file');
if (!['dry-run', 'apply', 'status', 'export', 'rollback'].includes(cmd) || !['gateway', 'client'].includes(role) || !sourceFile) {
  console.error('usage: inbox-migrate.js <dry-run|apply|status|export|rollback> --role gateway|client --source-file FILE [--namespace N] [--database-url URL] [--backup-dir D] [--confirm-stopped] [--out FILE] [--use-export FILE]');
  process.exit(2);
}
const namespace = arg('namespace', role === 'gateway' ? 'gateway' : 'client');
const url = arg('database-url', process.env.INBOX_DATABASE_URL || process.env.DATABASE_URL || '');
const opts = { role, namespace, sourceFile: path.resolve(sourceFile), backupDir: path.resolve(arg('backup-dir', path.join(path.dirname(path.resolve(sourceFile)), 'inbox-migration-backups'))), batchSize: Number(arg('batch-size', '500')), confirmStopped: flag('confirm-stopped'), failAfterBatch: arg('fail-after-batch') ? Number(arg('fail-after-batch')) : undefined };

(async () => {
  if (cmd === 'dry-run') {
    // A dry-run may inspect the target, but only in a READ ONLY transaction and only if a URL was given.
    const pool = url ? createInboxPool(url, { max: 1 }) : null;
    try { console.log(JSON.stringify(await m.dryRun(pool, opts), null, 1)); } finally { if (pool) await pool.end(); }
    return;
  }
  if (!url) { console.error('no database URL (--database-url, INBOX_DATABASE_URL or DATABASE_URL)'); process.exit(2); }
  const pool = createInboxPool(url, { max: 4 });
  try {
    let out;
    if (cmd === 'apply') out = await m.applyMigration(pool, opts);
    else if (cmd === 'export') out = await m.exportLegacy(pool, { role, namespace, outFile: path.resolve(arg('out', '')), confirmStopped: opts.confirmStopped });
    else if (cmd === 'rollback') out = await m.rollback(pool, { role, namespace, sourceFile: opts.sourceFile, useExport: arg('use-export') ? path.resolve(arg('use-export')) : undefined, confirmStopped: opts.confirmStopped });
    else {
      const l = await pool.query('select source_id, source_sha256, status, started_at, finished_at from inbox_import_ledger where source_id = $1', [m.sourceIdOf(opts)]);
      out = { ledger: l.rows[0] ?? null, markerPresent: require('node:fs').existsSync(m.markerPath(opts.sourceFile)) };
    }
    console.log(JSON.stringify(out, null, 1));
  } finally { await pool.end(); }
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
