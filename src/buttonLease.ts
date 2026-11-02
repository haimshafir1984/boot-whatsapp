/**
 * Fleet lease for issuing signed buttons (P3, Codex review of 33ce19b, mandatory item 2 / open question 1).
 *
 * META_BUTTON_V1_ISSUE=1 on a client is necessary but not enough: the central gateway periodically checks the WHOLE fleet of the shared
 * number (buttonFleetReadiness in adminServer) and, only while that is clean, grants every client a short lease. A client issues signed
 * buttons only while its lease is valid; without one it sends the ordinary legacy buttons (exactly today's behaviour), so one client that
 * turns the flag on by mistake, or a fleet that stops being ready, cannot produce buttons the rest of the system cannot honour.
 *
 * The lease is relative (valid for ttlMs from the moment it ARRIVES), so clocks of the two services need not agree. It lives in memory on
 * purpose: after a restart there is no lease until the gateway's next push (a minute at most), which is the fail-closed direction.
 * Buttons that were already sent keep working when the lease ends; only issuing NEW signed buttons stops.
 */
export const LEASE_MIN_TTL_MS = 10_000;
export const LEASE_MAX_TTL_MS = 10 * 60_000;
export const DEFAULT_LEASE_TTL_MS = 180_000;
export const DEFAULT_LEASE_PUSH_MS = 60_000;

let validUntilMs = 0;

/** Gateway-side settings (read when the push loop starts; tests shorten them). */
export function leaseTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.META_BUTTON_LEASE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, LEASE_MIN_TTL_MS), LEASE_MAX_TTL_MS) : DEFAULT_LEASE_TTL_MS;
}
export function leasePushIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.META_BUTTON_LEASE_PUSH_MS);
  return Number.isFinite(raw) && raw >= 50 ? raw : DEFAULT_LEASE_PUSH_MS;
}

/** Client side: a lease that arrived now and lasts ttlMs (clamped). Returns the moment it ends. */
export function grantButtonLease(ttlMs: number, nowMs = Date.now(), allowShort = false): number {
  const requested = Number(ttlMs);
  const ttl = Number.isFinite(requested) ? Math.min(Math.max(requested, allowShort ? 1 : LEASE_MIN_TTL_MS), LEASE_MAX_TTL_MS) : 0;
  validUntilMs = ttl > 0 ? nowMs + ttl : 0;
  return validUntilMs;
}

export function buttonLeaseValid(nowMs = Date.now()): boolean {
  return validUntilMs > nowMs;
}

export function buttonLeaseValidUntil(): number {
  return validUntilMs;
}

export function revokeButtonLease(): void {
  validUntilMs = 0;
}
