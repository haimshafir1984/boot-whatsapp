/**
 * Structural revision of a campaign: a short hash that changes whenever something that decides what a button DOES or where it LEADS
 * changes, and does not change when only text shown to the participant is edited. A signed reply-button carries the revision it was issued
 * under; a tap whose revision no longer matches is refused (spec section 3.6).
 *
 * How it is decided what counts: the hash covers the whole resolved conversation settings EXCEPT a short list of display-only text fields.
 * Anything not on that list - including fields added later - is part of the revision, so a forgotten field makes the revision stricter
 * (a few more buttons refused), never looser. Text the code itself compares against is not display-only: see SCORE_RESULT_PLACEHOLDER.
 */
import { createHash } from 'node:crypto';

/** The score_result step skips its preface when the text is exactly this; changing it changes behaviour, so it is part of the revision. */
export const SCORE_RESULT_PLACEHOLDER = 'חישוב תוצאה';

const STEP_DISPLAY_FIELDS = new Set(['text', 'listButtonText', 'timeoutText', 'fallbackText', 'emailInvalidText']);
// referralLeaderboardSeeds is NOT here: it is data that changes the ranking people see (a seed going from 3 to 300 changes what is shown
// and who is ahead), not wording, so it is part of the revision.
const OPTION_DISPLAY_FIELDS = new Set(['text', 'buttonLabel', 'endText', 'referralLeaderboardEmptyText']);
const RULE_DISPLAY_FIELDS = new Set(['label', 'endText']);
const CONVERSATION_DISPLAY_FIELDS = new Set([
  'askNameText', 'replyText', 'followupMessages', 'invalidReplyText', 'flowRecoveryText', 'humanHandoffText', 'decisionTimeoutText',
  'preNamePromptText', 'contactCardIntroText', 'groupJoinParticipantConfirmationText', 'groupJoinParticipantFailureText',
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Deterministic JSON: object keys sorted, undefined dropped. */
function stable(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value as Json;
  if (Array.isArray(value)) return value.map((item) => stable(item));
  if (typeof value === 'object' && value !== null) {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value as object).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined && typeof item !== 'function') out[key] = stable(item);
    }
    return out;
  }
  return null;
}

/**
 * Everything except the display-only fields - but for each of those the PRESENCE is kept (`<field>Present`; for a list of messages, one
 * flag per entry, so their number and order count). Whether a message exists decides whether the engine sends one more message, so adding
 * or removing one changes the revision; rewording one does not.
 */
function without(source: Record<string, unknown>, display: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!display.has(key)) { out[key] = source[key]; continue; }
    const value = source[key];
    if (typeof value === 'string') out[`${key}Present`] = value.trim().length > 0;
    else if (Array.isArray(value)) out[`${key}Present`] = value.map((item) => (typeof item === 'string' ? item.trim().length > 0 : true));
  }
  return out;
}

function stepStructure(step: Record<string, unknown>): Record<string, unknown> {
  const out = without(step, STEP_DISPLAY_FIELDS);
  // `text` presence is kept by without() (an empty contact-card intro or message is skipped); a missing text counts as absent.
  if (!('textPresent' in out)) out.textPresent = false;
  if (step.kind === 'score_result') out.textIsPlaceholder = String(step.text ?? '').trim() === SCORE_RESULT_PLACEHOLDER;
  if (Array.isArray(step.options)) out.options = step.options.map((option) => without(option as Record<string, unknown>, OPTION_DISPLAY_FIELDS));
  if (Array.isArray(step.resultRules)) out.resultRules = step.resultRules.map((rule) => without(rule as Record<string, unknown>, RULE_DISPLAY_FIELDS));
  return out;
}

/** The structure that is hashed (exposed for tests and for diagnostics). */
export function flowStructure(conversation: Record<string, unknown> | undefined | null): Json {
  const base = without((conversation ?? {}) as Record<string, unknown>, CONVERSATION_DISPLAY_FIELDS);
  if (Array.isArray(base.decisionFlow)) base.decisionFlow = (base.decisionFlow as Array<Record<string, unknown>>).map(stepStructure);
  return stable(base);
}

/** 8 base64url characters (48 bits) of SHA-256 over the structure. Not a security boundary: the signed button covers it. */
export function computeFlowRev(conversation: Record<string, unknown> | undefined | null): string {
  return createHash('sha256').update(JSON.stringify(flowStructure(conversation))).digest().subarray(0, 6).toString('base64url');
}
