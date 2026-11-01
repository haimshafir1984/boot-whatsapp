/**
 * Issuing side of the signed reply-button ids (P2). OFF unless META_BUTTON_V1_ISSUE=1 on this client, and then only with the whole key
 * set present. The gateway's readiness check (/owner/api/button-v1/readiness) must be clean before the flag is turned on anywhere: every
 * client of the shared number reports resumable-v1 + durable-supersede-v1, the gateway runs META_RESUMABLE_HANDOVER=1 and has the routing keys.
 *
 * Env (client): META_BUTTON_V1_ISSUE, META_BUTTON_ISSUE_KID (which kid signs new buttons, default the only/first configured one),
 * META_BUTTON_CLIENT_ID, META_BUTTON_ROUTE_KEYS, META_BUTTON_FULL_KEYS.
 *
 * A id that does not fit (BUTTON_ID_MAX_LENGTH) or a missing key is a CONFIGURATION ERROR: it is reported and thrown, never replaced by a
 * legacy id (a legacy id cannot come back later, which is the whole point of v1).
 */
import { BUTTON_ID_MAX_LENGTH, ButtonTokenError, deriveRouteKey, issueButtonId } from './buttonToken';
import { ClientButtonKeys, loadClientButtonKeys } from './buttonVerify';
import { computeFlowRev } from './flowRev';

const HOUR_MS = 3600_000;
/** The horizon of a button, measured from the moment it is sent. */
export const BUTTON_LIFETIME_MS = 24 * HOUR_MS;

export class ButtonConfigError extends Error {
  constructor(message: string, public readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = 'ButtonConfigError';
  }
}

export function buttonIssuanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.META_BUTTON_V1_ISSUE === '1';
}

export interface ButtonIssuer {
  issue(args: { resultId: string; stepId: string; optionId: string; conversation: Record<string, unknown> | undefined; nowMs?: number }): string;
}

/**
 * Returns undefined when issuance is off. When it is on but the setup is incomplete this THROWS ButtonConfigError: a half-configured
 * client must not silently go back to unsigned buttons.
 */
export function createButtonIssuer(env: NodeJS.ProcessEnv = process.env, keys: ClientButtonKeys = loadClientButtonKeys(env)): ButtonIssuer | undefined {
  if (!buttonIssuanceEnabled(env)) return undefined;
  const wanted = String(env.META_BUTTON_ISSUE_KID ?? '').trim();
  const kid = wanted || [...keys.full.keys()].find((candidate) => keys.route.has(candidate)) || '';
  const routeKey = keys.route.get(kid); const fullKey = keys.full.get(kid);
  if (!keys.clientId) throw new ButtonConfigError('META_BUTTON_V1_ISSUE=1 but META_BUTTON_CLIENT_ID is not set');
  if (!kid || !routeKey || !fullKey) throw new ButtonConfigError(`META_BUTTON_V1_ISSUE=1 but no usable key pair for kid "${kid}" (needs META_BUTTON_ROUTE_KEYS and META_BUTTON_FULL_KEYS)`);
  if (keys.revoked.has(kid)) throw new ButtonConfigError(`The issuing key id "${kid}" is revoked`);
  return {
    issue({ resultId, stepId, optionId, conversation, nowMs = Date.now() }) {
      try {
        return issueButtonId({
          kid, clientId: keys.clientId, resultId, stepId, optionId,
          rev: computeFlowRev(conversation), exp: Math.floor((nowMs + BUTTON_LIFETIME_MS) / 1000),
        }, { routeKey, fullKey });
      } catch (err) {
        if (err instanceof ButtonTokenError) {
          throw new ButtonConfigError(`A button id for step "${stepId}" option "${optionId}" cannot be issued (${err.reason}: ${err.message}). Shorten the step/option id.`, { stepId, optionId, reason: err.reason });
        }
        throw err;
      }
    },
  };
}

let cached: { signature: string; issuer: ButtonIssuer | undefined } | undefined;
/** Process-wide issuer from the environment (rebuilt when the relevant variables change, which only tests do). */
export function currentButtonIssuer(env: NodeJS.ProcessEnv = process.env): ButtonIssuer | undefined {
  const signature = ['META_BUTTON_V1_ISSUE', 'META_BUTTON_ISSUE_KID', 'META_BUTTON_CLIENT_ID', 'META_BUTTON_ROUTE_KEYS', 'META_BUTTON_FULL_KEYS', 'META_BUTTON_REVOKED_KIDS']
    .map((name) => String(env[name] ?? '')).join('|');
  if (!cached || cached.signature !== signature) cached = { signature, issuer: createButtonIssuer(env) };
  return cached.issuer;
}

/**
 * Save-time validation: every option of every question the buttons/list can carry, with the longest result id this system produces.
 * Returns the options whose id would not fit. Empty when issuance is off.
 */
export function oversizedButtonOptions(conversation: { decisionFlow?: Array<{ id: string; kind?: string; presentation?: string; options?: Array<{ id: string }> }> } | undefined, env: NodeJS.ProcessEnv = process.env): Array<{ stepId: string; optionId: string; length: number }> {
  const issuer = createButtonIssuer(env);
  if (!issuer) return [];
  const out: Array<{ stepId: string; optionId: string; length: number }> = [];
  for (const step of conversation?.decisionFlow ?? []) {
    if (!step.options?.length || (step.presentation !== 'buttons' && step.presentation !== 'list')) continue;
    for (const option of step.options) {
      try { issuer.issue({ resultId: 'x'.repeat(16), stepId: step.id, optionId: option.id, conversation: conversation as Record<string, unknown> }); }
      catch (err) { if (err instanceof ButtonConfigError) out.push({ stepId: step.id, optionId: option.id, length: BUTTON_ID_MAX_LENGTH + 1 }); else throw err; }
    }
  }
  return out;
}
