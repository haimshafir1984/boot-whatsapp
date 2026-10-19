/**
 * Shared classification of a failed provider send (stage B, section 6.3).
 *
 * The question a caller must answer before it may retry is NOT "did the call
 * throw" but "can the provider possibly have accepted the message":
 *
 *  - rejected_permanent : provider answered and refused for good (4xx). Retrying
 *                         the same payload cannot succeed -> failed + alert.
 *  - rejected_transient : provider answered "not now" (429) or we never reached
 *                         it (connection refused / DNS). Nothing was accepted, so
 *                         a bounded retry with the same logical id is safe.
 *  - uncertain          : timeout, dropped connection, unreadable 5xx. The
 *                         provider MAY have accepted it. Never resend, never fall
 *                         back to another message kind; stop dependent messages
 *                         and let an operator (or a delivery webhook) decide.
 *
 * Errors that carry no classification (Baileys/Twilio, plain Errors) keep the
 * pre-existing behaviour: treated as rejected_transient. That is a known gap,
 * see docs/system-safety-speed-stage-b-results-2026-09-20.md.
 */
export type SendOutcome = 'rejected_permanent' | 'rejected_transient' | 'uncertain';

export class ProviderSendError extends Error {
  constructor(
    message: string,
    public readonly outcome: SendOutcome,
    public readonly details: { status?: number; retryAfterMs?: number; cause?: unknown; rateLimited?: boolean; metaCode?: number } = {},
  ) {
    super(message);
    this.name = 'ProviderSendError';
  }
  get retryAfterMs(): number | undefined { return this.details.retryAfterMs; }
  get status(): number | undefined { return this.details.status; }
  /** Meta refused the call because of a rate limit; it did not accept the message, so a bounded wait-and-retry is safe. */
  get rateLimited(): boolean { return this.details.rateLimited === true; }
}

/** Nothing can have been accepted when the connection was never established. */
const NEVER_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);
const UNCERTAIN_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR',
]);

function codeOf(err: unknown): string | undefined {
  const anyErr = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = anyErr?.code ?? anyErr?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

export function classifySendError(err: unknown): { outcome: SendOutcome; retryAfterMs?: number; classified: boolean } {
  if (err instanceof ProviderSendError) return { outcome: err.outcome, retryAfterMs: err.retryAfterMs, classified: true };
  const code = codeOf(err);
  const name = (err as { name?: unknown } | null)?.name;
  if (code && NEVER_SENT_CODES.has(code)) return { outcome: 'rejected_transient', classified: true };
  if (name === 'TimeoutError' || name === 'AbortError' || (code && UNCERTAIN_CODES.has(code))) {
    return { outcome: 'uncertain', classified: true };
  }
  return { outcome: 'rejected_transient', classified: false };
}

export function isUncertainSendError(err: unknown): boolean {
  return classifySendError(err).outcome === 'uncertain';
}

/** Retry-After as milliseconds (delta-seconds or HTTP date); undefined if absent/invalid. */
export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Classification of an HTTP status returned by the provider for a message POST. */
export function classifyHttpStatus(status: number): SendOutcome {
  if (status === 429) return 'rejected_transient';
  if (status === 408 || status >= 500) return 'uncertain';
  return 'rejected_permanent';
}

/**
 * Meta's rate-limit refusals. Meta returns most of them as HTTP **400** (not 429) with an `error.code`, so the status alone
 * would classify them as permanent and the message would be lost (18.10.2026: 130429 right after a restart, 131056 for a
 * participant who pressed buttons 25 times in 40 seconds). All of these are refusals - nothing was accepted - so waiting and
 * sending the same payload again is safe. Deliberately NOT included: 131048 (spam rate limit: an account-quality problem a retry makes worse).
 *   4 / 17 / 613 : Graph API call-volume limits | 80007 : WABA rate limit | 130429 : Cloud API throughput | 131056 : business/consumer pair limit
 */
const META_RATE_LIMIT_WAIT_MS = new Map<number, number>([[4, 10_000], [17, 10_000], [613, 10_000], [80007, 10_000], [130429, 5_000], [131056, 8_000]]);
/** Total attempts (including the first) for a rate-limited send; ordinary transient failures keep their own, smaller budget. */
export const RATE_LIMIT_SEND_ATTEMPTS = 4;
/** No single wait for a rate-limited retry is longer than this: the flow holds the participant (and a client slot) while it waits. */
export const RATE_LIMIT_MAX_WAIT_MS = 15_000;

export function metaErrorCode(body: unknown): number | undefined {
  const code = (body as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
}

/** HTTP status + Meta error body -> outcome, with the rate-limit details a retry needs. */
export function classifyMetaApiResponse(status: number, body: unknown, retryAfterMs?: number): { outcome: SendOutcome; rateLimited: boolean; retryAfterMs?: number; metaCode?: number } {
  const metaCode = metaErrorCode(body);
  const limitedByCode = metaCode !== undefined && META_RATE_LIMIT_WAIT_MS.has(metaCode) && (status === 400 || status === 403 || status === 429);
  if (status === 429 || limitedByCode) {
    const hint = metaCode !== undefined ? META_RATE_LIMIT_WAIT_MS.get(metaCode) : undefined;
    return { outcome: 'rejected_transient', rateLimited: true, retryAfterMs: retryAfterMs ?? hint, metaCode };
  }
  return { outcome: classifyHttpStatus(status), rateLimited: false, retryAfterMs, metaCode };
}

export function isRateLimitSendError(err: unknown): boolean {
  return err instanceof ProviderSendError && err.rateLimited;
}

/** How long to wait before the next in-flow attempt: the fixed delay, or - for a rate limit - Retry-After / Meta's wait hint, bounded. */
export function sendRetryDelayMs(err: unknown, baseDelayMs: number): number {
  if (!isRateLimitSendError(err)) return baseDelayMs;
  const wanted = (err as ProviderSendError).retryAfterMs ?? baseDelayMs;
  return Math.min(Math.max(wanted, baseDelayMs), RATE_LIMIT_MAX_WAIT_MS);
}
