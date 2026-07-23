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

  constructor(private readonly filePath: string, private readonly processingStaleMs = 2 * 60 * 1000) {
    this.data = this.load();
  }

  enqueue(id: string, payload: unknown, now = new Date()): MetaGatewayInboxItem {
    const existing = this.data.items.find((item) => item.id === id);
    if (existing) return { ...existing };
    const timestamp = now.toISOString();
    const item: MetaGatewayInboxItem = { id, payload, status: 'queued', attempts: 0, createdAt: timestamp, updatedAt: timestamp };
    this.data.items.push(item);
    this.persist();
    return { ...item };
  }

  claimNext(now = new Date()): MetaGatewayInboxItem | null {
    const nowMs = now.getTime();
    const item = this.data.items.filter((candidate) => this.isClaimable(candidate, nowMs)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!item) return null;
    item.status = 'processing';
    item.attempts += 1;
    item.processingStartedAt = now.toISOString();
    item.updatedAt = item.processingStartedAt;
    item.nextAttemptAt = undefined;
    item.lastError = undefined;
    this.persist();
    return { ...item };
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
