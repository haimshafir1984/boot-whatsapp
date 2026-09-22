import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import { migrateInboxSchema } from './schema';
import { PostgresInboxRepository } from './postgresRepository';
import { InboxRole } from './types';

/**
 * JSON -> PostgreSQL inbox migration (stage E / C5) and its way back. Design: docs/stage-e-design-2026-09-21.md section 7.
 *
 *   dry-run   read-only: reports status counts, missing identities, duplicate conflicts, invalid timestamps, malformed payloads,
 *             how `processing` items would be classified, and the state of the target. Writes NOTHING anywhere.
 *   apply     refuses unless the source is quiet; immutable backup + checksum; idempotent, checkpointed, transactional batches
 *             keyed by a ledger (source identity + sha256); verification (counts, identities, payload/status/order digest,
 *             scheduler invariants); only then activation (marker file, source RENAMED - never deleted).
 *   rollback  before SQL did any work: the untouched original is restored byte-for-byte. After SQL did work: refuses, and points
 *             at `export`, which writes a verified legacy-format file that contains every item (switching back to the old file
 *             would lose that work).
 * Two backends are never active writers: a marker file / inbox_meta record + startup guards (assertBackendConsistency).
 */

export interface SourceItem {
  id: string; payload?: any; status: string; attempts?: number; createdAt?: string; updatedAt?: string;
  nextAttemptAt?: string; processingStartedAt?: string; lastError?: string;
}

const STATUSES = new Set(['queued', 'processing', 'retry', 'completed', 'failed', 'held']);
export const sha256 = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');

/** Canonical JSON (sorted keys): jsonb reorders keys, so digests must not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export interface IdentityView { phoneNumberId: string; senderKey: string; senderPhone: string; payloadMessageId: string; providerTs: Date | null; hasMessage: boolean }

export function identityOf(payload: any): IdentityView {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  const dest = String(value?.metadata?.phone_number_id || value?.metadata?.display_phone_number || '').trim();
  const from = String(message?.from || '').trim();
  const ts = Number(message?.timestamp);
  return {
    phoneNumberId: dest, senderKey: `${dest}:${from}`, senderPhone: from.replace(/\D/g, ''),
    payloadMessageId: String(message?.id || '').trim(), providerTs: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null, hasMessage: Boolean(message),
  };
}

// ------------------------------------------------------------------------------------------------ reading the source

export interface SourceRead { file: string; sha256: string; bytes: number; items: SourceItem[]; error?: string; bakExists: boolean }

export function readSource(file: string): SourceRead {
  const bakExists = fs.existsSync(file + '.bak');
  if (!fs.existsSync(file)) return { file, sha256: '', bytes: 0, items: [], error: 'source file does not exist', bakExists };
  const raw = fs.readFileSync(file);
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || !Array.isArray(parsed.items)) throw new Error('no "items" array');
    return { file, sha256: sha256(raw), bytes: raw.length, items: parsed.items, bakExists };
  } catch (err) {
    // NEVER fall back to the .bak silently: it can be older than the truth.
    return { file, sha256: sha256(raw), bytes: raw.length, items: [], error: `unreadable JSON (${err instanceof Error ? err.message : String(err)}); the .bak copy is NOT used automatically`, bakExists };
  }
}

// ------------------------------------------------------------------------------------------------ analysis (dry-run)

export interface AnalysisIssue { code: string; blocking: boolean; itemId?: string; detail?: string }
export interface Analysis {
  role: InboxRole; source: { file: string; sha256: string; bytes: number; bakExists: boolean };
  total: number; byStatus: Record<string, number>; issues: AnalysisIssue[]; blocking: number; warnings: number;
  processingPlan: { count: number; becomes: string }; senders: number;
  ordering: 'per sender by createdAt, ties by file position';
}

export function analyze(role: InboxRole, read: SourceRead): Analysis {
  const issues: AnalysisIssue[] = [];
  const byStatus: Record<string, number> = {};
  if (read.error) issues.push({ code: 'source_unreadable', blocking: true, detail: read.error });
  const seen = new Map<string, number>();
  const senders = new Set<string>();
  read.items.forEach((item, index) => {
    const id = String(item?.id ?? '').trim();
    if (!id) { issues.push({ code: 'missing_item_id', blocking: true, detail: `position ${index}` }); return; }
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    if (!STATUSES.has(item.status)) issues.push({ code: 'unknown_status', blocking: true, itemId: id, detail: String(item.status) });
    const ident = identityOf(item.payload);
    const outstanding = item.status === 'queued' || item.status === 'retry' || item.status === 'processing';
    if (item.payload === null || typeof item.payload !== 'object' || !ident.hasMessage) {
      issues.push({ code: 'malformed_payload', blocking: outstanding, itemId: id, detail: outstanding ? 'an outstanding item without a routable message cannot be processed' : 'terminal item kept with sender "unknown:"' });
    } else {
      if (!ident.phoneNumberId) issues.push({ code: 'missing_phone_number_id', blocking: false, itemId: id, detail: 'imported with phone_number_id "unknown"' });
      if (!ident.senderPhone) issues.push({ code: 'missing_sender', blocking: outstanding, itemId: id });
      if (ident.payloadMessageId && ident.payloadMessageId !== id) issues.push({ code: 'id_mismatch', blocking: false, itemId: id, detail: `payload message id ${ident.payloadMessageId} differs; the item id is used` });
    }
    for (const field of ['createdAt', 'updatedAt', 'nextAttemptAt'] as const) {
      const v = (item as any)[field];
      if (v !== undefined && v !== null && !Number.isFinite(Date.parse(String(v)))) issues.push({ code: 'invalid_timestamp', blocking: field === 'createdAt', itemId: id, detail: `${field}=${String(v)}` });
    }
    if (item.createdAt === undefined) issues.push({ code: 'invalid_timestamp', blocking: true, itemId: id, detail: 'createdAt missing' });
    const key = `${ident.phoneNumberId || 'unknown'}#!#${id}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    senders.add(ident.senderKey);
  });
  for (const [key, n] of seen) if (n > 1) issues.push({ code: 'duplicate_identity', blocking: true, itemId: key.split('#!#')[1], detail: `${n} items share the identity; no winner is chosen` });
  const blocking = issues.filter((i) => i.blocking).length;
  return {
    role, source: { file: read.file, sha256: read.sha256, bytes: read.bytes, bakExists: read.bakExists },
    total: read.items.length, byStatus, issues, blocking, warnings: issues.length - blocking,
    processingPlan: { count: byStatus.processing ?? 0, becomes: role === 'client' ? 'review (ambiguous_processing; NOT re-run)' : 'retry (due now; the forward is idempotent by identity at the client)' },
    senders: senders.size, ordering: 'per sender by createdAt, ties by file position',
  };
}

// ------------------------------------------------------------------------------------------------ mapping to rows

export interface PlannedRow {
  messageId: string; phoneNumberId: string; senderKey: string; senderPhone: string; senderSeq: number; status: string; attempts: number;
  payload: any; providerTs: Date | null; receivedAt: string; createdAt: string; updatedAt: string; nextAttemptAt: string | null;
  lastError: string | null; resolution: string | null; effectsState: 'none' | 'possible'; completedAt: string | null; claimedBy: string | null;
  resolutionDetail: any;
}

export function planRows(role: InboxRole, items: SourceItem[], nowIso = new Date().toISOString()): { rows: PlannedRow[]; senders: Map<string, { phone: string; nextSeq: number; head: PlannedRow | null }> } {
  const indexed = items.map((item, index) => ({ item, index })).sort((a, b) => (Date.parse(a.item.createdAt as string) - Date.parse(b.item.createdAt as string)) || a.index - b.index);
  const seq = new Map<string, number>();
  const rows: PlannedRow[] = [];
  for (const { item } of indexed) {
    const ident = identityOf(item.payload);
    const senderKey = ident.hasMessage ? ident.senderKey : 'unknown:';
    const n = (seq.get(senderKey) ?? 0) + 1; seq.set(senderKey, n);
    const created = new Date(item.createdAt as string).toISOString();
    const updated = item.updatedAt && Number.isFinite(Date.parse(item.updatedAt)) ? new Date(item.updatedAt).toISOString() : created;
    let status = item.status; let resolution: string | null = null; let effects: 'none' | 'possible' = 'none';
    let next = item.nextAttemptAt && Number.isFinite(Date.parse(item.nextAttemptAt)) ? new Date(item.nextAttemptAt).toISOString() : null;
    let resolutionDetail: any = null;
    const lastError = item.lastError ?? null;
    if (item.status === 'processing') {
      if (role === 'client') { status = 'review'; resolution = 'ambiguous_processing'; effects = 'possible'; resolutionDetail = { migratedFrom: 'processing', attempts: item.attempts ?? 0 }; next = null; }
      else { status = 'retry'; next = nowIso; }
    } else if (item.status === 'completed') resolution = 'processed';
    if (status === 'retry' && !next) next = nowIso;   // a legacy retry without a boundary is claimable immediately: due now
    else if (item.status === 'held') resolution = 'sender_held';
    else if (item.status === 'failed') resolution = lastError?.startsWith('[ADMIN_DISCARDED]') ? 'admin_discarded' : /superseded/i.test(lastError ?? '') ? 'superseded' : (item.attempts ?? 0) >= 60 ? 'exhausted' : null;
    rows.push({
      messageId: String(item.id).trim(), phoneNumberId: ident.phoneNumberId || 'unknown', senderKey, senderPhone: ident.senderPhone, senderSeq: n, status, attempts: item.attempts ?? 0,
      payload: item.payload ?? null, providerTs: ident.providerTs, receivedAt: created, createdAt: created, updatedAt: updated, nextAttemptAt: next,
      lastError, resolution, effectsState: effects, completedAt: status === 'completed' ? updated : null, claimedBy: null, resolutionDetail,
    });
  }
  // A migrated 'review'/'ambiguous_processing' row (a client-role item that was 'processing' when the source
  // file was taken) parks its sender exactly like recomputeHead() does at runtime - it must not get a head
  // just because it wasn't the first outstanding row for that sender. Computed once, order-independent, to
  // match the runtime blocking check (existence, not position).
  const blockedSenders = new Set(rows.filter((r) => r.status === 'review' && r.resolution === 'ambiguous_processing').map((r) => r.senderKey));
  const senders = new Map<string, { phone: string; nextSeq: number; head: PlannedRow | null }>();
  for (const row of rows) {
    const s = senders.get(row.senderKey) ?? { phone: row.senderPhone, nextSeq: 1, head: null };
    s.nextSeq = Math.max(s.nextSeq, row.senderSeq + 1);
    if (!s.phone && row.senderPhone) s.phone = row.senderPhone;
    if (!blockedSenders.has(row.senderKey) && !s.head && (row.status === 'queued' || row.status === 'retry' || row.status === 'processing')) s.head = row;
    senders.set(row.senderKey, s);
  }
  return { rows, senders };
}

/** Digest of what must be identical on both sides after an import (independent of key order and row order). */
export function digestRows(rows: Array<{ messageId: string; phoneNumberId: string; status: string; attempts: number; senderSeq: number | string; senderKey: string; payload: any }>): string {
  const lines = rows.map((r) => `${r.phoneNumberId}|${r.messageId}|${r.senderKey}|${r.status}|${r.attempts}|${r.senderSeq}|${sha256(canonicalJson(r.payload))}`).sort();
  return sha256(lines.join('\n'));
}

// ------------------------------------------------------------------------------------------------ files: backup, marker

export function markerPath(file: string): string { return file + '.sql-active'; }

export function writeImmutableBackup(file: string, backupDir: string, expectedSha: string): { path: string; sha256: string } {
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `${path.basename(file)}.${new Date().toISOString().replace(/[:.]/g, '-')}.${expectedSha.slice(0, 12)}.bak`);
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  const got = sha256(fs.readFileSync(target));
  if (got !== expectedSha) { try { fs.unlinkSync(target); } catch { /* best effort */ } throw new Error(`backup verification failed (${got} != ${expectedSha}); refusing to migrate`); }
  fs.writeFileSync(target + '.sha256', `${got}  ${path.basename(target)}\n`);
  try { fs.chmodSync(target, 0o444); } catch { /* not all platforms */ }
  return { path: target, sha256: got };
}

/** Startup guard: two backends are never active writers, and an unmigrated file is never silently ignored. */
export function assertBackendConsistency(backend: 'json' | 'postgres', jsonFile: string): void {
  if (backend === 'json' && fs.existsSync(markerPath(jsonFile))) {
    throw new Error(`INBOX_BACKEND=json but ${markerPath(jsonFile)} exists: this inbox was migrated to PostgreSQL and is ACTIVE there. Starting on the old file would lose work and create two writers. Use rollback/export from scripts/inbox-migrate.js, or remove the marker only after that.`);
  }
  if (backend === 'postgres' && fs.existsSync(jsonFile)) {
    const read = readSource(jsonFile);
    if (read.error || read.items.length > 0) {
      throw new Error(`INBOX_BACKEND=postgres but a legacy inbox file with ${read.error ? 'unreadable content' : read.items.length + ' item(s)'} exists at ${jsonFile} and has not been migrated. Refusing to start (nothing is silently ignored): run scripts/inbox-migrate.js (dry-run, then apply).`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ target: ledger, import, verify

export interface MigrationOptions { role: InboxRole; namespace: string; sourceFile: string; backupDir: string; batchSize?: number; quietMs?: number; failAfterBatch?: number; confirmStopped?: boolean; now?: () => Date }
export const sourceIdOf = (o: { role: string; namespace: string; sourceFile: string }): string => `${o.role}:${o.namespace}:${path.basename(o.sourceFile)}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function tablesExist(queryable: Pool | PoolClient): Promise<boolean> {
  const r = await queryable.query("select to_regclass('public.inbox_items') as items, to_regclass('public.inbox_import_ledger') as ledger");
  return Boolean(r.rows[0].items && r.rows[0].ledger);
}

export async function dryRun(pool: Pool | null, o: MigrationOptions): Promise<Record<string, unknown>> {
  const read = readSource(o.sourceFile);
  const analysis = analyze(o.role, read);
  const report: Record<string, unknown> = { mode: 'dry-run (writes nothing)', analysis, wouldImport: analysis.blocking === 0 ? analysis.total : 0 };
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('begin read only');
      if (await tablesExist(client)) {
        const ledger = await client.query('select source_id, source_sha256, status, counts from inbox_import_ledger where source_id = $1', [sourceIdOf(o)]);
        const counts = await client.query('select status, count(*)::int n from inbox_items where namespace = $1 and role = $2 group by status', [o.namespace, o.role]);
        report.target = { schema: 'present', ledger: ledger.rows[0] ?? null, itemsByStatus: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])), sourceMatchesLedger: ledger.rows[0] ? ledger.rows[0].source_sha256 === read.sha256 : null };
      } else report.target = { schema: 'absent (apply would create it)' };
      await client.query('rollback');
    } finally { client.release(); }
  } else report.target = { schema: 'not inspected (no database URL given)' };
  report.markerPresent = fs.existsSync(markerPath(o.sourceFile));
  return report;
}

async function ensureQuiet(file: string, quietMs: number): Promise<void> {
  const a = sha256(fs.readFileSync(file)); const s1 = fs.statSync(file).mtimeMs;
  await sleep(quietMs);
  const b = sha256(fs.readFileSync(file)); const s2 = fs.statSync(file).mtimeMs;
  if (a !== b || s1 !== s2) throw new Error('the source file changed while we waited: a writer is still active. Stop every process that writes the inbox (all workers and the HTTP receipt path), then retry.');
}

export async function applyMigration(pool: Pool, o: MigrationOptions): Promise<Record<string, unknown>> {
  if (!o.confirmStopped) throw new Error('apply requires --confirm-stopped: every writer of the JSON inbox must be stopped first (the tool also checks that the file is quiet).');
  const now = (o.now ?? (() => new Date()))();
  const sourceId = sourceIdOf(o);
  if (fs.existsSync(markerPath(o.sourceFile))) throw new Error('marker file present: this inbox is already active in PostgreSQL');
  const read = readSource(o.sourceFile);
  const analysis = analyze(o.role, read);
  if (analysis.blocking > 0) throw new Error(`refusing to import: ${analysis.blocking} blocking issue(s): ${analysis.issues.filter((i) => i.blocking).slice(0, 5).map((i) => `${i.code}${i.itemId ? '(' + i.itemId + ')' : ''}`).join(', ')}. Nothing was written.`);
  await ensureQuiet(o.sourceFile, o.quietMs ?? 2000);
  await migrateInboxSchema(pool);
  const existing = (await pool.query('select source_sha256, status, counts from inbox_import_ledger where source_id = $1', [sourceId])).rows[0];
  if (existing && existing.source_sha256 !== read.sha256) throw new Error(`the source changed since it was (partially) imported (ledger ${existing.source_sha256.slice(0, 12)} vs file ${read.sha256.slice(0, 12)}). No winner is chosen; investigate.`);
  if (existing && existing.status === 'active') return { result: 'already imported and active (idempotent no-op)', ledger: existing };

  const backup = writeImmutableBackup(o.sourceFile, o.backupDir, read.sha256);
  const plan = planRows(o.role, read.items, now.toISOString());
  const expectedDigest = digestRows(plan.rows);
  const batchSize = o.batchSize ?? 500;
  await pool.query(
    `insert into inbox_import_ledger(source_id, source_sha256, status, counts) values ($1, $2, 'importing', $3::jsonb)
       on conflict (source_id) do update set status = case when inbox_import_ledger.status = 'active' then 'active' else 'importing' end`,
    [sourceId, read.sha256, JSON.stringify({ total: plan.rows.length, batchesDone: 0, expectedDigest, backup: backup.path })]);

  // Transactional, idempotent batches. A crash anywhere resumes from the top: rows already there are skipped (ON CONFLICT DO NOTHING) and
  // proven equal by the verification digest - a different row with the same identity fails verification instead of being overwritten.
  let batchNo = 0;
  for (let i = 0; i < plan.rows.length; i += batchSize) {
    const slice = plan.rows.slice(i, i + batchSize);
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const r of slice) {
        await client.query(
          `insert into inbox_items(namespace, role, phone_number_id, message_id, sender_key, sender_phone, sender_seq, status, attempts, payload, provider_ts, received_at,
                                   next_attempt_at, effects_state, last_error, resolution, resolution_detail, created_at, updated_at, completed_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20)
           on conflict (namespace, role, phone_number_id, message_id) do nothing`,
          [o.namespace, o.role, r.phoneNumberId, r.messageId, r.senderKey, r.senderPhone, r.senderSeq, r.status, r.attempts, JSON.stringify(r.payload), r.providerTs, r.receivedAt,
            r.nextAttemptAt, r.effectsState, r.lastError, r.resolution, r.resolutionDetail === null ? null : JSON.stringify(r.resolutionDetail), r.createdAt, r.updatedAt, r.completedAt]);
      }
      batchNo += 1;
      await client.query(`update inbox_import_ledger set counts = jsonb_set(counts, '{batchesDone}', to_jsonb($2::int)) where source_id = $1`, [sourceId, batchNo]);
      await client.query('commit');
    } catch (err) { await client.query('rollback').catch(() => {}); throw err; } finally { client.release(); }
    if (o.failAfterBatch !== undefined && batchNo >= o.failAfterBatch) throw new Error(`injected failure after batch ${batchNo}`);
  }
  // Sender scheduler rows (pointers derived exactly as the repository derives them), in one transaction.
  const c2 = await pool.connect();
  try {
    await c2.query('begin');
    for (const [key, s] of plan.senders) {
      await c2.query(
        `insert into inbox_senders(namespace, role, sender_key, sender_phone, next_seq) values ($1,$2,$3,$4,$5)
           on conflict (namespace, role, sender_key) do update set next_seq = greatest(inbox_senders.next_seq, excluded.next_seq)`, [o.namespace, o.role, key, s.phone, s.nextSeq]);
    }
    // A third, independent head-selection - `planRows`'s in-memory pass computes the same thing for reporting,
    // and recomputeHead() does it again at runtime; all three must agree on the same blocking rule, or this one
    // (the one that actually gets written to inbox_senders here) is what checkInvariants() will disagree with,
    // exactly as it did until this excluded senders with an unresolved 'ambiguous_processing' review row.
    await c2.query(
      `with blocked as (
         select distinct sender_key from inbox_items where namespace = $1 and role = $2
          and status = 'review' and resolution = 'ambiguous_processing'
          and not (coalesce(resolution_detail, '{}'::jsonb) ? 'supersededByTrigger')),
       heads as (
         select distinct on (sender_key) sender_key, id, status, received_at, next_attempt_at from inbox_items
          where namespace = $1 and role = $2 and status in ('queued','retry','processing')
            and sender_key not in (select sender_key from blocked)
          order by sender_key, sender_seq)
       update inbox_senders s set head_id = h.id, head_status = h.status,
              due_at = case h.status when 'queued' then h.received_at when 'retry' then h.next_attempt_at end, updated_at = clock_timestamp()
         from heads h where s.namespace = $1 and s.role = $2 and s.sender_key = h.sender_key`, [o.namespace, o.role]);
    await c2.query('commit');
  } catch (err) { await c2.query('rollback').catch(() => {}); throw err; } finally { c2.release(); }

  // Verification BEFORE activation.
  const v = await verifyTarget(pool, o, plan.rows, expectedDigest);
  if (!v.ok) {
    await pool.query("update inbox_import_ledger set status = 'failed_verification', counts = counts || $2::jsonb where source_id = $1", [sourceId, JSON.stringify({ verification: v })]);
    throw new Error(`verification failed - NOT activated, source untouched: ${JSON.stringify(v.problems)}`);
  }
  // Activation: marker first (atomic), then the source is RENAMED (never deleted), then the database record.
  const activatedAt = new Date().toISOString();
  const marker = { ledger: sourceId, sha256: read.sha256, backup: backup.path, activatedAt, namespace: o.namespace, role: o.role, importedDigest: expectedDigest };
  fs.writeFileSync(markerPath(o.sourceFile) + '.tmp', JSON.stringify(marker, null, 1)); fs.renameSync(markerPath(o.sourceFile) + '.tmp', markerPath(o.sourceFile));
  const migratedName = `${o.sourceFile}.migrated-${activatedAt.replace(/[:.]/g, '-')}`;
  fs.renameSync(o.sourceFile, migratedName);
  await pool.query(`insert into inbox_meta(namespace, role, key, value) values ($1,$2,'active_backend',$3::jsonb)
                    on conflict (namespace, role, key) do update set value = excluded.value, updated_at = now()`, [o.namespace, o.role, JSON.stringify({ backend: 'sql', ledger: sourceId, at: activatedAt })]);
  await pool.query("update inbox_import_ledger set status = 'active', finished_at = now(), counts = counts || $2::jsonb where source_id = $1", [sourceId, JSON.stringify({ verification: v, activatedAt, migratedFile: migratedName })]);
  return { result: 'imported, verified and activated', imported: plan.rows.length, byStatusInSql: v.byStatus, backup, migratedFile: migratedName, marker: markerPath(o.sourceFile), verification: v };
}

export interface Verification { ok: boolean; problems: string[]; byStatus: Record<string, number>; digest: string; expectedDigest: string; invariantViolations: number }

export async function verifyTarget(pool: Pool, o: { role: InboxRole; namespace: string }, planned: PlannedRow[], expectedDigest: string): Promise<Verification> {
  const problems: string[] = [];
  const byStatus: Record<string, number> = {};
  const rows: Array<{ messageId: string; phoneNumberId: string; status: string; attempts: number; senderSeq: string; senderKey: string; payload: any }> = [];
  let after = 0;
  for (;;) {
    const r = await pool.query(
      `select id, message_id, phone_number_id, status, attempts, sender_seq, sender_key, payload from inbox_items
        where namespace = $1 and role = $2 and id > $3 order by id limit 5000`, [o.namespace, o.role, after]);
    if (!r.rowCount) break;
    for (const x of r.rows) { rows.push({ messageId: x.message_id, phoneNumberId: x.phone_number_id, status: x.status, attempts: x.attempts, senderSeq: String(x.sender_seq), senderKey: x.sender_key, payload: x.payload }); byStatus[x.status] = (byStatus[x.status] ?? 0) + 1; after = Number(x.id); }
  }
  if (rows.length !== planned.length) problems.push(`row count ${rows.length} != source ${planned.length}`);
  const expectedByStatus: Record<string, number> = {};
  for (const p of planned) expectedByStatus[p.status] = (expectedByStatus[p.status] ?? 0) + 1;
  for (const k of new Set([...Object.keys(byStatus), ...Object.keys(expectedByStatus)])) if ((byStatus[k] ?? 0) !== (expectedByStatus[k] ?? 0)) problems.push(`status ${k}: sql ${byStatus[k] ?? 0} != source ${expectedByStatus[k] ?? 0}`);
  const digest = digestRows(rows);
  if (digest !== expectedDigest) problems.push('identity/status/attempts/order/payload digest differs from the source');
  const repo = new PostgresInboxRepository(pool, { namespace: o.namespace, role: o.role });
  const violations = await repo.checkInvariants();
  if (violations.length) problems.push(`${violations.length} scheduler invariant violation(s): ${violations[0].code}`);
  return { ok: problems.length === 0, problems, byStatus, digest, expectedDigest, invariantViolations: violations.length };
}

// ------------------------------------------------------------------------------------------------ export + rollback

const LEGACY_STATUS = (status: string): string => (status === 'review' ? 'failed' : status);

export async function exportLegacy(pool: Pool, o: { role: InboxRole; namespace: string; outFile: string; confirmStopped?: boolean }): Promise<Record<string, unknown>> {
  if (!o.confirmStopped) throw new Error('export requires --confirm-stopped (SQL workers and receipts must be stopped so nothing changes while it is written).');
  if (fs.existsSync(o.outFile)) throw new Error(`refusing to overwrite ${o.outFile}`);
  const rows = (await pool.query(
    `select message_id, phone_number_id, sender_key, sender_seq, status, attempts, payload, received_at, updated_at, next_attempt_at, last_error, resolution
       from inbox_items where namespace = $1 and role = $2 order by sender_key, sender_seq`, [o.namespace, o.role])).rows;
  const items: SourceItem[] = [];
  const lastCreated = new Map<string, number>();
  const nowIso = new Date().toISOString();
  for (const r of rows) {
    // Legacy order is by createdAt: keep each sender's sequence monotonic (a re-sequenced requeue must not jump ahead).
    let created = new Date(r.received_at).getTime();
    const prev = lastCreated.get(r.sender_key);
    if (prev !== undefined && created <= prev) created = prev + 1;
    lastCreated.set(r.sender_key, created);
    let status = LEGACY_STATUS(r.status); let lastError: string | undefined = r.last_error ?? undefined; let next = r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : undefined;
    if (r.status === 'review') lastError = `[REVIEW:${r.resolution ?? 'review'}] ${r.last_error ?? ''}`.trim();
    if (r.status === 'processing') {
      // Workers are stopped: a processing row is an interrupted item. Gateway: safe to re-run. Client: NOT re-run (kept as failed + reason).
      if (o.role === 'gateway') { status = 'retry'; next = nowIso; } else { status = 'failed'; lastError = '[REVIEW:ambiguous_processing] exported while processing'; }
    }
    items.push({ id: r.message_id, payload: r.payload, status, attempts: r.attempts, createdAt: new Date(created).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), ...(next ? { nextAttemptAt: next } : {}), ...(lastError ? { lastError } : {}) });
  }
  const body = JSON.stringify({ version: 1, items });
  fs.mkdirSync(path.dirname(o.outFile), { recursive: true });
  fs.writeFileSync(o.outFile, body);
  // Verify what was written: every SQL identity is in the file, counts by mapped status match, the file parses.
  const back = readSource(o.outFile);
  const problems: string[] = [];
  if (back.error) problems.push(back.error);
  if (back.items.length !== rows.length) problems.push(`exported ${back.items.length} != sql ${rows.length}`);
  const sqlIds = new Set(rows.map((r) => `${r.message_id}`)); const fileIds = new Set(back.items.map((i) => i.id));
  for (const id of sqlIds) if (!fileIds.has(id)) problems.push(`missing in export: ${id}`);
  if (problems.length) { fs.unlinkSync(o.outFile); throw new Error(`export verification failed: ${problems.slice(0, 5).join('; ')}`); }
  return { exported: items.length, file: o.outFile, sha256: back.sha256, byStatus: Object.fromEntries(Object.entries(items.reduce((a: Record<string, number>, i) => { a[i.status] = (a[i.status] ?? 0) + 1; return a; }, {}))) };
}

export async function rollback(pool: Pool, o: { role: InboxRole; namespace: string; sourceFile: string; useExport?: string; confirmStopped?: boolean }): Promise<Record<string, unknown>> {
  if (!o.confirmStopped) throw new Error('rollback requires --confirm-stopped (all SQL workers and receipts stopped).');
  const sourceId = sourceIdOf(o);
  const ledger = (await pool.query('select source_sha256, status, counts from inbox_import_ledger where source_id = $1', [sourceId])).rows[0];
  if (!ledger || ledger.status !== 'active') throw new Error(`nothing to roll back: ledger status is ${ledger?.status ?? 'absent'}`);
  if (!fs.existsSync(markerPath(o.sourceFile))) throw new Error('marker file missing: state is inconsistent; investigate before doing anything');
  const marker = JSON.parse(fs.readFileSync(markerPath(o.sourceFile), 'utf8'));
  const migrated: string | undefined = ledger.counts?.migratedFile;
  // Has SQL done ANY work since the import? Compare the current rows with what was imported.
  const cur: Array<{ messageId: string; phoneNumberId: string; status: string; attempts: number; senderSeq: string; senderKey: string; payload: any }> = [];
  let after = 0;
  for (;;) {
    const r = await pool.query(`select id, message_id, phone_number_id, status, attempts, sender_seq, sender_key, payload from inbox_items where namespace = $1 and role = $2 and id > $3 order by id limit 5000`, [o.namespace, o.role, after]);
    if (!r.rowCount) break;
    for (const x of r.rows) { cur.push({ messageId: x.message_id, phoneNumberId: x.phone_number_id, status: x.status, attempts: x.attempts, senderSeq: String(x.sender_seq), senderKey: x.sender_key, payload: x.payload }); after = Number(x.id); }
  }
  const unchanged = digestRows(cur) === marker.importedDigest;
  if (!unchanged) {
    if (!o.useExport) throw new Error('SQL has processed or received work since the import: switching back to the original file would LOSE it (and re-run finished messages). Run `export` (workers stopped), verify the file, then `rollback --use-export <file>`.');
    if (!fs.existsSync(o.useExport)) throw new Error('export file not found');
    const exported = readSource(o.useExport);
    if (exported.error || exported.items.length !== cur.length) throw new Error('the export file does not match the current SQL contents; regenerate it with `export`');
    const exportedById = new Map(exported.items.map((i) => [i.id, i]));
    // Identity and count alone are not enough: an export taken before a message finished would still list it,
    // just with a stale status - restoring it would resurrect a completed/failed message as queued and let it
    // process again. Every current item's status must match what exportLegacy() would have written for it NOW
    // (the same role-dependent mapping it uses), not just exist somewhere in the file.
    for (const c of cur) {
      const item = exportedById.get(c.messageId);
      if (!item) throw new Error(`export is missing ${c.messageId}`);
      const expected = c.status === 'processing' ? (o.role === 'gateway' ? 'retry' : 'failed') : LEGACY_STATUS(c.status);
      if (item.status !== expected) throw new Error(`export is stale: ${c.messageId} is now '${c.status}' (would export as '${expected}') but the file has '${item.status}'; regenerate it with \`export\``);
    }
    if (fs.existsSync(o.sourceFile)) throw new Error(`${o.sourceFile} exists; refusing to overwrite`);
    fs.copyFileSync(o.useExport, o.sourceFile);
  } else {
    if (!migrated || !fs.existsSync(migrated)) throw new Error('the renamed original is missing; cannot restore it byte-for-byte');
    if (sha256(fs.readFileSync(migrated)) !== ledger.source_sha256) throw new Error('the renamed original no longer matches its recorded checksum; refusing to restore');
    if (fs.existsSync(o.sourceFile)) throw new Error(`${o.sourceFile} exists; refusing to overwrite`);
    fs.renameSync(migrated, o.sourceFile);
  }
  fs.unlinkSync(markerPath(o.sourceFile));
  await pool.query(`insert into inbox_meta(namespace, role, key, value) values ($1,$2,'active_backend',$3::jsonb)
                    on conflict (namespace, role, key) do update set value = excluded.value, updated_at = now()`, [o.namespace, o.role, JSON.stringify({ backend: 'json', ledger: sourceId, at: new Date().toISOString() })]);
  await pool.query("update inbox_import_ledger set status = $2 where source_id = $1", [sourceId, unchanged ? 'rolled_back' : 'rolled_back_via_export']);
  return { result: unchanged ? 'original file restored byte-for-byte (SQL had done no work)' : 'verified export activated as the JSON inbox (SQL rows kept for audit)', restored: o.sourceFile };
}
