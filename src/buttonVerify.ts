/**
 * Reading side of the signed reply-button ids (P1): key rings from the environment, the gateway's routing decision and the client's
 * verification/ownership checks. Nothing here issues a button (src/buttonToken.ts has issueButtonId, not wired in) and nothing here
 * acts on a verified tap yet: a valid v1 tap is only reported, the flow does not run it (resume/jump come in later stages).
 * Spec: docs/returning-buttons-implementation-spec-2026-11-01.md sections 3.1-3.3.
 *
 * A v1-looking id (starts with "v1.") NEVER falls back to the legacy path: a bad one is rejected.
 */
import {
  ButtonClaims, ButtonTokenFailure, ParsedButtonId, deriveRouteKey, isExpired, isV1ButtonId, parseButtonId,
  verifyAllSignatures, verifyRouteSignature,
} from './buttonToken';
import { computeFlowRev } from './flowRev';
import type { Campaign, CampaignResult } from './storage';

const MIN_KEY_BYTES = 16;

/** "kid:base64url,kid2:base64url" -> Map. Malformed or too-short entries are skipped (a key that cannot be used verifies nothing). */
export function parseKeyList(text: string | undefined): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const entry of String(text ?? '').split(',')) {
    const trimmed = entry.trim();
    const at = trimmed.indexOf(':');
    if (at <= 0) continue;
    const kid = trimmed.slice(0, at).trim();
    const key = Buffer.from(trimmed.slice(at + 1).trim(), 'base64url');
    if (!/^[A-Za-z0-9_-]{1,8}$/.test(kid) || key.length < MIN_KEY_BYTES) continue;
    out.set(kid, key);
  }
  return out;
}

export function parseRevokedKids(text: string | undefined): Set<string> {
  return new Set(String(text ?? '').split(',').map((kid) => kid.trim()).filter(Boolean));
}

export interface GatewayButtonKeys { master: Map<string, Buffer>; revoked: Set<string> }
export interface ClientButtonKeys { route: Map<string, Buffer>; full: Map<string, Buffer>; revoked: Set<string>; clientId: string }

/** Gateway: META_BUTTON_ROUTE_MASTER_KEYS, META_BUTTON_REVOKED_KIDS. */
export function loadGatewayButtonKeys(env: NodeJS.ProcessEnv = process.env): GatewayButtonKeys {
  return { master: parseKeyList(env.META_BUTTON_ROUTE_MASTER_KEYS), revoked: parseRevokedKids(env.META_BUTTON_REVOKED_KIDS) };
}

/** Client: META_BUTTON_CLIENT_ID (its id in the owner dashboard), META_BUTTON_ROUTE_KEYS (already derived for this client), META_BUTTON_FULL_KEYS. */
export function loadClientButtonKeys(env: NodeJS.ProcessEnv = process.env): ClientButtonKeys {
  return {
    route: parseKeyList(env.META_BUTTON_ROUTE_KEYS),
    full: parseKeyList(env.META_BUTTON_FULL_KEYS),
    revoked: parseRevokedKids(env.META_BUTTON_REVOKED_KIDS),
    clientId: String(env.META_BUTTON_CLIENT_ID ?? '').trim(),
  };
}

/** The ids of an interactive reply (never the visible titles: a user can type those). */
export function interactiveReplyId(message: any): string {
  return String(message?.interactive?.button_reply?.id ?? message?.interactive?.list_reply?.id ?? '');
}

export type GatewayButtonDecision =
  | { action: 'legacy' }
  | { action: 'route'; clientId: string; claims: ButtonClaims }
  | { action: 'reject'; reason: ButtonTokenFailure | 'unknown_kid' | 'revoked_kid' | 'unknown_client' };

/**
 * Gateway: what to do with an interactive reply. `knownClientIds` are the clients of this number. A tap is not a trigger, so a valid one
 * goes straight to the issuing client with no pending-route fan-out and no handover.
 */
export function decideGatewayButton(id: string, keys: GatewayButtonKeys, knownClientIds: ReadonlySet<string>, nowMs = Date.now()): GatewayButtonDecision {
  if (!isV1ButtonId(id)) return { action: 'legacy' };
  const parsed = parseButtonId(id);
  if (!parsed.ok) return { action: 'reject', reason: parsed.reason };
  const { claims } = parsed.parsed;
  if (keys.revoked.has(claims.kid)) return { action: 'reject', reason: 'revoked_kid' };
  const master = keys.master.get(claims.kid);
  if (!master) return { action: 'reject', reason: 'unknown_kid' };
  if (isExpired(claims, nowMs)) return { action: 'reject', reason: 'expired' };
  if (!verifyRouteSignature(parsed.parsed, deriveRouteKey(master, claims.clientId))) return { action: 'reject', reason: 'bad_route_sig' };
  if (!knownClientIds.has(claims.clientId)) return { action: 'reject', reason: 'unknown_client' };
  return { action: 'route', clientId: claims.clientId, claims };
}

export type ClientButtonRejection =
  | ButtonTokenFailure | 'unknown_kid' | 'revoked_kid' | 'wrong_client' | 'no_client_id'
  | 'no_result' | 'wrong_sender' | 'no_campaign' | 'campaign_inactive' | 'no_step' | 'no_option' | 'not_current_run' | 'rev_mismatch';

export type ClientButtonVerdict =
  | { kind: 'legacy' }
  | { kind: 'reject'; reason: ClientButtonRejection }
  | { kind: 'verified'; claims: ButtonClaims; result: CampaignResult; campaign: Campaign };

export interface ClientButtonLookups {
  /** The result with this id among this sender's results (or undefined). */
  findResult(resultId: string, senderPhone: string): CampaignResult | undefined;
  getCampaign(campaignId: string): Campaign | undefined;
  /** The sender's current run (latest not superseded), as storage.getCurrentRun. */
  getCurrentRun(senderPhone: string): CampaignResult | undefined;
}

const digits = (value: string): string => String(value ?? '').replace(/\D/g, '');

/**
 * Client: signatures, expiry, client id, then ownership (spec 3.1 "binding to the participant"): the result belongs to THIS sender, is her
 * current run, the campaign is active, step and option exist and belong together, and the structure revision is the current one.
 */
export function verifyClientButton(id: string, senderPhone: string, keys: ClientButtonKeys, lookups: ClientButtonLookups, nowMs = Date.now()): ClientButtonVerdict {
  if (!isV1ButtonId(id)) return { kind: 'legacy' };
  const parsed = parseButtonId(id);
  if (!parsed.ok) return { kind: 'reject', reason: parsed.reason };
  const { claims } = parsed.parsed;
  if (keys.revoked.has(claims.kid)) return { kind: 'reject', reason: 'revoked_kid' };
  const routeKey = keys.route.get(claims.kid); const fullKey = keys.full.get(claims.kid);
  if (!routeKey || !fullKey) return { kind: 'reject', reason: 'unknown_kid' };
  if (!keys.clientId) return { kind: 'reject', reason: 'no_client_id' };
  if (!verifyAllSignatures(parsed.parsed, { routeKey, fullKey })) return { kind: 'reject', reason: 'bad_sig' };
  if (isExpired(claims, nowMs)) return { kind: 'reject', reason: 'expired' };
  if (claims.clientId !== keys.clientId) return { kind: 'reject', reason: 'wrong_client' };

  const result = lookups.findResult(claims.resultId, senderPhone);
  if (!result) return { kind: 'reject', reason: 'no_result' };
  if (digits(result.phone) !== digits(senderPhone)) return { kind: 'reject', reason: 'wrong_sender' };
  const campaign = lookups.getCampaign(result.campaignId);
  if (!campaign) return { kind: 'reject', reason: 'no_campaign' };
  if (!campaign.active) return { kind: 'reject', reason: 'campaign_inactive' };
  const step = (campaign.conversation?.decisionFlow ?? []).find((candidate) => candidate.id === claims.stepId);
  if (!step) return { kind: 'reject', reason: 'no_step' };
  if (!(step.options ?? []).some((option) => option.id === claims.optionId)) return { kind: 'reject', reason: 'no_option' };
  if (lookups.getCurrentRun(senderPhone)?.id !== result.id) return { kind: 'reject', reason: 'not_current_run' };
  if (computeFlowRev(campaign.conversation as unknown as Record<string, unknown>) !== claims.rev) return { kind: 'reject', reason: 'rev_mismatch' };
  return { kind: 'verified', claims, result, campaign };
}

export type { ParsedButtonId };
