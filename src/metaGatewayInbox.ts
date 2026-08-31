import fs from 'fs';
import path from 'path';

export type MetaGatewayInboxStatus = 'queued' | 'processing' | 'retry' | 'completed' | 'failed';

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
    this.pruneCompleted(now);
    const timestamp = now.toISOString();
    const item: MetaGatewayInboxItem = { id, payload, status: 'queued', attempts: 0, createdAt: timestamp, updatedAt: timestamp };
    this.data.items.push(item);
    this.persist();
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
    const timestamp = now.toISOString();
    for (const item of selected) {
      item.status = 'processing';
      item.attempts += 1;
      item.processingStartedAt = timestamp;
      item.updatedAt = timestamp;
      item.nextAttemptAt = undefined;
      item.lastError = undefined;
    }
    this.persist();
    return selected.map((item) => ({ ...item }));
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

  counts(): Record<MetaGatewayInboxStatus, number> {
    const counts: Record<MetaGatewayInboxStatus, number> = { queued: 0, processing: 0, retry: 0, completed: 0, failed: 0 };
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
    Object.assign(item, patch);
    this.persist();
  }

  private pruneCompleted(now: Date): void {
    const cutoff = now.getTime() - MetaGatewayInbox.COMPLETED_RETENTION_MS;
    const active = this.data.items.filter((item) => item.status !== 'completed');
    const completed = this.data.items
      .filter((item) => item.status === 'completed' && Date.parse(item.updatedAt) >= cutoff)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MetaGatewayInbox.MAX_COMPLETED_ITEMS);
    this.data.items = [...active, ...completed];
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

  private persist(): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const backupPath = `${this.filePath}.bak`;
    fs.writeFileSync(tempPath, JSON.stringify(this.data), 'utf8');
    if (fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, backupPath);
    fs.renameSync(tempPath, this.filePath);
  }
}
