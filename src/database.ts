import { Pool } from 'pg';
import { StorageData } from './storage';

export interface DatabaseHealth {
  enabled: boolean;
  ready: boolean;
  lastError?: string;
  pendingWrites: number;
  lastWriteAt?: string;
}

export interface StorageBackend {
  mode: 'postgres';
  loadSnapshot(): Promise<StorageData | null>;
  persistSnapshot(data: StorageData): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  health(): DatabaseHealth;
}

const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: '001_initial_storage',
    sql: `
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      );

      create table if not exists app_state (
        key text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );

      create table if not exists admin_settings (
        id text primary key default 'current',
        data jsonb not null,
        updated_at timestamptz not null default now()
      );

      create table if not exists client_profile (
        id text primary key default 'current',
        data jsonb not null,
        updated_at timestamptz not null default now()
      );

      create table if not exists campaigns (
        id text primary key,
        trigger_phrase text,
        active boolean not null default false,
        runtime_status text,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists idx_campaigns_trigger_phrase on campaigns(trigger_phrase);
      create index if not exists idx_campaigns_active on campaigns(active);

      create table if not exists campaign_results (
        id text primary key,
        campaign_id text not null,
        result_batch_id text,
        phone text not null,
        status text not null,
        last_stage text,
        triggered_at timestamptz,
        updated_at timestamptz,
        data jsonb not null
      );
      create index if not exists idx_campaign_results_campaign on campaign_results(campaign_id);
      create index if not exists idx_campaign_results_phone on campaign_results(phone);
      create index if not exists idx_campaign_results_status on campaign_results(status);
      create index if not exists idx_campaign_results_batch on campaign_results(result_batch_id);

      create table if not exists campaign_events (
        id text primary key,
        campaign_id text not null,
        campaign_result_id text,
        result_batch_id text,
        phone text,
        type text not null,
        dedupe_key text,
        created_at timestamptz not null,
        data jsonb not null
      );
      create index if not exists idx_campaign_events_campaign on campaign_events(campaign_id);
      create index if not exists idx_campaign_events_phone on campaign_events(phone);
      create index if not exists idx_campaign_events_type on campaign_events(type);
      create unique index if not exists idx_campaign_events_dedupe on campaign_events(campaign_id, campaign_result_id, dedupe_key) where dedupe_key is not null and campaign_result_id is not null;

      create table if not exists contact_queue (
        id text primary key,
        phone text not null,
        status text not null,
        next_attempt_at timestamptz,
        attempts integer not null default 0,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists idx_contact_queue_phone on contact_queue(phone);
      create index if not exists idx_contact_queue_status on contact_queue(status);
      create index if not exists idx_contact_queue_next_attempt on contact_queue(next_attempt_at);

      create table if not exists saved_contacts (
        phone text primary key,
        name text,
        saved_at timestamptz,
        data jsonb not null
      );

      create table if not exists uploaded_files (
        id text primary key,
        filename text not null,
        mime_type text,
        size bigint,
        data jsonb not null,
        created_at timestamptz not null
      );

      create table if not exists twilio_templates (
        id text primary key,
        status text not null,
        data jsonb not null,
        updated_at timestamptz not null
      );
    `,
  },
  {
    id: '002_outbox_conversations_timers',
    sql: `
      create table if not exists outbox_messages (
        id text primary key,
        kind text not null,
        recipient text not null,
        status text not null,
        attempts integer not null default 0,
        provider_message_id text,
        next_attempt_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        data jsonb not null
      );
      create index if not exists idx_outbox_messages_status on outbox_messages(status);
      create index if not exists idx_outbox_messages_recipient on outbox_messages(recipient);
      create index if not exists idx_outbox_messages_next_attempt on outbox_messages(next_attempt_at);

      create table if not exists conversation_state (
        jid text primary key,
        kind text not null,
        sender_phone text,
        campaign_id text,
        campaign_result_id text,
        scheduled_at timestamptz,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists idx_conversation_state_sender_phone on conversation_state(sender_phone);
      create index if not exists idx_conversation_state_campaign on conversation_state(campaign_id);
      create index if not exists idx_conversation_state_scheduled_at on conversation_state(scheduled_at);

      create table if not exists scheduled_jobs (
        id text primary key,
        kind text not null,
        target_id text not null,
        run_at timestamptz not null,
        status text not null,
        attempts integer not null default 0,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists idx_scheduled_jobs_status_run_at on scheduled_jobs(status, run_at);
      create index if not exists idx_scheduled_jobs_target on scheduled_jobs(target_id);
    `,
  },
];

export async function createPostgresBackend(databaseUrl: string): Promise<StorageBackend> {
  const pool = new Pool({ connectionString: databaseUrl });
  const backend = new PostgresStorageBackend(pool);
  await backend.initialize();
  return backend;
}

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await applyMigrations(pool);
  } finally {
    await pool.end();
  }
}

class PostgresStorageBackend implements StorageBackend {
  readonly mode = 'postgres' as const;
  private pending: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private lastError: string | undefined;
  private lastWriteAt: string | undefined;
  private initialized = false;
  private persistedSnapshot: StorageData | null = null;

  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query('select 1');
    await applyMigrations(this.pool);
    this.initialized = true;
  }

  async loadSnapshot(): Promise<StorageData | null> {
    const result = await this.pool.query('select data from app_state where key = $1', ['storage']);
    const snapshot = result.rows[0]?.data ?? null;
    this.persistedSnapshot = snapshot ? cloneSnapshot(snapshot) : null;
    return snapshot;
  }

  persistSnapshot(data: StorageData): void {
    const snapshot = JSON.parse(JSON.stringify(data)) as StorageData;
    this.pendingWrites += 1;
    this.pending = this.pending
      .then(async () => {
        await writeSnapshotDelta(this.pool, this.persistedSnapshot, snapshot);
        this.persistedSnapshot = cloneSnapshot(snapshot);
      })
      .then(() => {
        this.lastError = undefined;
        this.lastWriteAt = new Date().toISOString();
      })
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        console.error('PostgreSQL storage write failed:', err);
      })
      .finally(() => {
        this.pendingWrites = Math.max(0, this.pendingWrites - 1);
      });
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.lastError) throw new Error(this.lastError);
  }

  async close(): Promise<void> {
    await this.flush();
    await this.pool.end();
  }

  health(): DatabaseHealth {
    return {
      enabled: true,
      ready: this.initialized && !this.lastError,
      lastError: this.lastError,
      pendingWrites: this.pendingWrites,
      lastWriteAt: this.lastWriteAt,
    };
  }
}

function cloneSnapshot(data: StorageData): StorageData {
  return JSON.parse(JSON.stringify(data)) as StorageData;
}

async function applyMigrations(pool: Pool): Promise<void> {
  await pool.query('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())');
  for (const migration of MIGRATIONS) {
    const existing = await pool.query('select 1 from schema_migrations where id = $1', [migration.id]);
    if (existing.rowCount) continue;
    await pool.query('begin');
    try {
      await pool.query(migration.sql);
      await pool.query('insert into schema_migrations(id) values ($1) on conflict do nothing', [migration.id]);
      await pool.query('commit');
    } catch (err) {
      await pool.query('rollback');
      throw err;
    }
  }
}

export async function replaceStorageSnapshot(databaseUrl: string, data: StorageData): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await applyMigrations(pool);
    await writeSnapshot(pool, data);
  } finally {
    await pool.end();
  }
}

async function writeSnapshot(pool: Pool, data: StorageData): Promise<void> {
  await pool.query('begin');
  try {
    await pool.query(
      `insert into app_state(key, data, updated_at) values ($1, $2, now())
       on conflict (key) do update set data = excluded.data, updated_at = now()`,
      ['storage', data],
    );

    await pool.query('delete from admin_settings');
    await pool.query('insert into admin_settings(id, data, updated_at) values ($1, $2, now())', ['current', data.adminSettings]);

    await pool.query('delete from client_profile');
    await pool.query('insert into client_profile(id, data, updated_at) values ($1, $2, now())', ['current', data.clientProfile]);

    await replaceRows(pool, 'campaigns', data.campaigns, (item) => [item.id, item.triggerPhrase, item.active, item.runtimeStatus ?? null, item]);
    await replaceRows(pool, 'campaign_results', data.campaignResults, (item) => [item.id, item.campaignId, item.resultBatchId ?? null, item.phone, item.status, item.lastStage ?? null, nullableDate(item.triggeredAt), nullableDate(item.updatedAt), item]);
    await replaceRows(pool, 'campaign_events', data.campaignEvents, (item) => [item.id, item.campaignId, item.campaignResultId ?? null, item.resultBatchId ?? null, item.phone ?? null, item.type, item.dedupeKey ?? null, nullableDate(item.createdAt), item]);
    await replaceRows(pool, 'contact_queue', data.contactQueue, (item) => [item.id, item.phone, item.status, nullableDate(item.nextAttemptAt), item.attempts, item, nullableDate(item.updatedAt)]);
    await replaceRows(pool, 'saved_contacts', data.contactsList, (item) => [item.phone, item.name, nullableDate(item.savedAt), item]);
    await replaceRows(pool, 'uploaded_files', data.uploadedFiles, (item) => [item.id, item.filename, item.mimeType, item.size, item, nullableDate(item.createdAt)]);
    await replaceRows(pool, 'twilio_templates', data.twilioTemplates, (item) => [item.id, item.status, item, nullableDate(item.updatedAt)]);
    await replaceRows(pool, 'outbox_messages', data.outboxMessages ?? [], (item) => [item.id, item.kind, item.to, item.status, item.attempts, item.providerMessageId ?? null, nullableDate(item.nextAttemptAt), nullableDate(item.createdAt), nullableDate(item.updatedAt), item]);
    await replaceConversationStateRows(pool, data.conversationStateSnapshot?.conversations ?? {});
    await replaceRows(pool, 'scheduled_jobs', data.scheduledJobs ?? [], (item) => [item.id, item.kind, item.targetId, nullableDate(item.runAt), item.status, item.attempts, item, nullableDate(item.updatedAt)]);

    await pool.query('commit');
  } catch (err) {
    await pool.query('rollback');
    throw err;
  }
}

/**
 * Runtime persistence keeps app_state as the backwards-compatible source of
 * truth, but updates derived tables incrementally. The migration importer uses
 * writeSnapshot() because replacing an explicitly supplied snapshot is its
 * intended behaviour.
 */
async function writeSnapshotDelta(pool: Pool, previous: StorageData | null, data: StorageData): Promise<void> {
  await pool.query('begin');
  try {
    await pool.query(
      `insert into app_state(key, data, updated_at) values ($1, $2, now())
       on conflict (key) do update set data = excluded.data, updated_at = now()`,
      ['storage', data],
    );

    if (!previous || !sameJson(previous.adminSettings, data.adminSettings)) {
      await pool.query(
        `insert into admin_settings(id, data, updated_at) values ('current', $1, now())
         on conflict (id) do update set data = excluded.data, updated_at = now()`,
        [data.adminSettings],
      );
    }
    if (!previous || !sameJson(previous.clientProfile, data.clientProfile)) {
      await pool.query(
        `insert into client_profile(id, data, updated_at) values ('current', $1, now())
         on conflict (id) do update set data = excluded.data, updated_at = now()`,
        [data.clientProfile],
      );
    }

    await syncRowsDelta(pool, 'campaigns', previous?.campaigns ?? [], data.campaigns, (item) => item.id, (item) => [item.id, item.triggerPhrase, item.active, item.runtimeStatus ?? null, item]);
    await syncRowsDelta(pool, 'campaign_results', previous?.campaignResults ?? [], data.campaignResults, (item) => item.id, (item) => [item.id, item.campaignId, item.resultBatchId ?? null, item.phone, item.status, item.lastStage ?? null, nullableDate(item.triggeredAt), nullableDate(item.updatedAt), item]);
    await syncRowsDelta(pool, 'campaign_events', previous?.campaignEvents ?? [], data.campaignEvents, (item) => item.id, (item) => [item.id, item.campaignId, item.campaignResultId ?? null, item.resultBatchId ?? null, item.phone ?? null, item.type, item.dedupeKey ?? null, nullableDate(item.createdAt), item]);
    await syncRowsDelta(pool, 'contact_queue', previous?.contactQueue ?? [], data.contactQueue, (item) => item.id, (item) => [item.id, item.phone, item.status, nullableDate(item.nextAttemptAt), item.attempts, item, nullableDate(item.updatedAt)]);
    await syncRowsDelta(pool, 'saved_contacts', previous?.contactsList ?? [], data.contactsList, (item) => item.phone, (item) => [item.phone, item.name, nullableDate(item.savedAt), item]);
    await syncRowsDelta(pool, 'uploaded_files', previous?.uploadedFiles ?? [], data.uploadedFiles, (item) => item.id, (item) => [item.id, item.filename, item.mimeType, item.size, item, nullableDate(item.createdAt)]);
    await syncRowsDelta(pool, 'twilio_templates', previous?.twilioTemplates ?? [], data.twilioTemplates, (item) => item.id, (item) => [item.id, item.status, item, nullableDate(item.updatedAt)]);
    await syncRowsDelta(pool, 'outbox_messages', previous?.outboxMessages ?? [], data.outboxMessages ?? [], (item) => item.id, (item) => [item.id, item.kind, item.to, item.status, item.attempts, item.providerMessageId ?? null, nullableDate(item.nextAttemptAt), nullableDate(item.createdAt), nullableDate(item.updatedAt), item]);
    await syncConversationStateDelta(pool, previous?.conversationStateSnapshot?.conversations ?? {}, data.conversationStateSnapshot?.conversations ?? {});
    await syncRowsDelta(pool, 'scheduled_jobs', previous?.scheduledJobs ?? [], data.scheduledJobs ?? [], (item) => item.id, (item) => [item.id, item.kind, item.targetId, nullableDate(item.runAt), item.status, item.attempts, item, nullableDate(item.updatedAt)]);

    await pool.query('commit');
  } catch (err) {
    await pool.query('rollback');
    throw err;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function syncRowsDelta<T extends Record<string, any>>(
  pool: Pool,
  table: string,
  previousRows: T[],
  nextRows: T[],
  keyOf: (row: T) => string,
  values: (row: T) => unknown[],
): Promise<void> {
  const previous = new Map(previousRows.map((row) => [keyOf(row), row]));
  const next = new Map(nextRows.map((row) => [keyOf(row), row]));
  const removed = [...previous.keys()].filter((key) => !next.has(key));
  if (removed.length) {
    const keyColumn = table === 'saved_contacts' ? 'phone' : 'id';
    await pool.query(`delete from ${table} where ${keyColumn} = any($1::text[])`, [removed]);
  }
  for (const [key, row] of next) {
    if (previous.has(key) && sameJson(previous.get(key), row)) continue;
    await upsertRow(pool, table, values(row));
  }
}

async function upsertRow(pool: Pool, table: string, params: unknown[]): Promise<void> {
  const columns = tableColumns(table).split(',').map((column) => column.trim());
  const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
  const keyColumn = table === 'saved_contacts' ? 'phone' : 'id';
  const updates = columns
    .filter((column) => column !== keyColumn)
    .map((column) => `${column} = excluded.${column}`);
  if (table === 'campaigns') updates.push('updated_at = now()');
  await pool.query(
    `insert into ${table}(${columns.join(', ')}) values (${placeholders})
     on conflict (${keyColumn}) do update set ${updates.join(', ')}`,
    params,
  );
}

async function syncConversationStateDelta(
  pool: Pool,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Promise<void> {
  const removed = Object.keys(previous).filter((jid) => !(jid in next));
  if (removed.length) await pool.query('delete from conversation_state where jid = any($1::text[])', [removed]);
  for (const [jid, state] of Object.entries(next)) {
    if (jid in previous && sameJson(previous[jid], state)) continue;
    const item = state as any;
    await pool.query(
      `insert into conversation_state(jid, kind, sender_phone, campaign_id, campaign_result_id, scheduled_at, data, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (jid) do update set
         kind = excluded.kind,
         sender_phone = excluded.sender_phone,
         campaign_id = excluded.campaign_id,
         campaign_result_id = excluded.campaign_result_id,
         scheduled_at = excluded.scheduled_at,
         data = excluded.data,
         updated_at = now()`,
      [
        jid,
        typeof item.kind === 'string' ? item.kind : 'unknown',
        typeof item.senderPhone === 'string' ? item.senderPhone : null,
        typeof item.campaignId === 'string' ? item.campaignId : null,
        typeof item.campaignResultId === 'string' ? item.campaignResultId : null,
        scheduledAtForState(item),
        item,
      ],
    );
  }
}

async function replaceRows<T>(pool: Pool, table: string, rows: T[], values: (row: T) => unknown[]): Promise<void> {
  await pool.query(`delete from ${table}`);
  for (const row of rows) {
    const params = values(row);
    const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
    const columns = tableColumns(table);
    await pool.query(`insert into ${table}(${columns}) values (${placeholders})`, params);
  }
}

function tableColumns(table: string): string {
  switch (table) {
    case 'campaigns': return 'id, trigger_phrase, active, runtime_status, data';
    case 'campaign_results': return 'id, campaign_id, result_batch_id, phone, status, last_stage, triggered_at, updated_at, data';
    case 'campaign_events': return 'id, campaign_id, campaign_result_id, result_batch_id, phone, type, dedupe_key, created_at, data';
    case 'contact_queue': return 'id, phone, status, next_attempt_at, attempts, data, updated_at';
    case 'saved_contacts': return 'phone, name, saved_at, data';
    case 'uploaded_files': return 'id, filename, mime_type, size, data, created_at';
    case 'twilio_templates': return 'id, status, data, updated_at';
    case 'outbox_messages': return 'id, kind, recipient, status, attempts, provider_message_id, next_attempt_at, created_at, updated_at, data';
    case 'scheduled_jobs': return 'id, kind, target_id, run_at, status, attempts, data, updated_at';
    default: throw new Error(`Unknown table ${table}`);
  }
}

async function replaceConversationStateRows(pool: Pool, conversations: Record<string, unknown>): Promise<void> {
  await pool.query('delete from conversation_state');
  for (const [jid, state] of Object.entries(conversations)) {
    const item = state as any;
    await pool.query(
      `insert into conversation_state(jid, kind, sender_phone, campaign_id, campaign_result_id, scheduled_at, data, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        jid,
        typeof item.kind === 'string' ? item.kind : 'unknown',
        typeof item.senderPhone === 'string' ? item.senderPhone : null,
        typeof item.campaignId === 'string' ? item.campaignId : null,
        typeof item.campaignResultId === 'string' ? item.campaignResultId : null,
        scheduledAtForState(item),
        item,
      ],
    );
  }
}

function scheduledAtForState(state: { timestamp?: unknown; nameTimeoutMinutes?: unknown; preNamePromptTimeoutMinutes?: unknown; contactCardConfirmationTimeoutMinutes?: unknown; decisionTimeoutMinutes?: unknown; kind?: unknown; flow?: unknown; stepId?: unknown }): string | null {
  const timestamp = typeof state.timestamp === 'number' ? state.timestamp : 0;
  if (!timestamp) return null;
  let minutes = 30;
  if (state.kind === 'name') minutes = typeof state.nameTimeoutMinutes === 'number' ? state.nameTimeoutMinutes : 5;
  else if (state.kind === 'pre-name-prompt') minutes = typeof state.preNamePromptTimeoutMinutes === 'number' ? state.preNamePromptTimeoutMinutes : 1;
  else if (state.kind === 'contact-card-confirmation') minutes = typeof state.contactCardConfirmationTimeoutMinutes === 'number' ? state.contactCardConfirmationTimeoutMinutes : 30;
  else if (state.kind === 'handoff') minutes = 24 * 60;
  else if (state.kind === 'decision' || state.kind === 'wait-reply') minutes = typeof state.decisionTimeoutMinutes === 'number' ? state.decisionTimeoutMinutes : 30;
  return new Date(timestamp + Math.max(1, minutes) * 60 * 1000).toISOString();
}

function nullableDate(value: string | undefined): string | null {
  return value || null;
}

