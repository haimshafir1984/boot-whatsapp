export const META_CAMPAIGN_CACHE_TTL_MS = 5_000;
export const META_FORWARD_ATTEMPTS = 3;
export const META_FORWARD_RETRY_DELAYS_MS = [500, 1_500];

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
