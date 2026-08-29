import { Pool, PoolClient } from 'pg';
import { emptyStorageData, StorageData, StorageTableName } from './storage';

export interface DatabaseHealth {
  enabled: boolean;
  ready: boolean;
  lastError?: string;
  pendingWrites: number;
  lastWriteAt?: string;
}

/**
 * The set of tables a persistSnapshot() call actually changed. `'all'` means
 * "unknown or everything" and forces the full historical diff for every table -
 * the same behavior as before this optimization existed. It is the only value
 * that must be assumed whenever a caller's intent is not precisely known.
 */
export type DirtyTables = ReadonlySet<StorageTableName> | 'all';

/**
 * Rows in a mutated-in-place table (outbox_messages, campaign_results,
 * contact_queue, saved_contacts) can't use an append-only fast path the way
 * campaign_events does. Instead each persist() call names the exact row id(s)
 * it changed. 'all' means "unknown, or more than the caller tracked" and
 * forces the full per-row comparison - the same behavior as before this
 * optimization existed.
 */
export type DirtyRowIds = ReadonlySet<string> | 'all';
/** @deprecated kept as an alias so existing imports keep working; use DirtyRowIds. */
export type DirtyOutboxRows = DirtyRowIds;

/** Per-table row-id tracking, for the tables that support it. A table absent
 * from this map is either not dirty, or not row-trackable - its own full sync
 * (or append-only fast path) runs unaffected. */
export type DirtyRowIdsByTable = Partial<Record<StorageTableName, DirtyRowIds>>;

export interface StorageBackend {
  mode: 'postgres';
  loadSnapshot(): Promise<StorageData | null>;
  persistSnapshot(data: StorageData, dirtyTables: DirtyTables, dirtyRowIds: DirtyRowIdsByTable): void;
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
  {
    id: '003_outbox_claims',
    sql: `
      alter table outbox_messages add column if not exists idempotency_key text;
      alter table outbox_messages add column if not exists processing_started_at timestamptz;
      create unique index if not exists idx_outbox_messages_idempotency
        on outbox_messages(idempotency_key)
        where idempotency_key is not null;
      create index if not exists idx_outbox_messages_processing_started
        on outbox_messages(processing_started_at);
    `,
  },
  {
    id: '004_service_bot_state',
    sql: `
      create table if not exists service_bot_state (
        id text primary key default 'current',
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
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
  private queuedSnapshot: StorageData | null = null;
  private queuedDirtyTables: DirtyTables = new Set();
  private queuedDirtyRowIds: DirtyRowIdsByTable = {};
  private draining = false;

  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query('select 1');
    await applyMigrations(this.pool);
    this.initialized = true;
  }

  async loadSnapshot(): Promise<StorageData | null> {
    const snapshot = await loadRuntimeSnapshot(this.pool);
    this.persistedSnapshot = snapshot ? cloneSnapshot(snapshot) : null;
    return snapshot;
  }

  persistSnapshot(data: StorageData, dirtyTables: DirtyTables, dirtyRowIds: DirtyRowIdsByTable): void {
    this.queuedSnapshot = data;
    // Union dirty tables across coalesced writes. If either this call or an
    // earlier still-queued one is 'all', the whole coalesced batch must be
    // treated as 'all' - we can never know less than the least-informed caller.
    this.queuedDirtyTables = mergeDirtyTables(this.queuedDirtyTables, dirtyTables);
    this.queuedDirtyRowIds = mergeDirtyRowIdsByTable(this.queuedDirtyRowIds, dirtyRowIds);
    this.pendingWrites = 1;
    if (this.draining) return;

    this.draining = true;
    this.pending = this.drainPendingSnapshots();
  }

  private async drainPendingSnapshots(): Promise<void> {
    try {
      while (this.queuedSnapshot) {
        const source = this.queuedSnapshot;
        const dirtyTables = this.queuedDirtyTables;
        const dirtyRowIds = this.queuedDirtyRowIds;
        this.queuedSnapshot = null;
        // Reset to empty, not 'all': this starts the *next* accumulation
        // round clean. Resetting to 'all' would poison every future write forever,
        // since merge('all', anything) is always 'all'.
        this.queuedDirtyTables = new Set();
        this.queuedDirtyRowIds = {};
        const snapshot = cloneSnapshot(source);
        await writeSnapshotDelta(this.pool, this.persistedSnapshot, snapshot, dirtyTables, dirtyRowIds);
        this.persistedSnapshot = snapshot;
        this.lastError = undefined;
        this.lastWriteAt = new Date().toISOString();
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('PostgreSQL storage write failed:', err);
    } finally {
      this.draining = false;
      this.pendingWrites = this.queuedSnapshot ? 1 : 0;
      if (this.queuedSnapshot) {
        this.draining = true;
        this.pending = this.drainPendingSnapshots();
      }
    }
  }

  async flush(): Promise<void> {
    do {
      const pending = this.pending;
      await pending;
    } while (this.draining || this.queuedSnapshot);
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
  return sanitizeJsonForPostgres(JSON.parse(JSON.stringify(data))) as StorageData;
}

// Exported for test scripts that verify the dirty-table skip logic against a
// mocked pg.Pool (see scripts/test-postgres-dirty-tables.js) - not part of the
// public runtime API.
export function mergeDirtyTables(a: DirtyTables, b: DirtyTables): DirtyTables {
  if (a === 'all' || b === 'all') return 'all';
  return new Set([...a, ...b]);
}

export function mergeDirtyOutboxRows(a: DirtyRowIds, b: DirtyRowIds): DirtyRowIds {
  if (a === 'all' || b === 'all') return 'all';
  return new Set([...a, ...b]);
}
/** Alias with the general name; mergeDirtyOutboxRows is kept for existing callers/tests. */
export const mergeDirtyRowIds = mergeDirtyOutboxRows;

export function mergeDirtyRowIdsByTable(a: DirtyRowIdsByTable, b: DirtyRowIdsByTable): DirtyRowIdsByTable {
  const merged: DirtyRowIdsByTable = { ...a };
  for (const table of Object.keys(b) as StorageTableName[]) {
    const bValue = b[table];
    if (bValue === undefined) continue;
    merged[table] = mergeDirtyRowIds(merged[table] ?? new Set<string>(), bValue);
  }
  return merged;
}

function sanitizeJsonForPostgres(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeStringForPostgresJson(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonForPostgres);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, sanitizeJsonForPostgres(item)]),
  );
}

function sanitizeStringForPostgresJson(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    result += value[index];
  }
  return result;
}

function jsonbParam(value: unknown): string {
  return JSON.stringify(sanitizeJsonForPostgres(value));
}

function bindJsonbParams(table: string, params: unknown[]): unknown[] {
  const columns = tableColumns(table).split(',').map((column) => column.trim());
  return params.map((param, index) => columns[index] === 'data' ? jsonbParam(param) : param);
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

function mergeRowsInSnapshotOrder<T>(base: T[], current: T[], key: (item: T) => string): T[] {
  const currentByKey = new Map(current.map((item) => [key(item), item]));
  const merged = base.flatMap((item) => {
    const updated = currentByKey.get(key(item));
    if (!updated) return [];
    currentByKey.delete(key(item));
    return [updated];
  });
  return [...merged, ...currentByKey.values()];
}

async function readRuntimeSnapshot(connection: Pool | PoolClient): Promise<StorageData | null> {
  const appState = await connection.query('select data from app_state where key = $1', ['storage']);
  const adminSettings = await connection.query("select data from admin_settings where id = 'current'");
  const clientProfile = await connection.query("select data from client_profile where id = 'current'");
  const campaigns = await connection.query('select data from campaigns order by updated_at, id');
  const campaignResults = await connection.query('select data from campaign_results order by triggered_at nulls last, updated_at nulls last, id');
  const campaignEvents = await connection.query('select data from campaign_events order by created_at, id');
  const contactQueue = await connection.query('select data from contact_queue order by updated_at, id');
  const savedContacts = await connection.query('select data from saved_contacts order by saved_at nulls last, phone');
  const uploadedFiles = await connection.query('select data from uploaded_files order by created_at, id');
  const twilioTemplates = await connection.query('select data from twilio_templates order by updated_at, id');
  const outboxMessages = await connection.query('select data from outbox_messages order by created_at, id');
  const conversationState = await connection.query('select jid, data from conversation_state');
  const scheduledJobs = await connection.query('select data from scheduled_jobs order by run_at, id');
  const serviceBotState = await connection.query("select data from service_bot_state where id = 'current'");
  const hasNormalizedData = [
    adminSettings, clientProfile, campaigns, campaignResults, campaignEvents, contactQueue,
    savedContacts, uploadedFiles, twilioTemplates, outboxMessages, conversationState, scheduledJobs,
    serviceBotState,
  ].some((result) => (result.rowCount ?? 0) > 0);
  if (!appState.rowCount && !hasNormalizedData) return null;

  const base = appState.rows[0]?.data
    ? cloneSnapshot(appState.rows[0].data as StorageData)
    : emptyStorageData();
  const rowData = <T>(result: { rows: Array<{ data: T }> }): T[] => result.rows.map((row) => row.data);
  const conversations = Object.fromEntries(conversationState.rows.map((row) => [row.jid, row.data]));
  const persistedServiceBotState = serviceBotState.rows[0]?.data as Pick<StorageData,
    'serviceBots' | 'serviceBot' | 'serviceBotSessions' | 'serviceBotRecords' | 'serviceBotFollowUps'
  > | undefined;

  return {
    ...base,
    adminSettings: adminSettings.rows[0]?.data ?? base.adminSettings,
    clientProfile: clientProfile.rows[0]?.data ?? base.clientProfile,
    campaigns: mergeRowsInSnapshotOrder(base.campaigns, rowData(campaigns), (item) => item.id),
    campaignResults: mergeRowsInSnapshotOrder(base.campaignResults, rowData(campaignResults), (item) => item.id),
    campaignEvents: mergeRowsInSnapshotOrder(base.campaignEvents, rowData(campaignEvents), (item) => item.id),
    contactQueue: mergeRowsInSnapshotOrder(base.contactQueue, rowData(contactQueue), (item) => item.id),
    contactsList: mergeRowsInSnapshotOrder(base.contactsList, rowData(savedContacts), (item) => item.phone),
    uploadedFiles: mergeRowsInSnapshotOrder(base.uploadedFiles, rowData(uploadedFiles), (item) => item.id),
    twilioTemplates: mergeRowsInSnapshotOrder(base.twilioTemplates, rowData(twilioTemplates), (item) => item.id),
    outboxMessages: mergeRowsInSnapshotOrder(base.outboxMessages ?? [], rowData(outboxMessages), (item) => item.id),
    conversationStateSnapshot: Object.keys(conversations).length
      ? { version: 1, savedAt: base.conversationStateSnapshot?.savedAt ?? new Date().toISOString(), conversations }
      : undefined,
    scheduledJobs: mergeRowsInSnapshotOrder(base.scheduledJobs ?? [], rowData(scheduledJobs), (item) => item.id),
    serviceBots: persistedServiceBotState?.serviceBots ?? base.serviceBots,
    serviceBot: persistedServiceBotState?.serviceBot ?? base.serviceBot,
    serviceBotSessions: persistedServiceBotState?.serviceBotSessions ?? base.serviceBotSessions,
    serviceBotRecords: persistedServiceBotState?.serviceBotRecords ?? base.serviceBotRecords,
    serviceBotFollowUps: persistedServiceBotState?.serviceBotFollowUps ?? base.serviceBotFollowUps,
  };
}

async function loadRuntimeSnapshot(pool: Pool): Promise<StorageData | null> {
  const client = await pool.connect();
  try {
    await client.query('begin transaction isolation level repeatable read');
    const snapshot = await readRuntimeSnapshot(client);
    await client.query('commit');
    return snapshot;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function replaceStorageSnapshot(
  databaseUrl: string,
  data: StorageData,
  options: { force?: boolean } = {},
): Promise<'imported' | 'unchanged'> {
  const sanitizedData = sanitizeJsonForPostgres(data) as StorageData;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await applyMigrations(pool);
    const current = await loadRuntimeSnapshot(pool);
    if (current) {
      if (sameJson(current, sanitizedData)) return 'unchanged';
      if (!options.force) {
        throw new Error('PostgreSQL already contains a different storage snapshot. Refusing to overwrite it without --force.');
      }
    }
    await writeSnapshot(pool, sanitizedData);
    return 'imported';
  } finally {
    await pool.end();
  }
}

export async function loadStorageSnapshot(databaseUrl: string): Promise<StorageData | null> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await applyMigrations(pool);
    return await loadRuntimeSnapshot(pool);
  } finally {
    await pool.end();
  }
}

async function writeSnapshot(pool: Pool, data: StorageData): Promise<void> {
  data = sanitizeJsonForPostgres(data) as StorageData;
  await pool.query('begin');
  try {
    await pool.query(
      `insert into app_state(key, data, updated_at) values ($1, $2, now())
       on conflict (key) do update set data = excluded.data, updated_at = now()`,
      ['storage', jsonbParam(data)],
    );

    await pool.query('delete from admin_settings');
    await pool.query('insert into admin_settings(id, data, updated_at) values ($1, $2, now())', ['current', jsonbParam(data.adminSettings)]);

    await pool.query('delete from client_profile');
    await pool.query('insert into client_profile(id, data, updated_at) values ($1, $2, now())', ['current', jsonbParam(data.clientProfile)]);

    await replaceRows(pool, 'campaigns', data.campaigns, (item) => [item.id, item.triggerPhrase, item.active, item.runtimeStatus ?? null, item]);
    await replaceRows(pool, 'campaign_results', data.campaignResults, (item) => [item.id, item.campaignId, item.resultBatchId ?? null, item.phone, item.status, item.lastStage ?? null, nullableDate(item.triggeredAt), nullableDate(item.updatedAt), item]);
    await replaceRows(pool, 'campaign_events', data.campaignEvents, (item) => [item.id, item.campaignId, item.campaignResultId ?? null, item.resultBatchId ?? null, item.phone ?? null, item.type, item.dedupeKey ?? null, nullableDate(item.createdAt), item]);
    await replaceRows(pool, 'contact_queue', data.contactQueue, (item) => [item.id, item.phone, item.status, nullableDate(item.nextAttemptAt), item.attempts, item, nullableDate(item.updatedAt)]);
    await replaceRows(pool, 'saved_contacts', data.contactsList, (item) => [item.phone, item.name, nullableDate(item.savedAt), item]);
    await replaceRows(pool, 'uploaded_files', data.uploadedFiles, (item) => [item.id, item.filename, item.mimeType, item.size, item, nullableDate(item.createdAt)]);
    await replaceRows(pool, 'twilio_templates', data.twilioTemplates, (item) => [item.id, item.status, item, nullableDate(item.updatedAt)]);
    await replaceRows(pool, 'outbox_messages', data.outboxMessages ?? [], (item) => [item.id, item.kind, item.to, item.status, item.attempts, item.providerMessageId ?? null, item.idempotencyKey ?? null, nullableDate(item.processingStartedAt), nullableDate(item.nextAttemptAt), nullableDate(item.createdAt), nullableDate(item.updatedAt), item]);
    await replaceConversationStateRows(pool, data.conversationStateSnapshot?.conversations ?? {});
    await replaceRows(pool, 'scheduled_jobs', data.scheduledJobs ?? [], (item) => [item.id, item.kind, item.targetId, nullableDate(item.runAt), item.status, item.attempts, item, nullableDate(item.updatedAt)]);
    await pool.query(
      `insert into service_bot_state(id, data, updated_at) values ('current', $1, now())
       on conflict (id) do update set data = excluded.data, updated_at = now()`,
      [jsonbParam(serviceBotStateFromSnapshot(data))],
    );

    await pool.query('commit');
  } catch (err) {
    await pool.query('rollback');
    throw err;
  }
}

/**
 * Runtime persistence updates normalized tables only. app_state remains an
 * import/rollback checkpoint; startup and exports overlay these tables onto it.
 */
export async function writeSnapshotDelta(pool: Pool, previous: StorageData | null, data: StorageData, dirtyTables: DirtyTables, dirtyRowIds: DirtyRowIdsByTable): Promise<void> {
  // A table absent from dirtyTables was provably untouched by whatever mutated
  // `data` since `previous` was captured (persist() call sites name every table
  // they change; see StorageTableName in storage.ts). Skipping its diff entirely
  // is safe: previous[table] and data[table] cannot differ. 'all' (unknown caller
  // intent, or the first write after startup when `previous` is null) always
  // checks everything, matching the pre-optimization behavior exactly.
  const isDirty = (table: StorageTableName): boolean => !previous || dirtyTables === 'all' || dirtyTables.has(table);
  // previous === null (first write ever, e.g. after a fresh deploy) has no
  // baseline to compare specific rows against - always do the full sync then.
  const rowIdsFor = (table: StorageTableName): DirtyRowIds => (previous ? (dirtyRowIds[table] ?? 'all') : 'all');

  await pool.query('begin');
  try {

    if (isDirty('adminSettings') && (!previous || !sameJson(previous.adminSettings, data.adminSettings))) {
      await pool.query(
        `insert into admin_settings(id, data, updated_at) values ('current', $1, now())
         on conflict (id) do update set data = excluded.data, updated_at = now()`,
        [jsonbParam(data.adminSettings)],
      );
    }
    if (isDirty('clientProfile') && (!previous || !sameJson(previous.clientProfile, data.clientProfile))) {
      await pool.query(
        `insert into client_profile(id, data, updated_at) values ('current', $1, now())
         on conflict (id) do update set data = excluded.data, updated_at = now()`,
        [jsonbParam(data.clientProfile)],
      );
    }

    if (isDirty('campaigns')) {
      await syncRowsDelta(pool, 'campaigns', previous?.campaigns ?? [], data.campaigns, (item) => item.id, (item) => [item.id, item.triggerPhrase, item.active, item.runtimeStatus ?? null, item]);
    }
    if (isDirty('campaignResults')) {
      await syncCampaignResultsDelta(pool, previous?.campaignResults ?? [], data.campaignResults, rowIdsFor('campaignResults'));
    }
    if (isDirty('campaignEvents')) {
      await syncCampaignEventsDelta(pool, previous?.campaignEvents ?? [], data.campaignEvents);
    }
    if (isDirty('contactQueue')) {
      await syncContactQueueDelta(pool, previous?.contactQueue ?? [], data.contactQueue, rowIdsFor('contactQueue'));
    }
    if (isDirty('contactsList')) {
      await syncContactsListDelta(pool, previous?.contactsList ?? [], data.contactsList, rowIdsFor('contactsList'));
    }
    if (isDirty('uploadedFiles')) {
      await syncRowsDelta(pool, 'uploaded_files', previous?.uploadedFiles ?? [], data.uploadedFiles, (item) => item.id, (item) => [item.id, item.filename, item.mimeType, item.size, item, nullableDate(item.createdAt)]);
    }
    if (isDirty('twilioTemplates')) {
      await syncRowsDelta(pool, 'twilio_templates', previous?.twilioTemplates ?? [], data.twilioTemplates, (item) => item.id, (item) => [item.id, item.status, item, nullableDate(item.updatedAt)]);
    }
    if (isDirty('outboxMessages')) {
      await syncOutboxMessagesDelta(pool, previous?.outboxMessages ?? [], data.outboxMessages ?? [], rowIdsFor('outboxMessages'));
    }
    if (isDirty('conversationStateSnapshot')) {
      await syncConversationStateDelta(pool, previous?.conversationStateSnapshot?.conversations ?? {}, data.conversationStateSnapshot?.conversations ?? {});
    }
    if (isDirty('scheduledJobs')) {
      await syncRowsDelta(pool, 'scheduled_jobs', previous?.scheduledJobs ?? [], data.scheduledJobs ?? [], (item) => item.id, (item) => [item.id, item.kind, item.targetId, nullableDate(item.runAt), item.status, item.attempts, item, nullableDate(item.updatedAt)]);
    }
    if (isDirty('serviceBotState')) {
      const previousServiceBotState = previous ? serviceBotStateFromSnapshot(previous) : null;
      const nextServiceBotState = serviceBotStateFromSnapshot(data);
      if (!previousServiceBotState || !sameJson(previousServiceBotState, nextServiceBotState)) {
        await pool.query(
          `insert into service_bot_state(id, data, updated_at) values ('current', $1, now())
           on conflict (id) do update set data = excluded.data, updated_at = now()`,
          [jsonbParam(nextServiceBotState)],
        );
      }
    }

    await pool.query('commit');
  } catch (err) {
    await pool.query('rollback');
    throw err;
  }
}

/**
 * campaign_events rows are append-only in normal operation (recordCampaignEvent
 * only ever pushes; nothing in storage.ts mutates an existing event's fields).
 * The one exception is resetCampaignData, which removes a campaign's events by
 * filtering the array. We detect that safely and cheaply: if `previous` is a
 * true prefix of `data` by id (a fast id-only comparison, not a full deep
 * comparison), only the new tail needs to be synced. If the id sequence doesn't
 * match a simple append (a reset, or any other reordering), fall back to the
 * exact same full comparison used before this optimization - always correct,
 * just not fast for that one case.
 */
export async function syncCampaignEventsDelta(pool: Pool, previousRows: StorageData['campaignEvents'], nextRows: StorageData['campaignEvents']): Promise<void> {
  const isAppendOnly = nextRows.length >= previousRows.length
    && previousRows.every((row, index) => nextRows[index]?.id === row.id);
  const rowsToUpsert = isAppendOnly ? nextRows.slice(previousRows.length) : nextRows;
  const rowsToCompareAgainst = isAppendOnly ? [] : previousRows;
  await syncRowsDelta(
    pool,
    'campaign_events',
    rowsToCompareAgainst,
    rowsToUpsert,
    (item) => item.id,
    (item) => [item.id, item.campaignId, item.campaignResultId ?? null, item.resultBatchId ?? null, item.phone ?? null, item.type, item.dedupeKey ?? null, nullableDate(item.createdAt), item],
  );
}

function outboxMessageParams(item: StorageData['outboxMessages'][number]): unknown[] {
  return [item.id, item.kind, item.to, item.status, item.attempts, item.providerMessageId ?? null, item.idempotencyKey ?? null, nullableDate(item.processingStartedAt), nullableDate(item.nextAttemptAt), nullableDate(item.createdAt), nullableDate(item.updatedAt), item];
}

function campaignResultParams(item: StorageData['campaignResults'][number]): unknown[] {
  return [item.id, item.campaignId, item.resultBatchId ?? null, item.phone, item.status, item.lastStage ?? null, nullableDate(item.triggeredAt), nullableDate(item.updatedAt), item];
}
function contactQueueParams(item: StorageData['contactQueue'][number]): unknown[] {
  return [item.id, item.phone, item.status, nullableDate(item.nextAttemptAt), item.attempts, item, nullableDate(item.updatedAt)];
}
function contactsListParams(item: StorageData['contactsList'][number]): unknown[] {
  return [item.phone, item.name, nullableDate(item.savedAt), item];
}

/**
 * Rows in these tables are mutated in place after creation (status
 * transitions, field updates), so unlike campaign_events they can't use an
 * append-only fast path. Instead every persist() call names the exact row
 * id(s) it changed (see StorageTableName and persist() in storage.ts). When
 * `touchedIds` is a concrete set, we look up only those rows directly - no
 * scan of the rest of the table.
 *
 * Safety net: if a bulk removal path doesn't tag every id it drops, or any
 * untouched row's content differs for a reason we don't know about, the cheap
 * structural check below (comparing the untouched portion's *count*, not its
 * content) catches it and falls back to the exact full comparison used before
 * this optimization - always correct, just not fast for that one case.
 */
async function syncRowsDeltaTracked<T extends Record<string, any>>(
  pool: Pool,
  table: string,
  previousRows: T[],
  nextRows: T[],
  keyOf: (row: T) => string,
  values: (row: T) => unknown[],
  touchedIds: DirtyRowIds,
): Promise<void> {
  const fullSync = () => syncRowsDelta(pool, table, previousRows, nextRows, keyOf, values);

  if (touchedIds === 'all') return fullSync();

  const untouchedPreviousCount = previousRows.filter((row) => !touchedIds.has(keyOf(row))).length;
  const untouchedNextCount = nextRows.filter((row) => !touchedIds.has(keyOf(row))).length;
  if (untouchedPreviousCount !== untouchedNextCount) return fullSync();

  const previousByKey = new Map(previousRows.map((row) => [keyOf(row), row]));
  const nextByKey = new Map(nextRows.map((row) => [keyOf(row), row]));
  const keyColumn = table === 'saved_contacts' ? 'phone' : 'id';
  for (const key of touchedIds) {
    const row = nextByKey.get(key);
    if (!row) {
      // Named as touched but no longer present - only reachable if something
      // removes a row of this table without tagging the removal. Handle it
      // correctly rather than silently doing nothing.
      if (previousByKey.has(key)) await pool.query(`delete from ${table} where ${keyColumn} = $1`, [key]);
      continue;
    }
    const previousRow = previousByKey.get(key);
    if (previousRow && sameJson(previousRow, row)) continue;
    await upsertRow(pool, table, values(row));
  }
}

export async function syncOutboxMessagesDelta(pool: Pool, previousRows: StorageData['outboxMessages'], nextRows: StorageData['outboxMessages'], touchedIds: DirtyRowIds): Promise<void> {
  return syncRowsDeltaTracked(pool, 'outbox_messages', previousRows, nextRows, (item) => item.id, outboxMessageParams, touchedIds);
}

export async function syncCampaignResultsDelta(pool: Pool, previousRows: StorageData['campaignResults'], nextRows: StorageData['campaignResults'], touchedIds: DirtyRowIds): Promise<void> {
  return syncRowsDeltaTracked(pool, 'campaign_results', previousRows, nextRows, (item) => item.id, campaignResultParams, touchedIds);
}

export async function syncContactQueueDelta(pool: Pool, previousRows: StorageData['contactQueue'], nextRows: StorageData['contactQueue'], touchedIds: DirtyRowIds): Promise<void> {
  return syncRowsDeltaTracked(pool, 'contact_queue', previousRows, nextRows, (item) => item.id, contactQueueParams, touchedIds);
}

export async function syncContactsListDelta(pool: Pool, previousRows: StorageData['contactsList'], nextRows: StorageData['contactsList'], touchedIds: DirtyRowIds): Promise<void> {
  return syncRowsDeltaTracked(pool, 'saved_contacts', previousRows, nextRows, (item) => item.phone, contactsListParams, touchedIds);
}

function serviceBotStateFromSnapshot(data: StorageData): Pick<StorageData,
  'serviceBots' | 'serviceBot' | 'serviceBotSessions' | 'serviceBotRecords' | 'serviceBotFollowUps'
> {
  return {
    serviceBots: data.serviceBots,
    serviceBot: data.serviceBot,
    serviceBotSessions: data.serviceBotSessions,
    serviceBotRecords: data.serviceBotRecords,
    serviceBotFollowUps: data.serviceBotFollowUps,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
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
  const boundParams = bindJsonbParams(table, params);
  const placeholders = boundParams.map((_, index) => `$${index + 1}`).join(', ');
  if (table === 'campaign_events' && boundParams[2] && boundParams[6]) {
    await pool.query(
      `insert into campaign_events(${columns.join(', ')}) values (${placeholders})
       on conflict (campaign_id, campaign_result_id, dedupe_key)
       where dedupe_key is not null and campaign_result_id is not null
       do nothing`,
      boundParams,
    );
    return;
  }
  const keyColumn = table === 'saved_contacts' ? 'phone' : 'id';
  const updates = columns
    .filter((column) => column !== keyColumn)
    .map((column) => `${column} = excluded.${column}`);
  if (table === 'campaigns') updates.push('updated_at = now()');
  await pool.query(
    `insert into ${table}(${columns.join(', ')}) values (${placeholders})
     on conflict (${keyColumn}) do update set ${updates.join(', ')}`,
    boundParams,
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
        jsonbParam(item),
      ],
    );
  }
}

async function replaceRows<T>(pool: Pool, table: string, rows: T[], values: (row: T) => unknown[]): Promise<void> {
  await pool.query(`delete from ${table}`);
  for (const row of rows) {
    const params = values(row);
    const boundParams = bindJsonbParams(table, params);
    const placeholders = boundParams.map((_, index) => `$${index + 1}`).join(', ');
    const columns = tableColumns(table);
    await pool.query(`insert into ${table}(${columns}) values (${placeholders})`, boundParams);
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
    case 'outbox_messages': return 'id, kind, recipient, status, attempts, provider_message_id, idempotency_key, processing_started_at, next_attempt_at, created_at, updated_at, data';
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
        jsonbParam(item),
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
