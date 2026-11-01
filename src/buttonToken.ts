/**
 * Signed reply-button ids ("v1") for Meta interactive messages.
 *
 *   v1.<kid>.<clientId>.<resultId>.<stepId>.<optionId>.<rev>.<exp>.<routeSig>.<sig>
 *
 * - <kid>: key id (key ring slot), plain [A-Za-z0-9_-], 1..8 chars.
 * - <clientId> <resultId> <stepId> <optionId> <rev>: ALWAYS base64url of the UTF-8 value (never conditional, so a field never has to be
 *   guessed to be encoded or not).
 * - <exp>: expiry as Unix seconds, base36.
 * - <routeSig>, <sig>: 16 bytes (base64url, 22 chars) of HMAC-SHA256 over the SAME canonical content with different keys and different
 *   purpose strings ("route/v1", "full/v1"): the gateway can verify the first (it owns the routing keys), only the client the second.
 *
 * The canonical content is every claim, length-prefixed, so no value (newline, dot, anything) can shift a boundary between fields.
 * This module is pure: key lookup, revocation, ownership of the result and the sender check are the caller's job (see the spec,
 * docs/returning-buttons-implementation-spec-2026-11-01.md, sections 3.1-3.3).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const BUTTON_ID_VERSION = 'v1';
/** Meta allows more (to be confirmed); the margin is deliberate. A longer id is a configuration error, never silently downgraded. */
export const BUTTON_ID_MAX_LENGTH = 200;
export const BUTTON_SIG_BYTES = 16;
const KID_RE = /^[A-Za-z0-9_-]{1,8}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const B36_RE = /^[0-9a-z]{1,13}$/;
const MAX_FIELD_BYTES = 128;

export interface ButtonClaims {
  kid: string;
  clientId: string;
  resultId: string;
  stepId: string;
  optionId: string;
  rev: string;
  /** Unix seconds. */
  exp: number;
}

export type ButtonTokenFailure =
  | 'not_v1' | 'malformed' | 'bad_field' | 'too_long' | 'bad_kid' | 'bad_exp' | 'expired' | 'bad_route_sig' | 'bad_sig';

export class ButtonTokenError extends Error {
  constructor(public readonly reason: ButtonTokenFailure, message?: string) {
    super(message ?? reason);
    this.name = 'ButtonTokenError';
  }
}

export interface ParsedButtonId {
  claims: ButtonClaims;
  routeSig: Buffer;
  sig: Buffer;
}

export type ParseResult = { ok: true; parsed: ParsedButtonId } | { ok: false; reason: ButtonTokenFailure };

/** True for anything that CLAIMS to be v1 (starts with "v1."). Such an id never falls back to the legacy path, valid or not. */
export function isV1ButtonId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(`${BUTTON_ID_VERSION}.`);
}

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

/** Strict decode: only canonical base64url (re-encoding must give the same text) and valid, non-empty, bounded UTF-8. */
function unb64(text: string): string | null {
  if (!text || !B64URL_RE.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (!bytes.length || bytes.length > MAX_FIELD_BYTES || bytes.toString('base64url') !== text) return null;
  const value = bytes.toString('utf8');
  if (Buffer.from(value, 'utf8').compare(bytes) !== 0) return null;   // invalid UTF-8 would not survive the round trip
  return value;
}

/** Length-prefixed content that is signed. `purpose` separates the two signatures. */
export function canonicalButtonContent(purpose: 'route/v1' | 'full/v1', claims: ButtonClaims): Buffer {
  const parts = [purpose, claims.kid, claims.clientId, claims.resultId, claims.stepId, claims.optionId, claims.rev, String(claims.exp)];
  return Buffer.from(parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|'), 'utf8');
}

function sign(key: Buffer, purpose: 'route/v1' | 'full/v1', claims: ButtonClaims): Buffer {
  return createHmac('sha256', key).update(canonicalButtonContent(purpose, claims)).digest().subarray(0, BUTTON_SIG_BYTES);
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkClaims(claims: ButtonClaims): void {
  if (!KID_RE.test(claims.kid)) throw new ButtonTokenError('bad_kid');
  for (const field of ['clientId', 'resultId', 'stepId', 'optionId', 'rev'] as const) {
    const value = claims[field];
    if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_FIELD_BYTES) throw new ButtonTokenError('bad_field', field);
    if (Buffer.from(value, 'utf8').toString('utf8') !== value) throw new ButtonTokenError('bad_field', `${field} is not valid text`);
  }
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= 0) throw new ButtonTokenError('bad_exp');
}

/**
 * Builds the id. Throws ButtonTokenError('too_long') when the result would exceed BUTTON_ID_MAX_LENGTH: the caller must stop issuing the
 * button and report a configuration error (never fall back to a weaker legacy id).
 */
export function issueButtonId(claims: ButtonClaims, keys: { routeKey: Buffer; fullKey: Buffer }): string {
  checkClaims(claims);
  const id = [
    BUTTON_ID_VERSION, claims.kid, b64(claims.clientId), b64(claims.resultId), b64(claims.stepId), b64(claims.optionId), b64(claims.rev),
    claims.exp.toString(36),
    sign(keys.routeKey, 'route/v1', claims).toString('base64url'),
    sign(keys.fullKey, 'full/v1', claims).toString('base64url'),
  ].join('.');
  if (id.length > BUTTON_ID_MAX_LENGTH) throw new ButtonTokenError('too_long', `${id.length} > ${BUTTON_ID_MAX_LENGTH}`);
  return id;
}

/** Structural parse only (no signature, no expiry). Never throws. */
export function parseButtonId(id: unknown): ParseResult {
  if (typeof id !== 'string') return { ok: false, reason: 'not_v1' };
  if (!isV1ButtonId(id)) return { ok: false, reason: 'not_v1' };
  if (id.length > BUTTON_ID_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  const parts = id.split('.');
  if (parts.length !== 10) return { ok: false, reason: 'malformed' };
  const [, kid, c, r, s, o, rev, exp, routeSigText, sigText] = parts;
  if (!KID_RE.test(kid)) return { ok: false, reason: 'bad_kid' };
  const clientId = unb64(c); const resultId = unb64(r); const stepId = unb64(s); const optionId = unb64(o); const revValue = unb64(rev);
  if (clientId === null || resultId === null || stepId === null || optionId === null || revValue === null) return { ok: false, reason: 'bad_field' };
  if (!B36_RE.test(exp)) return { ok: false, reason: 'bad_exp' };
  const expiry = parseInt(exp, 36);
  if (!Number.isSafeInteger(expiry) || expiry <= 0 || expiry.toString(36) !== exp) return { ok: false, reason: 'bad_exp' };
  const routeSig = Buffer.from(routeSigText, 'base64url'); const sig = Buffer.from(sigText, 'base64url');
  if (routeSigText.length !== 22 || sigText.length !== 22 || !B64URL_RE.test(routeSigText) || !B64URL_RE.test(sigText)
    || routeSig.length !== BUTTON_SIG_BYTES || sig.length !== BUTTON_SIG_BYTES
    || routeSig.toString('base64url') !== routeSigText || sig.toString('base64url') !== sigText) return { ok: false, reason: 'malformed' };
  return { ok: true, parsed: { claims: { kid, clientId, resultId, stepId, optionId, rev: revValue, exp: expiry }, routeSig, sig } };
}

/** The gateway's check: the routing signature covers every claim. Constant-time. */
export function verifyRouteSignature(parsed: ParsedButtonId, routeKey: Buffer): boolean {
  return sameBytes(sign(routeKey, 'route/v1', parsed.claims), parsed.routeSig);
}

/** The client's check: the full signature covers every claim. Constant-time. */
export function verifyFullSignature(parsed: ParsedButtonId, fullKey: Buffer): boolean {
  return sameBytes(sign(fullKey, 'full/v1', parsed.claims), parsed.sig);
}

/**
 * The client's complete check: BOTH signatures (it holds its routing key as well). Both are always computed, so the time taken does not
 * reveal which one failed.
 */
export function verifyAllSignatures(parsed: ParsedButtonId, keys: { routeKey: Buffer; fullKey: Buffer }): boolean {
  const route = verifyRouteSignature(parsed, keys.routeKey);
  const full = verifyFullSignature(parsed, keys.fullKey);
  return route && full;
}

/** Expiry is a hard 24 hour limit from the send time (exp), checked against the verifier's own clock, with a small skew allowance. */
export function isExpired(claims: ButtonClaims, nowMs: number, skewMs = 60_000): boolean {
  return nowMs - skewMs > claims.exp * 1000;
}

/**
 * Per-client routing key, derived from the gateway's master key for that kid, so the gateway needs no per-client storage and a client
 * can only ever sign for itself.
 */
export function deriveRouteKey(masterRouteKey: Buffer, clientId: string): Buffer {
  return createHmac('sha256', masterRouteKey).update(`route-key/v1\n${clientId}`).digest();
}
