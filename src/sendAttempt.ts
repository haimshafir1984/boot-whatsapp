import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

/**
 * Identity of ONE provider POST attempt (stage B2, step 1).
 *
 *  - outboxId  : the logical message; constant across retries.
 *  - attemptId : random and unique per POST. It is persisted BEFORE the provider is called and
 *                sent to Meta as `biz_opaque_callback_data`, so a later status webhook can be
 *                matched to exactly this attempt even when the POST response was lost.
 *
 * It is a LINKING id only - not an idempotency key. Meta does not use it to deduplicate.
 * It carries no phone number or other personal data.
 */
export interface SendAttemptContext {
  attemptId: string;
  outboxId: string;
}

const scope = new AsyncLocalStorage<SendAttemptContext>();

export function runWithSendAttempt<T>(context: SendAttemptContext, action: () => Promise<T>): Promise<T> {
  return scope.run(context, action);
}

export function currentSendAttempt(): SendAttemptContext | undefined {
  return scope.getStore();
}

export const ATTEMPT_ID_PREFIX = 'fba1_';
const ATTEMPT_ID_PATTERN = /^fba1_[0-9a-f]{32}$/;

export function newAttemptId(): string {
  return ATTEMPT_ID_PREFIX + randomBytes(16).toString('hex');
}

export function isAttemptId(value: unknown): value is string {
  return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value);
}

/** Attempt ids are sent to Meta only when this is explicitly on (per client, see MetaCloudProvider). */
export function attemptTaggingEnabled(): boolean {
  return process.env.META_ATTEMPT_CALLBACK_DATA === 'on';
}
