export const META_CAMPAIGN_CACHE_TTL_MS = 5_000;
export const META_FORWARD_ATTEMPTS = 3;
export const META_FORWARD_RETRY_DELAYS_MS = [500, 1_500];

export type MetaFallbackRouteDecision =
  | { action: 'route'; clientId: string }
  | { action: 'no_match' }
  | { action: 'ambiguous' }
  | { action: 'retry' };

/**
 * A shared Meta number must never use a phone-only sticky session as routing
 * authority. A follow-up is safe to forward only when every client answered
 * both discovery checks and exactly one client proves that it owns a pending
 * conversation for the sender.
 */
export function decideMetaFallbackRoute(input: {
  routeLookupFailures: number;
  pendingLookupFailures: number;
  pendingClientIds: string[];
}): MetaFallbackRouteDecision {
  if (input.routeLookupFailures > 0 || input.pendingLookupFailures > 0) {
    return { action: 'retry' };
  }
  const uniqueClientIds = [...new Set(input.pendingClientIds.filter(Boolean))];
  if (uniqueClientIds.length === 1) return { action: 'route', clientId: uniqueClientIds[0] };
  if (uniqueClientIds.length > 1) return { action: 'ambiguous' };
  return { action: 'no_match' };
}

export interface MetaWebhookItem {
  id: string;
  payload: any;
}

/**
 * Meta may batch several entries, changes, or messages in one webhook request.
 * Downstream routing is intentionally one-message-at-a-time so every reply gets
 * its own durable inbox record instead of silently dropping all but index zero.
 */
export function splitMetaWebhookMessages(payload: any): MetaWebhookItem[] {
  const items: MetaWebhookItem[] = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        const id = String(message?.id || '').trim();
        if (!id) continue;
        items.push({
          id,
          payload: {
            ...payload,
            entry: [{
              ...entry,
              changes: [{
                ...change,
                value: { ...value, messages: [message], statuses: undefined },
              }],
            }],
          },
        });
      }
    }
  }
  return items;
}

export function splitMetaWebhookStatuses(payload: any): any[] {
  const items: any[] = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      if (!statuses.length) continue;
      items.push({
        ...payload,
        entry: [{
          ...entry,
          changes: [{
            ...change,
            value: { ...value, messages: undefined, statuses },
          }],
        }],
      });
    }
  }
  return items;
}

export function metaPayloadSenderKey(payload: any): string {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const from = String(value?.messages?.[0]?.from || '').trim();
  const destination = String(value?.metadata?.phone_number_id || value?.metadata?.display_phone_number || '').trim();
  return `${destination}:${from}` || 'unknown';
}

export function groupMetaItemsBySender<T extends { payload: unknown }>(items: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = metaPayloadSenderKey(item.payload);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

interface CacheEntry<T> {
  value?: T;
  expiresAt?: number;
  pending?: Promise<T>;
}

export class AsyncExpiringCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing?.value !== undefined && (existing.expiresAt ?? 0) > this.now()) {
      return existing.value;
    }
    if (existing?.pending) return existing.pending;

    const pending = load().then(
      (value) => {
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
        return value;
      },
      (error) => {
        this.entries.delete(key);
        throw error;
      },
    );
    this.entries.set(key, { pending });
    return pending;
  }
}

export interface MetaOperationResult {
  ok: boolean;
  status: number;
}

interface RetryOptions<T extends MetaOperationResult> {
  attempts?: number;
  delaysMs?: number[];
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (details: { attempt: number; result?: T; error?: unknown }) => void;
}

export function isRetryableMetaStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function retryTransientMetaOperation<T extends MetaOperationResult>(
  operation: () => Promise<T>,
  options: RetryOptions<T> = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? META_FORWARD_ATTEMPTS);
  const delaysMs = options.delaysMs ?? META_FORWARD_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await operation();
      if (result.ok || !isRetryableMetaStatus(result.status) || attempt === attempts) return result;
      options.onRetry?.({ attempt, result });
    } catch (error) {
      if (attempt === attempts) throw error;
      options.onRetry?.({ attempt, error });
    }
    await sleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0);
  }

  throw new Error('Meta retry loop ended unexpectedly.');
}

export interface SenderDrainerOptions<T> {
  /** Claim up to `limit` items. Must offer at most one item per sender. */
  claim: (limit: number) => T[];
  groupBySender: (items: T[]) => T[][];
  runGroup: (items: T[]) => Promise<void>;
  /** Upper bound on senders being worked on at once. */
  maxConcurrentSenders: number;
  batchSize: number;
  onGroupError?: (err: unknown) => void;
}

/**
 * Drains an inbox without letting one slow sender hold back everyone else.
 *
 * The previous loop awaited an entire batch before claiming the next one. A
 * campaign flow legitimately takes tens of seconds - each step waits for its
 * delivery confirmation before the next is sent - so a participant who arrived
 * while someone else's flow was running was not even looked at until that flow
 * finished. Trigger ages climbed to 79s in production while the client itself
 * matched each trigger in about 130ms.
 *
 * That gate never provided the per-sender ordering it appeared to: ordering
 * comes from claimBatch, which offers at most one item per sender and refuses
 * to hand out a sender whose earlier message is still processing or is waiting
 * on a retry boundary. A second message from the same person is therefore
 * unclaimable until the first finishes, no matter how many senders run at once.
 * The only thing the gate really bought was a cap on concurrent work, which
 * maxConcurrentSenders now states outright instead of implying.
 */
export function createSenderDrainer<T>(options: SenderDrainerOptions<T>): {
  drain: () => Promise<void>;
  inflight: () => number;
} {
  let draining = false;
  let inflight = 0;

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (true) {
        const capacity = options.maxConcurrentSenders - inflight;
        if (capacity <= 0) break;
        // One item per sender, so an item of capacity is a sender of capacity.
        const batch = options.claim(Math.min(options.batchSize, capacity));
        if (!batch.length) break;
        for (const group of options.groupBySender(batch)) {
          inflight += 1;
          void (async () => {
            try {
              await options.runGroup(group);
            } catch (err) {
              options.onGroupError?.(err);
            } finally {
              inflight -= 1;
            }
          })();
        }
      }
    } finally {
      draining = false;
    }
  };

  return { drain, inflight: () => inflight };
}
