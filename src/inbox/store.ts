import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { MetaGatewayInbox, MetaGatewayInboxItem } from '../metaGatewayInbox';
import { metaPayloadSenderKey } from '../metaGatewayReliability';
import { InboxRuntimeConfig } from './config';
import { PostgresInboxRepository } from './postgresRepository';
import { createInboxPool, migrateInboxSchema } from './schema';
import { assertBackendConsistency } from './migration';
import { InboxResolution } from './types';

/**
 * What the two drainers, the HTTP receipt paths, the admin actions and shutdown talk to. Everything is async and nothing is
 * acknowledged before it is durable. Two implementations:
 *   PostgresInboxStore - the durable, scalable one (stage E).
 *   JsonInboxStore     - the LEGACY file inbox behind the same async contract. Kept only so nothing changes until an explicit,
 *                        rehearsed migration; it is NOT scalable and is never used as a fallback for a failing PostgreSQL.
 */

/** A claimed unit of work. `id` is the Meta message id (logs, alerts); `ref`/`token` address the backend row and fence a stale worker. */
export interface StoredInboxItem { id: string; ref: string; token: string; payload: any; attempts: number }

export interface AmbiguousInboxItem { id: string; senderPhone: string; resolution: string | null }

/** What an admin sees of an item that needs attention. The payload itself is never returned - only a short preview of the participant's text. */
export interface InboxReviewItem {
  id: string; status: string; resolution: string | null; attempts: number; senderPhone: string; lastError: string | null;
  receivedAt: string; updatedAt: string; bodyPreview: string; cursor: { updatedAt: string; id: string };
}

export function bodyPreviewOf(payload: any): string {
  const m = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const text = m?.text?.body ?? m?.interactive?.button_reply?.title ?? m?.interactive?.list_reply?.title ?? m?.button?.text ?? '';
  return String(text).slice(0, 120);
}

export interface InboxCountsView { queued: number; processing: number; retry: number; held: number; failed: number; review: number; completed: number }

export interface InboxStore {
  readonly backend: 'json' | 'postgres';
  readonly role: 'gateway' | 'client';
  /** Migrations / load. Rejects when the store cannot be used (no fallback). */
  init(): Promise<void>;
  /** All-or-nothing. Resolves only after the items are durable. */
  enqueueMany(items: Array<{ id: string; payload: any }>): Promise<{ inserted: string[]; duplicates: string[] }>;
  claim(limit: number): Promise<{ claimed: StoredInboxItem[]; reviewed: AmbiguousInboxItem[] }>;
  renew(item: StoredInboxItem): Promise<boolean>;
  complete(item: StoredInboxItem, resolution?: InboxResolution): Promise<boolean>;
  retry(item: StoredInboxItem, error: unknown, nextAttemptAt: Date): Promise<boolean>;
  hold(item: StoredInboxItem, reason: unknown): Promise<boolean>;
  fail(item: StoredInboxItem, error: unknown): Promise<boolean>;
  review(item: StoredInboxItem, resolution: InboxResolution, detail?: unknown): Promise<boolean>;
  cancelForPhone(phoneDigits: string): Promise<number>;
  /** Default: held items only (existing behaviour). Review items need `statuses` including 'review' (+ ack for ambiguous). */
  resolveForPhone(phoneDigits: string, action: 'requeue' | 'discard', actor: string, opts?: { statuses?: Array<'held' | 'failed' | 'review'>; acknowledgeDuplicateRisk?: boolean }): Promise<number>;
  /** Items that need attention (held / failed / review), oldest first, keyset-paginated. */
  listReview(opts: { statuses?: Array<'held' | 'failed' | 'review'>; limit?: number; after?: { updatedAt: string; id: string } }): Promise<InboxReviewItem[]>;
  counts(): Promise<InboxCountsView>;
  /** Oldest due item age (ms), null = nothing waiting. JSON: null. */
  oldestDueAgeMs(): Promise<number | null>;
  close(): Promise<void>;
}

// ------------------------------------------------------------------------------------------------ identity from a Meta payload

export function inboxIdentityFromPayload(payload: any): { messageId: string; phoneNumberId: string; senderKey: string; senderPhone: string; providerTs: Date | null } {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  const dest = String(value?.metadata?.phone_number_id || value?.metadata?.display_phone_number || '').trim();
  const from = String(message?.from || '').trim();
  const ts = Number(message?.timestamp);
  return {
    messageId: String(message?.id || '').trim(),
    phoneNumberId: dest || 'unknown',
    senderKey: metaPayloadSenderKey(payload),
    senderPhone: from.replace(/\D/g, ''),
    providerTs: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null,
  };
}

// ------------------------------------------------------------------------------------------------ PostgreSQL

export class PostgresInboxStore implements InboxStore {
  readonly backend = 'postgres' as const;
  private pool?: Pool;
  private repo?: PostgresInboxRepository;
  private readonly workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  constructor(private readonly cfg: InboxRuntimeConfig) {}
  get role(): 'gateway' | 'client' { return this.cfg.role; }

  async init(): Promise<void> {
    if (this.repo) return;
    if (!this.cfg.databaseUrl) throw new Error('PostgreSQL inbox has no connection string');
    const pool = createInboxPool(this.cfg.databaseUrl, { max: this.cfg.poolMax });
    try {
      await migrateInboxSchema(pool);
      await pool.query('select 1');
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
    this.pool = pool;
    this.repo = new PostgresInboxRepository(pool, { namespace: this.cfg.namespace, role: this.cfg.role });
  }

  private get r(): PostgresInboxRepository {
    if (!this.repo) throw new Error('PostgreSQL inbox is not initialised (init() failed or was not awaited)');
    return this.repo;
  }

  async enqueueMany(items: Array<{ id: string; payload: any }>): Promise<{ inserted: string[]; duplicates: string[] }> {
    return this.r.enqueueMany(items.map((item) => {
      const identity = inboxIdentityFromPayload(item.payload);
      return { messageId: item.id, phoneNumberId: identity.phoneNumberId, senderKey: identity.senderKey, senderPhone: identity.senderPhone, payload: item.payload, providerTs: identity.providerTs };
    }));
  }

  async claim(limit: number): Promise<{ claimed: StoredInboxItem[]; reviewed: AmbiguousInboxItem[] }> {
    const result = await this.r.claim(limit, { workerId: this.workerId, leaseMs: this.cfg.leaseMs });
    return {
      claimed: result.claimed.map((c) => ({ id: c.item.messageId, ref: c.item.id, token: c.leaseToken, payload: c.item.payload, attempts: c.item.attempts })),
      reviewed: result.reviewed.map((i) => ({ id: i.messageId, senderPhone: i.senderPhone, resolution: i.resolution })),
    };
  }

  async renew(item: StoredInboxItem): Promise<boolean> { return this.r.renew(item.ref, item.token, this.cfg.leaseMs); }
  async complete(item: StoredInboxItem, resolution: InboxResolution = 'processed'): Promise<boolean> { return this.r.complete(item.ref, item.token, resolution); }
  async retry(item: StoredInboxItem, error: unknown, nextAttemptAt: Date): Promise<boolean> { return this.r.retry(item.ref, item.token, error, nextAttemptAt); }
  async hold(item: StoredInboxItem, reason: unknown): Promise<boolean> { return this.r.hold(item.ref, item.token, reason); }
  async fail(item: StoredInboxItem, error: unknown): Promise<boolean> { return this.r.fail(item.ref, item.token, error); }
  async review(item: StoredInboxItem, resolution: InboxResolution, detail?: unknown): Promise<boolean> { return this.r.review(item.ref, item.token, resolution, detail); }
  async cancelForPhone(phoneDigits: string): Promise<number> { return this.r.cancelForPhone(phoneDigits); }
  async resolveForPhone(phoneDigits: string, action: 'requeue' | 'discard', actor: string, opts?: { statuses?: Array<'held' | 'failed' | 'review'>; acknowledgeDuplicateRisk?: boolean }): Promise<number> {
    return this.r.resolveForPhone(phoneDigits, action, actor, opts);
  }

  async listReview(opts: { statuses?: Array<'held' | 'failed' | 'review'>; limit?: number; after?: { updatedAt: string; id: string } }): Promise<InboxReviewItem[]> {
    const items = await this.r.listReview({ statuses: opts.statuses, limit: opts.limit, after: opts.after ? { updatedAt: opts.after.updatedAt, id: opts.after.id } : undefined });
    return items.map((i) => ({
      id: i.messageId, status: i.status, resolution: i.resolution, attempts: i.attempts, senderPhone: i.senderPhone, lastError: i.lastError,
      receivedAt: new Date(i.receivedAt).toISOString(), updatedAt: new Date(i.updatedAt).toISOString(), bodyPreview: bodyPreviewOf(i.payload),
      cursor: { updatedAt: i.updatedAtText ?? new Date(i.updatedAt).toISOString(), id: i.id },
    }));
  }

  async counts(): Promise<InboxCountsView> {
    const c = await this.r.counts();
    return { queued: c.queued, processing: c.processing, retry: c.retry, held: c.held, failed: c.failed, review: c.review, completed: c.completedLastHour };
  }

  async oldestDueAgeMs(): Promise<number | null> { return (await this.r.metrics()).oldestDueAgeMs; }

  /** Bounded cleanup batches (dedupe window / payload retention). Called on a slow timer by the runtime. */
  async cleanup(): Promise<{ deleted: number; payloadsPurged: number; sendersRemoved: number }> {
    return this.r.cleanup({ dedupeDays: this.cfg.dedupeDays, payloadDays: this.cfg.payloadDays, batch: 1000 });
  }

  async checkInvariants() { return this.r.checkInvariants(); }

  async close(): Promise<void> {
    const pool = this.pool; this.pool = undefined; this.repo = undefined;
    if (pool) await pool.end();
  }
}

// ------------------------------------------------------------------------------------------------ legacy JSON (same contract)

export class JsonInboxStore implements InboxStore {
  readonly backend = 'json' as const;
  private inbox?: MetaGatewayInbox;
  constructor(private readonly filePath: string, readonly role: 'gateway' | 'client') {}

  async init(): Promise<void> {
    if (!this.inbox) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.inbox = new MetaGatewayInbox(this.filePath);
    }
  }
  private get i(): MetaGatewayInbox {
    if (!this.inbox) throw new Error('JSON inbox is not initialised');
    return this.inbox;
  }
  /** Test/migration access to the legacy object. */
  legacy(): MetaGatewayInbox { return this.i; }

  async enqueueMany(items: Array<{ id: string; payload: any }>): Promise<{ inserted: string[]; duplicates: string[] }> {
    for (const item of items) this.i.enqueue(item.id, item.payload);   // legacy: idempotent by id, throws when the write fails
    return { inserted: items.map((item) => item.id), duplicates: [] };
  }

  async claim(limit: number): Promise<{ claimed: StoredInboxItem[]; reviewed: AmbiguousInboxItem[] }> {
    const items = this.i.claimBatch(limit, (item) => metaPayloadSenderKey(item.payload));
    return { claimed: items.map((item) => ({ id: item.id, ref: item.id, token: String(item.attempts), payload: item.payload, attempts: item.attempts })), reviewed: [] };
  }

  async renew(): Promise<boolean> { return true; }
  async complete(item: StoredInboxItem): Promise<boolean> { this.i.markCompleted(item.ref); return true; }
  async retry(item: StoredInboxItem, error: unknown, nextAttemptAt: Date): Promise<boolean> { this.i.markRetry(item.ref, error, nextAttemptAt); return true; }
  async hold(item: StoredInboxItem, reason: unknown): Promise<boolean> { this.i.markHeld(item.ref, reason); return true; }
  async fail(item: StoredInboxItem, error: unknown): Promise<boolean> { this.i.markFailed(item.ref, error); return true; }
  async review(item: StoredInboxItem, _resolution: InboxResolution, detail?: unknown): Promise<boolean> {
    // The legacy file has no `review` state. It is recorded as failed with the reason, never as completed (nothing is silently completed).
    this.i.markFailed(item.ref, new Error(`[REVIEW:${_resolution}] ${JSON.stringify(detail ?? {})}`));
    return true;
  }
  async cancelForPhone(phoneDigits: string): Promise<number> { return this.i.cancelPendingForPhone(phoneDigits); }

  async resolveForPhone(phoneDigits: string, action: 'requeue' | 'discard'): Promise<number> {
    const matcher = (item: MetaGatewayInboxItem): string => {
      const from = String((item.payload as any)?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from || '').replace(/\D/g, '');
      return phoneDigits && from === phoneDigits ? phoneDigits : `no-match:${item.id}`;
    };
    return this.i.resolveHeldForSender(phoneDigits, matcher, action);
  }

  async listReview(opts: { statuses?: Array<'held' | 'failed' | 'review'>; limit?: number; after?: { updatedAt: string; id: string } }): Promise<InboxReviewItem[]> {
    const wanted = (opts.statuses ?? ['held', 'failed', 'review']).filter((st) => st !== 'review') as Array<'held' | 'failed'>;   // the legacy file has no review state (recorded as failed)
    const after = opts.after;
    return this.i.listByStatus(wanted)
      .filter((item) => !after || item.updatedAt > after.updatedAt || (item.updatedAt === after.updatedAt && item.id > after.id))
      .slice(0, Math.min(1000, Math.max(1, opts.limit ?? 100)))
      .map((item) => ({
        id: item.id, status: item.status, resolution: null, attempts: item.attempts, senderPhone: String((item.payload as any)?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from ?? '').replace(/\D/g, ''),
        lastError: item.lastError ?? null, receivedAt: item.createdAt, updatedAt: item.updatedAt, bodyPreview: bodyPreviewOf(item.payload), cursor: { updatedAt: item.updatedAt, id: item.id },
      }));
  }

  async counts(): Promise<InboxCountsView> {
    const c = this.i.counts();
    return { queued: c.queued, processing: c.processing, retry: c.retry, held: c.held, failed: c.failed, review: 0, completed: c.completed };
  }
  async oldestDueAgeMs(): Promise<number | null> { return null; }
  async close(): Promise<void> { this.inbox = undefined; }
}

export function createInboxStore(cfg: InboxRuntimeConfig, jsonFilePath: string): InboxStore {
  // Two backends are never active writers, and an unmigrated legacy file is never silently ignored.
  assertBackendConsistency(cfg.backend, jsonFilePath);
  return cfg.backend === 'postgres' ? new PostgresInboxStore(cfg) : new JsonInboxStore(jsonFilePath, cfg.role);
}

/**
 * A process that has no managed clients and no gateway database (a plain client in PostgreSQL mode). It REFUSES receipts - it never
 * acknowledges and never drops - and claims nothing. Used so a client is not forced to configure a gateway inbox it will never use.
 */
export class DisabledInboxStore implements InboxStore {
  readonly backend = 'postgres' as const;
  constructor(readonly role: 'gateway' | 'client') {}
  async init(): Promise<void> { /* nothing to open */ }
  async enqueueMany(): Promise<{ inserted: string[]; duplicates: string[] }> { throw new Error(`the ${this.role} inbox is disabled on this process (no managed clients and no INBOX_DATABASE_URL): message refused, not acknowledged`); }
  async claim(): Promise<{ claimed: StoredInboxItem[]; reviewed: AmbiguousInboxItem[] }> { return { claimed: [], reviewed: [] }; }
  async renew(): Promise<boolean> { return false; }
  async complete(): Promise<boolean> { return false; }
  async retry(): Promise<boolean> { return false; }
  async hold(): Promise<boolean> { return false; }
  async fail(): Promise<boolean> { return false; }
  async review(): Promise<boolean> { return false; }
  async cancelForPhone(): Promise<number> { return 0; }
  async resolveForPhone(): Promise<number> { return 0; }
  async listReview(): Promise<InboxReviewItem[]> { return []; }
  async counts(): Promise<InboxCountsView> { return { queued: 0, processing: 0, retry: 0, held: 0, failed: 0, review: 0, completed: 0 }; }
  async oldestDueAgeMs(): Promise<number | null> { return null; }
  async close(): Promise<void> { /* nothing */ }
}
