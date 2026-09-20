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
    public readonly details: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProviderSendError';
  }
  get retryAfterMs(): number | undefined { return this.details.retryAfterMs; }
  get status(): number | undefined { return this.details.status; }
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
