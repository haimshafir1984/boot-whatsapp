import fs from 'fs';
import path from 'path';

// 'held' (R1): the sender was already blocked (needs_review) when this item
// was claimed. Distinct from 'failed' - it is not an error to give up on,
// and distinct from 'completed' - the item was never actually processed. It
// is never auto-claimed again (see isClaimable below); only an explicit
// admin action via resolveHeldForSender() moves it to 'queued' (requeue) or
// 'failed' (discard).
export type MetaGatewayInboxStatus = 'queued' | 'processing' | 'retry' | 'completed' | 'failed' | 'held';

export interface MetaGatewayInboxItem {
  id: string;
  payload: unknown;
  status: MetaGatewayInboxStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  processingStartedAt?: string;
  lastError?: string;
}

interface MetaGatewayInboxFile {
  version: 1;
  items: MetaGatewayInboxItem[];
}

export class MetaGatewayInbox {
  private data: MetaGatewayInboxFile;
  // persist() rewrites the ENTIRE file synchronously (writeFileSync +
  // copyFileSync + renameSync) on every single enqueue/claimBatch/update call.
  // That cost scales with how much completed-item history is retained, and
  // during a message burst it runs many times in quick succession - measured
  // at ~85% less blocking time (5,000 -> 300 items) for the same burst size,
  // see scripts/measure-inbox-retention-cost.js. Lower retention only drops
  // already-completed items (active/processing/retry items are never pruned),
  // and duplicate-webhook protection has a second, independent layer
  // (messageFlow.ts's rememberMessage()), so this does not weaken correctness.
  private static readonly COMPLETED_RETENTION_MS = 2 * 60 * 60 * 1000;
  private static readonly MAX_COMPLETED_ITEMS = 300;

  constructor(private readonly filePath: string, private readonly processingStaleMs = 2 * 60 * 1000) {
    this.data = this.load();
  }

  enqueue(id: string, payload: unknown, now = new Date()): MetaGatewayInboxItem {
    const existing = this.data.items.find((item) => item.id === id);
    if (existing) return { ...existing };
    // Build the full candidate state (pruned + new item) and only publish it
    // to `this.data` after persist() actually succeeds (finding 03). Never
    // mutate this.data.items directly here - a mid-way failure must leave the
    // in-memory state byte-for-byte what it was, INCLUDING whatever
    // pruneCompleted would have removed, so a retry with the same id (Meta
    // re-sends after our 503) genuinely re-attempts the write instead of
    // silently matching a half-applied `existing`.
    const prunedItems = this.pruneCompletedItems(this.data.items, now);
    const timestamp = now.toISOString();
    const item: MetaGatewayInboxItem = { id, payload, status: 'queued', attempts: 0, createdAt: timestamp, updatedAt: timestamp };
    this.persistData({ version: 1, items: [...prunedItems, item] });
    return { ...item };
  }

  claimNext(now = new Date()): MetaGatewayInboxItem | null {
    return this.claimBatch(1, undefined, now)[0] ?? null;
  }

  claimBatch(
    limit: number,
    groupKey?: (item: MetaGatewayInboxItem) => string,
    now = new Date(),
  ): MetaGatewayInboxItem[] {
    const ordered = this.data.items.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let candidates = ordered;
    if (groupKey) {
      const firstOutstandingByGroup = new Map<string, MetaGatewayInboxItem>();
      for (const item of ordered) {
        if (item.status === 'completed' || item.status === 'failed') continue;
        const key = groupKey(item);
        if (!firstOutstandingByGroup.has(key)) firstOutstandingByGroup.set(key, item);
      }
      candidates = [...firstOutstandingByGroup.values()];
    }
    const selected = candidates
      .filter((candidate) => this.isClaimable(candidate, now.getTime()))
      .slice(0, Math.max(0, limit));
    if (!selected.length) return [];
    const selectedIds = new Set(selected.map((item) => item.id));
    const timestamp = now.toISOString();
    // Same commit-then-publish contract as enqueue: build the full candidate
    // items array, persist it, and only then let it become `this.data`. A
    // persist failure here must not leave items marked 'processing' in
    // memory while durable storage still shows them 'queued'/'retry' -
    // combined with the enqueue dedup guard, that would let a duplicate
    // claim silently report a false "already being handled".
    const nextItems = this.data.items.map((item) => (
      selectedIds.has(item.id)
        ? { ...item, status: 'processing' as const, attempts: item.attempts + 1, processingStartedAt: timestamp, updatedAt: timestamp, nextAttemptAt: undefined, lastError: undefined }
        : item
    ));
    this.persistData({ version: 1, items: nextItems });
    return nextItems.filter((item) => selectedIds.has(item.id)).map((item) => ({ ...item }));
  }

  markCompleted(id: string, now = new Date()): void {
    this.update(id, { status: 'completed', processingStartedAt: undefined, nextAttemptAt: undefined, lastError: undefined, updatedAt: now.toISOString() });
  }

  markRetry(id: string, error: unknown, nextAttemptAt: Date, now = new Date()): void {
    this.update(id, { status: 'retry', processingStartedAt: undefined, nextAttemptAt: nextAttemptAt.toISOString(), lastError: error instanceof Error ? error.message : String(error), updatedAt: now.toISOString() });
  }

  markFailed(id: string, error: unknown, now = new Date()): void {
    this.update(id, { status: 'failed', processingStartedAt: undefined, nextAttemptAt: undefined, lastError: error instanceof Error ? error.message : String(error), updatedAt: now.toISOString() });
  }

  /**
   * R1: the sender was already blocked (needs_review) when this item was
   * claimed. Marks it 'held' - not completed (the reply was never actually
   * processed), not failed (not an error to give up retrying), and no
   * attempts are burned since it is simply never offered to claimBatch again
   * until an admin explicitly resolves it via resolveHeldForSender().
   */
  markHeld(id: string, reason: unknown, now = new Date()): void {
    this.update(id, { status: 'held', processingStartedAt: undefined, nextAttemptAt: undefined, lastError: reason instanceof Error ? reason.message : String(reason), updatedAt: now.toISOString() });
  }

  /** Every item currently held for a given sender key (metaPayloadSenderKey), oldest first. */
  listHeldForSender(senderKey: string, senderKeyOf: (item: MetaGatewayInboxItem) => string): MetaGatewayInboxItem[] {
    return this.data.items
      .filter((item) => item.status === 'held' && senderKeyOf(item) === senderKey)
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => ({ ...item }));
  }

  /**
   * Explicit, admin-chosen resolution for every 'held' item belonging to a
   * sender (R1, point 5): 'requeue' resets them to 'queued' with a fresh
   * attempts budget so the drainer picks them up again; 'discard' moves them
   * to 'failed' with an annotated reason so they are never lost, never
   * silently retried, and remain visible for audit. There is deliberately no
   * automatic default - the caller (the resolve endpoint) must choose.
   */
  resolveHeldForSender(senderKey: string, senderKeyOf: (item: MetaGatewayInboxItem) => string, action: 'requeue' | 'discard', now = new Date()): number {
    const timestamp = now.toISOString();
    let touched = 0;
    const nextItems = this.data.items.map((item) => {
      if (item.status !== 'held' || senderKeyOf(item) !== senderKey) return item;
      touched += 1;
      return action === 'requeue'
        ? { ...item, status: 'queued' as const, attempts: 0, nextAttemptAt: undefined, lastError: undefined, updatedAt: timestamp }
        : { ...item, status: 'failed' as const, nextAttemptAt: undefined, lastError: `[ADMIN_DISCARDED] ${item.lastError || ''}`.trim(), updatedAt: timestamp };
    });
    if (touched) this.persistData({ version: 1, items: nextItems });
    return touched;
  }

  counts(): Record<MetaGatewayInboxStatus, number> {
    const counts: Record<MetaGatewayInboxStatus, number> = { queued: 0, processing: 0, retry: 0, completed: 0, failed: 0, held: 0 };
    for (const item of this.data.items) counts[item.status] += 1;
    return counts;
  }

  private isClaimable(item: MetaGatewayInboxItem, nowMs: number): boolean {
    if (item.status === 'queued') return true;
    if (item.status === 'retry') return !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= nowMs;
    if (item.status !== 'processing') return false;
    const startedAt = Date.parse(item.processingStartedAt || item.updatedAt);
    return !Number.isFinite(startedAt) || startedAt <= nowMs - this.processingStaleMs;
  }

  private update(id: string, patch: Partial<MetaGatewayInboxItem>): void {
    const item = this.data.items.find((candidate) => candidate.id === id);
    if (!item) return;
    // markCompleted/markRetry/markFailed all funnel through here. Same
    // commit-then-publish contract: build the candidate, persist it, publish
    // only on success - a failed markCompleted() must not leave the item
    // 'completed' in memory while the durable copy still shows it in-flight,
    // which combined with claimBatch's groupKey skip-if-completed logic
    // (metaGatewayInbox.ts's isClaimable path) would falsely look "done".
    const nextItems = this.data.items.map((candidate) => (
      candidate.id === id ? { ...candidate, ...patch } : candidate
    ));
    this.persistData({ version: 1, items: nextItems });
  }

  private pruneCompletedItems(items: MetaGatewayInboxItem[], now: Date): MetaGatewayInboxItem[] {
    const cutoff = now.getTime() - MetaGatewayInbox.COMPLETED_RETENTION_MS;
    const active = items.filter((item) => item.status !== 'completed');
    const completed = items
      .filter((item) => item.status === 'completed' && Date.parse(item.updatedAt) >= cutoff)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MetaGatewayInbox.MAX_COMPLETED_ITEMS);
    return [...active, ...completed];
  }

  private load(): MetaGatewayInboxFile {
    if (!fs.existsSync(this.filePath)) return { version: 1, items: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<MetaGatewayInboxFile>;
      return { version: 1, items: Array.isArray(parsed.items) ? parsed.items : [] };
    } catch (error) {
      const backupPath = `${this.filePath}.bak`;
      if (fs.existsSync(backupPath)) {
        const parsed = JSON.parse(fs.readFileSync(backupPath, 'utf8')) as Partial<MetaGatewayInboxFile>;
        return { version: 1, items: Array.isArray(parsed.items) ? parsed.items : [] };
      }
      throw new Error(`Meta gateway inbox is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Writes `next` durably (temp write -> backup copy -> atomic rename) and
   * only THEN assigns it to `this.data`. Every mutating method (enqueue,
   * claimBatch, update) builds its candidate state and calls this instead of
   * mutating `this.data` directly - so a throw here leaves `this.data`
   * exactly as it was before the call, at every one of the three write
   * stages (temp write, backup copy, rename).
   */
  private persistData(next: MetaGatewayInboxFile): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const backupPath = `${this.filePath}.bak`;
    fs.writeFileSync(tempPath, JSON.stringify(next), 'utf8');
    if (fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, backupPath);
    fs.renameSync(tempPath, this.filePath);
    this.data = next;
  }
}
