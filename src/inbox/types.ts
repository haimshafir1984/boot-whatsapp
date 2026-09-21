/**
 * Stage E - durable inbox repository: contract shared by the PostgreSQL implementation and (in C3) the legacy JSON adapter.
 * Design: docs/stage-e-design-2026-09-21.md. Everything here is async; nothing is acknowledged before it is committed.
 */

export type InboxRole = 'gateway' | 'client';

export type InboxStatus = 'queued' | 'processing' | 'retry' | 'completed' | 'failed' | 'held' | 'review';

/** Outcome vocabulary (design 4.3). A `completed` item was really processed; a stale trigger is `review`, never `completed`. */
export type InboxResolution =
  | 'processed' | 'forwarded' | 'processed_late'
  | 'sender_held'
  | 'stale_trigger' | 'ambiguous_processing'
  | 'exhausted' | 'superseded' | 'admin_discarded';

export interface InboxEnqueueInput {
  /** Meta wamid. */
  messageId: string;
  /** Destination (metadata.phone_number_id). Part of the durable identity. */
  phoneNumberId: string;
  /** `${phone_number_id}:${from}` - the same key as metaPayloadSenderKey(). Orders and serializes work per sender. */
  senderKey: string;
  /** Digits of `from`; admin resolve / cancel match on this regardless of destination. */
  senderPhone: string;
  /** The original single-message envelope. */
  payload: unknown;
  providerTs?: Date | null;
}

export interface InboxItem {
  /** bigint as string (pg returns int8 as string). */
  id: string;
  messageId: string;
  phoneNumberId: string;
  senderKey: string;
  senderPhone: string;
  senderSeq: string;
  status: InboxStatus;
  attempts: number;
  payload: unknown;
  providerTs: Date | null;
  receivedAt: Date;
  firstClaimedAt: Date | null;
  nextAttemptAt: Date | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  claimedBy: string | null;
  effectsState: 'none' | 'possible';
  lastError: string | null;
  resolution: InboxResolution | null;
  resolutionDetail: unknown;
  updatedAt: Date;
  /** updated_at as text with full (microsecond) precision: the keyset cursor must not lose precision or the same item repeats forever. */
  updatedAtText?: string;
  completedAt: Date | null;
}

export interface InboxClaim { item: InboxItem; leaseToken: string }

export interface InboxClaimResult {
  /** Items this worker now owns (one per sender at most). */
  claimed: InboxClaim[];
  /**
   * Client role only: items whose lease expired while effects may have started. They are NOT re-run: they became `review`
   * (resolution `ambiguous_processing`) and the caller must alert + hold the sender.
   */
  reviewed: InboxItem[];
}

export interface EnqueueResult { inserted: string[]; duplicates: string[] }

export interface InboxCounts {
  queued: number; processing: number; retry: number; held: number; failed: number; review: number;
  /** completed within the last hour only (a full count would scan the dedupe history). */
  completedLastHour: number;
}

export interface InboxMetrics {
  /** Age of the longest-waiting item that is due right now (null = nothing due). */
  oldestDueAgeMs: number | null;
  senders: { withOutstanding: number; due: number };
}

export interface InvariantViolation { code: string; senderKey?: string; detail: string }

export interface InboxRepository {
  enqueueMany(inputs: InboxEnqueueInput[]): Promise<EnqueueResult>;
  claim(limit: number, opts: { workerId: string; leaseMs?: number }): Promise<InboxClaimResult>;
  renew(id: string, leaseToken: string, leaseMs?: number): Promise<boolean>;
  complete(id: string, leaseToken: string, resolution?: InboxResolution, detail?: unknown): Promise<boolean>;
  retry(id: string, leaseToken: string, error: unknown, nextAttemptAt: Date): Promise<boolean>;
  hold(id: string, leaseToken: string, reason: unknown): Promise<boolean>;
  fail(id: string, leaseToken: string, error: unknown, resolution?: InboxResolution): Promise<boolean>;
  review(id: string, leaseToken: string, resolution: InboxResolution, detail?: unknown): Promise<boolean>;
  cancelForPhone(phoneDigits: string, reason?: string): Promise<number>;
  /** Default statuses: ['held'] (existing behaviour). A requeued item is re-sequenced BEHIND active work (design D6). */
  resolveForPhone(phoneDigits: string, action: 'requeue' | 'discard', actor: string, opts?: { statuses?: Array<'held' | 'failed' | 'review'>; acknowledgeDuplicateRisk?: boolean }): Promise<number>;
  listReview(opts: { statuses?: Array<'held' | 'failed' | 'review'>; limit?: number; after?: { updatedAt: Date | string; id: string } }): Promise<InboxItem[]>;
  counts(): Promise<InboxCounts>;
  metrics(): Promise<InboxMetrics>;
  cleanup(opts?: { dedupeDays?: number; payloadDays?: number; batch?: number }): Promise<{ deleted: number; payloadsPurged: number; sendersRemoved: number }>;
  checkInvariants(): Promise<InvariantViolation[]>;
  close(): Promise<void>;
}
