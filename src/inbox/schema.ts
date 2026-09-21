import { Pool } from 'pg';

/**
 * Inbox tables live on their OWN migration line (`inbox_schema_migrations`). They are not part of StorageData, so
 * writeSnapshotDelta / import / export never see them and cannot delete them.
 * Design: docs/stage-e-design-2026-09-21.md section 2.
 */
export const INBOX_MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: '001_inbox_core',
    sql: `
      -- The SCHEDULER row: one per sender. head_id points at the first outstanding item; due_at says when it next needs a worker.
      create table inbox_senders (
        namespace     text   not null,
        role          text   not null check (role in ('gateway','client')),
        sender_key    text   not null,
        sender_phone  text   not null,
        next_seq      bigint not null default 1,
        head_id       bigint,
        head_status   text check (head_status in ('queued','retry','processing')),
        due_at        timestamptz,
        updated_at    timestamptz not null default clock_timestamp(),
        primary key (namespace, role, sender_key),
        check ((head_id is null) = (head_status is null)),
        check ((head_id is null) = (due_at is null))
      ) with (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
      create index idx_inbox_senders_due   on inbox_senders (namespace, role, due_at) where head_id is not null;
      create index idx_inbox_senders_phone on inbox_senders (namespace, role, sender_phone);

      create table inbox_items (
        id                bigint generated always as identity primary key,
        namespace         text   not null,
        role              text   not null check (role in ('gateway','client')),
        phone_number_id   text   not null,
        message_id        text   not null,
        sender_key        text   not null,
        sender_phone      text   not null,
        sender_seq        bigint not null,
        status            text   not null check (status in ('queued','processing','retry','completed','failed','held','review')),
        attempts          int    not null default 0,
        payload           jsonb,
        provider_ts       timestamptz,
        received_at       timestamptz not null default clock_timestamp(),
        first_claimed_at  timestamptz,
        next_attempt_at   timestamptz,
        lease_token       uuid,
        lease_expires_at  timestamptz,
        claimed_by        text,
        effects_state     text   not null default 'none' check (effects_state in ('none','possible')),
        last_error        text,
        resolution        text,
        resolution_detail jsonb,
        created_at        timestamptz not null default clock_timestamp(),
        updated_at        timestamptz not null default clock_timestamp(),
        completed_at      timestamptz,
        unique (namespace, role, phone_number_id, message_id),
        unique (namespace, role, sender_key, sender_seq)
      ) with (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);

      create index idx_inbox_items_outstanding on inbox_items (namespace, role, sender_key, sender_seq)
        where status in ('queued','retry','processing');
      create index idx_inbox_items_review on inbox_items (namespace, role, status, updated_at, id)
        where status in ('failed','held','review');
      create index idx_inbox_items_held_phone on inbox_items (namespace, role, sender_phone, sender_seq)
        where status in ('held','failed','review');
      create index idx_inbox_items_actionable_age on inbox_items (namespace, role, received_at)
        where status in ('queued','retry');
      create index idx_inbox_items_completed_cleanup on inbox_items (namespace, role, updated_at, id)
        where status = 'completed';
      create index idx_inbox_items_payload_purge on inbox_items (namespace, role, updated_at, id)
        where status = 'completed' and payload is not null;

      create table inbox_meta (
        namespace text not null, role text not null, key text not null, value jsonb not null,
        updated_at timestamptz not null default now(), primary key (namespace, role, key)
      );
      create table inbox_import_ledger (
        source_id text primary key, source_sha256 text not null, status text not null,
        counts jsonb not null, started_at timestamptz not null default now(), finished_at timestamptz
      );
      create table inbox_admin_audit (
        id bigint generated always as identity primary key, at timestamptz not null default clock_timestamp(),
        actor text not null, action text not null, item_id bigint, from_status text, to_status text, detail jsonb
      );
      create index idx_inbox_admin_audit_item on inbox_admin_audit (item_id);
    `,
  },
];

/** Idempotent; safe to run concurrently (advisory lock). Never touches any non-inbox table. */
export async function migrateInboxSchema(pool: Pool): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtext('inbox_schema_migrations'))");
    await client.query('create table if not exists inbox_schema_migrations (id text primary key, applied_at timestamptz not null default now())');
    for (const migration of INBOX_MIGRATIONS) {
      const done = await client.query('select 1 from inbox_schema_migrations where id = $1', [migration.id]);
      if (done.rowCount) continue;
      await client.query(migration.sql);
      await client.query('insert into inbox_schema_migrations(id) values ($1)', [migration.id]);
      applied.push(migration.id);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return applied;
}

/**
 * Pool for the inbox: bounded size and bounded waits. A SQL failure is never a reason to fall back to JSON; it surfaces
 * (receipts fail with 503, workers stop claiming).
 */
export function createInboxPool(connectionString: string, opts: { max?: number } = {}): Pool {
  const pool = new Pool({
    connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: 5_000,
    // No planner overrides: the partial indexes are chosen on their merits. (An earlier draft forced enable_seqscan=off; removed - it would
    // hide a broken or missing index behind silently worse behaviour. The C2 gate runs WITHOUT it.)
    options: '-c lock_timeout=5000 -c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000',
  });
  // An idle connection killed by the server (restart, failover, pg_terminate_backend) emits 'error' on the pool; unhandled, that crashes the
  // whole process. It is logged and the pool drops the client: the next query opens a fresh connection.
  pool.on('error', (err) => console.error('[INBOX_POOL_ERROR]', err instanceof Error ? err.message : err));
  return pool;
}
