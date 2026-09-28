import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { applyMigration, markerPath } from './migration';

/**
 * Automatic JSON -> PostgreSQL move of a CLIENT inbox, performed by the new process at startup.
 *
 * Why a handshake: Dokploy deploys with Swarm `start-first`, so for a few seconds the OLD process (JSON inbox) and the NEW one
 * (PostgreSQL inbox) run side by side on the same data volume. Importing the file while the old process can still write it would
 * create two writers. The two processes coordinate through small files next to the inbox file:
 *
 *   <file>.alive            the JSON process's heartbeat (instance id + time), rewritten every second
 *   <file>.migrate-request  written by the PostgreSQL process: "stop writing, I am taking over"
 *   <file>.migrate-ack      written by the JSON process once it refuses new work, has finished what it had in flight,
 *                           and will never write the file again
 *
 * If no JSON process is alive (plain restart, no overlap) there is nobody to answer: the import proceeds, and applyMigration's own
 * "file must be quiet" check is the last guard. Nothing is ever deleted: applyMigration backs up and renames the source.
 */

export const aliveFile = (file: string): string => `${file}.alive`;
export const requestFile = (file: string): string => `${file}.migrate-request`;
export const ackFile = (file: string): string => `${file}.migrate-ack`;

const ALIVE_EVERY_MS = 1_000;
const ALIVE_FRESH_MS = 5_000;

function writeAtomic(file: string, content: string): void {
  const temp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

// ------------------------------------------------------------------------------------------------ JSON (old) process side

export interface HandoffTarget {
  /** Stop accepting new receipts and claims. Resolves once everything already claimed has been recorded. */
  freeze(): Promise<void>;
  /** After this, the store never writes the file again, for any reason. */
  seal(): void;
}

/**
 * Runs in a process whose client inbox is on JSON. Publishes a heartbeat and answers a takeover request.
 * A leftover request from an earlier, abandoned attempt is cleared at startup: a process that STARTS on JSON is the decision to stay
 * on JSON, and must not freeze itself on a stale file.
 */
export function startJsonHandoffWatcher(file: string, target: HandoffTarget): { stop(): void } {
  const instance = crypto.randomBytes(8).toString('hex');
  for (const stale of [requestFile(file), ackFile(file)]) { try { fs.unlinkSync(stale); } catch { /* not there */ } }
  let answering = false;
  let stopped = false;
  let lastBeat = 0;
  const beat = (): void => {
    if (stopped || Date.now() - lastBeat < ALIVE_EVERY_MS) return;
    lastBeat = Date.now();
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeAtomic(aliveFile(file), JSON.stringify({ instance, at: Date.now() })); }
    catch (err) { console.warn('[INBOX_HANDOFF_ALIVE_FAILED]', err instanceof Error ? err.message : err); }
  };
  const check = (): void => {
    if (stopped || answering || !fs.existsSync(requestFile(file))) return;
    answering = true;
    console.warn('[INBOX_HANDOFF_REQUESTED] a PostgreSQL process is taking over this client inbox; refusing new work and finishing in-flight items');
    void (async () => {
      await target.freeze();
      target.seal();
      stopped = true;
      clearInterval(timer);
      try { fs.unlinkSync(aliveFile(file)); } catch { /* best effort */ }
      writeAtomic(ackFile(file), JSON.stringify({ instance, at: Date.now() }));
      console.warn('[INBOX_HANDOFF_ACKNOWLEDGED] this process will not write the JSON inbox again');
    })().catch((err) => { answering = false; console.error('[INBOX_HANDOFF_FAILED]', err); });
  };
  beat();
  const timer = setInterval(() => { beat(); check(); }, Math.min(ALIVE_EVERY_MS, 500));
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}

// ------------------------------------------------------------------------------------------------ PostgreSQL (new) process side

export function needsAutoMigration(file: string): boolean {
  return fs.existsSync(file) && !fs.existsSync(markerPath(file));
}

export interface AutoMigrationOptions {
  role: 'client';
  namespace: string;
  /** How long to wait for a live JSON process to acknowledge before giving up this attempt (the caller retries). */
  ackTimeoutMs?: number;
  quietMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runAutoMigration(pool: Pool, file: string, o: AutoMigrationOptions): Promise<Record<string, unknown>> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  writeAtomic(requestFile(file), JSON.stringify({ at: Date.now(), pid: process.pid }));
  const alive = readJson(aliveFile(file));
  const oldIsAlive = Boolean(alive && Date.now() - Number(alive.at) < ALIVE_FRESH_MS);
  if (oldIsAlive) {
    const deadline = Date.now() + (o.ackTimeoutMs ?? 90_000);
    while (!fs.existsSync(ackFile(file))) {
      // The old process can also disappear without answering (Swarm stopped it). A heartbeat that goes stale means nobody is left.
      const beat = readJson(aliveFile(file));
      if (!beat || Date.now() - Number(beat.at) >= ALIVE_FRESH_MS) break;
      if (Date.now() > deadline) throw new Error('the JSON inbox process did not hand over in time; will retry (it keeps refusing new work meanwhile)');
      await sleep(250);
    }
  }
  const result = await applyMigration(pool, {
    role: o.role,
    namespace: o.namespace,
    sourceFile: file,
    backupDir: path.join(path.dirname(file), 'inbox-migration-backups'),
    confirmStopped: true,
    quietMs: o.quietMs ?? 2_000,
  });
  for (const f of [requestFile(file), ackFile(file), aliveFile(file)]) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
  return result;
}
