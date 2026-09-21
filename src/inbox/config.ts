/**
 * Stage E inbox configuration (environment). Nothing here silently falls back: a PostgreSQL inbox that cannot be configured
 * or reached is an error (receipts fail with 503, workers stop claiming), never a reason to write JSON files instead.
 *
 *   INBOX_BACKEND               'json' (default, legacy file - NOT scalable) | 'postgres'
 *   INBOX_DATABASE_URL          connection string of the inbox database. REQUIRED for the gateway when INBOX_BACKEND=postgres
 *                               (the gateway has no other database). A client falls back to its own DATABASE_URL.
 *   INBOX_NAMESPACE             identity of this storage inside a shared database (default: 'gateway' / 'client')
 *   INBOX_DB_POOL_MAX           default 10
 *   INBOX_LEASE_MS              default 120000 (a worker renews every third of it while it is alive)
 *   INBOX_DEDUPE_DAYS           default 30   - how long the identity of a finished message is remembered
 *   INBOX_PAYLOAD_RETENTION_DAYS default 7   - how long a finished message keeps its payload
 *   INBOX_SHUTDOWN_WAIT_MS      default 5000 - how long stop() waits for in-flight items
 */
import { InboxRole } from './types';

export interface InboxRuntimeConfig {
  backend: 'json' | 'postgres';
  role: InboxRole;
  namespace: string;
  databaseUrl?: string;
  poolMax: number;
  leaseMs: number;
  dedupeDays: number;
  payloadDays: number;
  shutdownWaitMs: number;
}

const intEnv = (env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${raw}")`);
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

export function readInboxConfig(role: InboxRole, env: NodeJS.ProcessEnv = process.env): InboxRuntimeConfig {
  const requested = String(env.INBOX_BACKEND ?? 'json').trim().toLowerCase();
  if (requested !== 'json' && requested !== 'postgres') throw new Error(`INBOX_BACKEND must be "json" or "postgres" (got "${requested}")`);
  const databaseUrl = role === 'gateway'
    ? (env.INBOX_DATABASE_URL || '').trim()
    : ((env.INBOX_DATABASE_URL || env.DATABASE_URL || '').trim());
  if (requested === 'postgres' && !databaseUrl) {
    throw new Error(role === 'gateway'
      ? 'INBOX_BACKEND=postgres requires INBOX_DATABASE_URL for the gateway (the gateway has no other database). Refusing to fall back to JSON.'
      : 'INBOX_BACKEND=postgres requires INBOX_DATABASE_URL or DATABASE_URL. Refusing to fall back to JSON.');
  }
  return {
    backend: requested,
    role,
    namespace: (env.INBOX_NAMESPACE || (role === 'gateway' ? 'gateway' : 'client')).trim(),
    databaseUrl: databaseUrl || undefined,
    poolMax: intEnv(env, 'INBOX_DB_POOL_MAX', 10, 1, 100),
    leaseMs: intEnv(env, 'INBOX_LEASE_MS', 120_000, 1_000, 30 * 60_000),
    dedupeDays: intEnv(env, 'INBOX_DEDUPE_DAYS', 30, 1, 3650),
    payloadDays: intEnv(env, 'INBOX_PAYLOAD_RETENTION_DAYS', 7, 1, 3650),
    shutdownWaitMs: intEnv(env, 'INBOX_SHUTDOWN_WAIT_MS', 5_000, 0, 10 * 60_000),
  };
}
