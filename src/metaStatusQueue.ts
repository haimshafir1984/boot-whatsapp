import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

/**
 * Durable queue for forwarding Meta delivery-status webhooks from the gateway to the clients
 * (stage B2, step 2).
 *
 * Why it exists: statuses used to be forwarded fire-and-forget on the argument that "a missed one is
 * corrected by the next". That stops being true once releasing an `uncertain` message depends on a
 * SPECIFIC status (the one carrying our attempt id): a lost status is not superseded and the message
 * would stay stuck. So a status is persisted BEFORE the webhook is acknowledged and is delivered to
 * every target client with retry until the client acknowledges it (or it ages out).
 *
 * Scope: reliability of the forwarding path only. Which clients receive a status is unchanged
 * (broadcast to every managed Meta client, each ignores what it does not own); routing authority is
 * not touched here.
 *
 * Storage: append-only JSON-lines journal (one write per webhook request, not a rewrite of the whole
 * file). A torn LAST line (crash mid-append) is discarded; a corrupt line anywhere else throws - a
 * damaged journal is never loaded as "empty".
 */
export interface StatusQueueItem {
  id: string;            // `${dedupeKey}|${clientId}`
  clientId: string;
  payload: unknown;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}

interface JournalRecord { t: 'add' | 'done' | 'drop'; id: string; clientId?: string; payload?: unknown; at: number; reason?: string }

export interface StatusQueueOptions {
  /** A status older than this is dropped (and counted) - a client that has been down this long has lost its callback window. */
  maxAgeMs?: number;
  /** How long a completed id is remembered, so a webhook re-sent by Meta is not delivered twice. */
  doneRetentionMs?: number;
  now?: () => number;
}

/** Stable identity of a status webhook payload, so Meta's re-sends dedupe. */
export function statusDedupeKey(payload: any): string {
  const statuses: any[] = payload?.entry?.[0]?.changes?.[0]?.value?.statuses ?? [];
  const parts = statuses.map((s) => [s?.id, s?.status, s?.timestamp, s?.recipient_id, s?.biz_opaque_callback_data ?? ''].join('|')).sort();
  return createHash('sha1').update(parts.join('\n')).digest('hex');
}

export class MetaStatusQueue {
  private readonly pending = new Map<string, StatusQueueItem>();
  private readonly recentDone = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private journalLines = 0;
  private readonly maxAgeMs: number;
  private readonly doneRetentionMs: number;
  private readonly now: () => number;
  readonly counters = { enqueued: 0, duplicates: 0, delivered: 0, expired: 0, dropped: 0 };

  constructor(private readonly filePath: string, options: StatusQueueOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? 6 * 60 * 60 * 1000;
    this.doneRetentionMs = options.doneRetentionMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.replay();
  }

  private replay(): void {
    if (!fs.existsSync(this.filePath)) return;
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const lines = raw.split('\n');
    const endsClean = raw.endsWith('\n') || raw.length === 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const isTornTail = !endsClean && i === lines.length - 1;   // no trailing newline = the append did not finish
      let record: JournalRecord;
      try { record = JSON.parse(line) as JournalRecord; } catch (err) {
        if (isTornTail) { this.truncateTornTail(raw, line); break; }
        throw new Error(`Status journal ${this.filePath} is corrupt at line ${i + 1}; refusing to load it as empty: ${(err as Error).message}`);
      }
      this.journalLines++;
      if (record.t === 'add' && record.clientId !== undefined) {
        this.pending.set(record.id, { id: record.id, clientId: record.clientId, payload: record.payload, createdAt: record.at, attempts: 0, nextAttemptAt: 0 });
      } else if (record.t === 'done' || record.t === 'drop') {
        this.pending.delete(record.id);
        if (record.t === 'done') this.recentDone.set(record.id, record.at);
      }
    }
    this.pruneDone();
  }

  private truncateTornTail(raw: string, tornLine: string): void {
    fs.writeFileSync(this.filePath, raw.slice(0, raw.length - tornLine.length));
  }

  private append(records: JournalRecord[]): void {
    if (!records.length) return;
    fs.appendFileSync(this.filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    this.journalLines += records.length;
  }

  private pruneDone(): void {
    const cutoff = this.now() - this.doneRetentionMs;
    for (const [id, at] of this.recentDone) if (at < cutoff) this.recentDone.delete(id);
  }

  /**
   * Persist one entry per (status webhook, client) BEFORE returning. Throws - and changes nothing in
   * memory - if the journal cannot be written, so the caller can refuse to acknowledge the webhook.
   * Already known ids (queued or recently completed) are skipped: Meta re-sends are harmless.
   */
  enqueue(dedupeKey: string, payload: unknown, clientIds: string[]): { added: number; duplicates: number } {
    const at = this.now();
    const fresh: JournalRecord[] = [];
    let duplicates = 0;
    for (const clientId of clientIds) {
      const id = `${dedupeKey}|${clientId}`;
      if (this.pending.has(id) || this.recentDone.has(id)) { duplicates++; continue; }
      fresh.push({ t: 'add', id, clientId, payload, at });
    }
    this.append(fresh);   // throws before any in-memory change
    for (const r of fresh) this.pending.set(r.id, { id: r.id, clientId: r.clientId!, payload: r.payload, createdAt: r.at, attempts: 0, nextAttemptAt: 0 });
    this.counters.enqueued += fresh.length;
    this.counters.duplicates += duplicates;
    return { added: fresh.length, duplicates };
  }

  /**
   * Entries that are due and not currently being delivered, oldest first. Marks nothing.
   *
   * Scans in Map insertion order rather than sorting a copy: entries are inserted by enqueue() in
   * `createdAt` order and are never re-inserted (fail() mutates in place), and both replay() and
   * maybeCompact() rebuild the map in that same order - so insertion order already IS createdAt
   * order. The previous full sort ran on every call, and the drain loop calls this repeatedly until
   * the queue empties, which made draining a large backlog quadratic.
   */
  due(limit: number): StatusQueueItem[] {
    const now = this.now();
    const out: StatusQueueItem[] = [];
    for (const item of this.pending.values()) {
      if (out.length >= limit) break;
      if (this.inFlight.has(item.id) || item.nextAttemptAt > now) continue;
      out.push(item);
    }
    return out;
  }

  begin(id: string): void { this.inFlight.add(id); }

  /** The client acknowledged it (2xx): remember the id (dedupe) and journal the completion. */
  complete(id: string): void {
    this.inFlight.delete(id);
    if (!this.pending.delete(id)) return;
    const at = this.now();
    this.recentDone.set(id, at);
    this.counters.delivered++;
    try { this.append([{ t: 'done', id, at }]); } catch { /* worst case the entry is delivered again after a restart; delivery is idempotent */ }
    this.maybeCompact();
  }

  /**
   * complete() for several ids at once, with ONE journal append instead of one per id.
   *
   * Identical semantics to calling complete() in a loop - an id that is not pending is skipped, the
   * rest are remembered for dedupe - but the synchronous write is paid once. A status delivery costs
   * one appendFileSync today (~0.2ms measured), and a burst run does ~320k of them, so this is the
   * difference between the write being a third of the gateway's time and being noise. Only call it
   * once the client has acknowledged ALL of these ids: a lost 'done' record is safe (the entry is
   * delivered again after a restart, and delivery is idempotent), but a premature one is not.
   */
  completeMany(ids: string[]): void {
    const at = this.now();
    const records: JournalRecord[] = [];
    for (const id of ids) {
      this.inFlight.delete(id);
      if (!this.pending.delete(id)) continue;
      this.recentDone.set(id, at);
      this.counters.delivered++;
      records.push({ t: 'done', id, at });
    }
    if (!records.length) return;
    try { this.append(records); } catch { /* see complete() */ }
    this.maybeCompact();
  }

  /** Delivery failed: keep it, retry with capped exponential backoff. */
  fail(id: string): number {
    this.inFlight.delete(id);
    const item = this.pending.get(id);
    if (!item) return 0;
    item.attempts += 1;
    const delay = Math.min(500 * 2 ** (item.attempts - 1), 30_000);
    item.nextAttemptAt = this.now() + delay;
    return delay;
  }

  /** No target any more (client removed/disabled): drop with a reason. */
  drop(id: string, reason: string): void {
    this.inFlight.delete(id);
    if (!this.pending.delete(id)) return;
    this.counters.dropped++;
    try { this.append([{ t: 'drop', id, at: this.now(), reason }]); } catch { /* see complete() */ }
  }

  /** Drop entries older than maxAgeMs. Returns them so the caller can alert. */
  expire(): StatusQueueItem[] {
    const cutoff = this.now() - this.maxAgeMs;
    const expired: StatusQueueItem[] = [];
    for (const item of this.pending.values()) if (item.createdAt < cutoff && !this.inFlight.has(item.id)) expired.push(item);
    for (const item of expired) {
      this.pending.delete(item.id);
      this.counters.expired++;
      try { this.append([{ t: 'drop', id: item.id, at: this.now(), reason: 'expired' }]); } catch { /* see complete() */ }
    }
    this.pruneDone();
    return expired;
  }

  stats(): { pending: number; inFlight: number; oldestAgeMs: number; journalLines: number } {
    let oldest = 0;
    const now = this.now();
    for (const item of this.pending.values()) oldest = Math.max(oldest, now - item.createdAt);
    return { pending: this.pending.size, inFlight: this.inFlight.size, oldestAgeMs: oldest, journalLines: this.journalLines };
  }

  /**
   * Rewrites the journal with only what is still pending (+ recent done ids) once it has grown.
   *
   * The trigger is measured against everything a rewrite WRITES - pending AND recentDone - not
   * against `pending` alone. Comparing only against pending.size let the journal a compaction had
   * just produced sit above its own trigger whenever recentDone outgrew pending (the normal steady
   * state, since a done id is kept for doneRetentionMs), so every later complete() rewrote the whole
   * journal again: a 23k-delivery drain cost 907 full rewrites and 2.2GB of synchronous writes, which
   * is what blocked the gateway's event loop. Requiring the journal to be twice what a rewrite would
   * produce keeps compaction amortised - each one is paid for by at least that many appends since
   * the last.
   */
  private maybeCompact(): void {
    const afterCompaction = this.pending.size + this.recentDone.size;
    if (this.journalLines < 5000 || this.journalLines < afterCompaction * 2) return;
    this.pruneDone();   // only now: this walks recentDone, and maybeCompact() runs on every complete()
    const records: JournalRecord[] = [
      ...[...this.pending.values()].map((item) => ({ t: 'add' as const, id: item.id, clientId: item.clientId, payload: item.payload, at: item.createdAt })),
      ...[...this.recentDone.entries()].map(([id, at]) => ({ t: 'done' as const, id, at })),
    ];
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
      fs.renameSync(tmp, this.filePath);
      this.journalLines = records.length;
    } catch { /* keep the old journal; compaction is an optimisation */ }
  }
}
