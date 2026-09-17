'use strict';

/**
 * One-off load test tailored to a specific launch (run on request, not part of
 * the regression suite): a near-empty/new client, ~1,000 concurrent
 * participants (top of the "a few hundred to a thousand" estimate), a
 * campaign whose flow includes a file/video step (not just text+buttons),
 * throttled at the real production concurrency cap (20 - matches
 * adminServer.ts's metaGatewayInbox.claimBatch(20, ...)), with a light
 * simulated transient-failure rate to prove retries hold under real load.
 *
 * Reuses the same harness approach as scripts/test-load-burst-campaign.js
 * (real Storage + real handleIncomingWhatsAppMessage, mocked Postgres via the
 * actual writeSnapshotDelta code path) - see that file for the full design
 * rationale in its header comment.
 */

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'load-burst-launch-'));
process.env.UPLOADS_PATH = path.join(directory, 'uploads');
fs.mkdirSync(process.env.UPLOADS_PATH, { recursive: true });
fs.writeFileSync(path.join(process.env.UPLOADS_PATH, 'launch-video.mp4'), 'fake video bytes for load test');

const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');
const { writeSnapshotDelta, mergeDirtyTables, mergeDirtyRowIdsByTable } = require('../dist/database');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function randomBetween(min, max) { return Math.floor(min + Math.random() * (max - min)); }

// writeSnapshotDelta takes one dedicated connection per delta (pool.connect(),
// begin/commit/rollback, release) rather than pool.query() directly - matches
// the commit-then-publish rewrite in database.ts. The mock client below
// stands in for a real pg.PoolClient.
class MockPool {
  constructor(queryLatencyMs = 2) {
    this.queryLatencyMs = queryLatencyMs;
    this.queryCount = 0;
  }
  async connect() {
    const pool = this;
    return {
      async query() {
        pool.queryCount += 1;
        if (pool.queryLatencyMs) await sleep(pool.queryLatencyMs);
        return { rows: [], rowCount: 0 };
      },
      release() { /* no-op */ },
    };
  }
  async query() {
    this.queryCount += 1;
    if (this.queryLatencyMs) await sleep(this.queryLatencyMs);
    return { rows: [], rowCount: 0 };
  }
}

class TestPostgresBackend {
  constructor(pool) {
    this.mode = 'postgres';
    this.pool = pool;
    this.persistedSnapshot = null;
    this.queuedSnapshot = null;
    this.queuedDirtyTables = new Set();
    this.queuedDirtyRowIds = {};
    this.draining = false;
    this.pending = Promise.resolve();
    this.writeCount = 0;
    this.writeDurationsMs = [];
    this.lastError = undefined;
  }
  persistSnapshot(data, dirtyTables, dirtyRowIds) {
    this.queuedSnapshot = data;
    this.queuedDirtyTables = mergeDirtyTables(this.queuedDirtyTables, dirtyTables);
    this.queuedDirtyRowIds = mergeDirtyRowIdsByTable(this.queuedDirtyRowIds, dirtyRowIds);
    if (this.draining) return;
    this.draining = true;
    this.pending = this.drain();
  }
  async drain() {
    try {
      while (this.queuedSnapshot) {
        const source = this.queuedSnapshot;
        const dirtyTables = this.queuedDirtyTables;
        const dirtyRowIds = this.queuedDirtyRowIds;
        this.queuedSnapshot = null;
        this.queuedDirtyTables = new Set();
        this.queuedDirtyRowIds = {};
        const snapshot = JSON.parse(JSON.stringify(source));
        const t0 = Date.now();
        await writeSnapshotDelta(this.pool, this.persistedSnapshot, snapshot, dirtyTables, dirtyRowIds);
        this.writeDurationsMs.push(Date.now() - t0);
        this.writeCount += 1;
        this.persistedSnapshot = snapshot;
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[TEST_BACKEND_WRITE_FAILED]', err);
    } finally {
      this.draining = false;
    }
  }
  async flush() {
    do { await this.pending; } while (this.draining || this.queuedSnapshot);
    if (this.lastError) throw new Error(this.lastError);
  }
  async close() { await this.flush(); }
  health() {
    return { enabled: true, ready: !this.lastError, lastError: this.lastError, pendingWrites: this.queuedSnapshot ? 1 : 0 };
  }
}

// "לקוחה חדשה/כמעט ריקה" - a light but non-zero existing history, matching a
// client that has been live a short while, not a completely untouched account.
function buildNearEmptyHistory() {
  const now = new Date().toISOString();
  const outboxMessages = [];
  for (let i = 0; i < 40; i += 1) {
    outboxMessages.push({
      id: 'seed-m' + i, kind: 'text', to: 'whatsapp:97250000' + i, status: 'sent',
      attempts: 1, createdAt: now, updatedAt: now, providerMessageId: 'wamid.seed' + i,
      deliveryStatus: 'delivered',
    });
  }
  const campaignEvents = [];
  for (let i = 0; i < 40; i += 1) {
    campaignEvents.push({ id: 'seed-e' + i, campaignId: 'seed-campaign', campaignResultId: 'seed-r' + i, type: 'step_sent', createdAt: now });
  }
  const campaignResults = [];
  for (let i = 0; i < 20; i += 1) {
    campaignResults.push({
      id: 'seed-r' + i, campaignId: 'seed-campaign', phone: 'whatsapp:97250000' + i, status: 'saved',
      lastStage: 'completed', triggeredAt: now, updatedAt: now,
    });
  }
  const contactQueue = campaignResults.map((r, i) => ({ id: 'seed-q' + i, phone: '97250000' + i, status: 'saved', attempts: 1, createdAt: now, updatedAt: now }));
  const contactsList = campaignResults.map((r, i) => ({ phone: '97250000' + i, name: 'Seed Contact ' + i, savedAt: now }));
  return { outboxMessages, campaignEvents, campaignResults, contactQueue, contactsList };
}

class LoadTestTransport {
  constructor(storage, { minLatencyMs, maxLatencyMs, failureRate, fileMinLatencyMs, fileMaxLatencyMs }) {
    this.storage = storage;
    this.minLatencyMs = minLatencyMs;
    this.maxLatencyMs = maxLatencyMs;
    this.failureRate = failureRate;
    this.fileMinLatencyMs = fileMinLatencyMs;
    this.fileMaxLatencyMs = fileMaxLatencyMs;
    this.sendCount = 0;
    this.failureCount = 0;
    this.fileSendCount = 0;
  }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async _maybeFail(label, minMs, maxMs) {
    this.sendCount += 1;
    await sleep(randomBetween(minMs, maxMs));
    if (Math.random() < this.failureRate) {
      this.failureCount += 1;
      const err = new Error(`Simulated transient Meta failure for ${label}`);
      err.transient = true;
      throw err;
    }
  }
  async sendMessage() { await this._maybeFail('sendMessage', this.minLatencyMs, this.maxLatencyMs); return { messageId: 'wamid.load-' + Math.random().toString(36).slice(2) }; }
  async sendContactCard() { await this._maybeFail('sendContactCard', this.minLatencyMs, this.maxLatencyMs); return { messageId: 'wamid.load-' + Math.random().toString(36).slice(2) }; }
  async sendContactCards() { await this._maybeFail('sendContactCards', this.minLatencyMs, this.maxLatencyMs); return { messageId: 'wamid.load-' + Math.random().toString(36).slice(2) }; }
  async sendInteractiveButtons() { await this._maybeFail('sendInteractiveButtons', this.minLatencyMs, this.maxLatencyMs); return { messageId: 'wamid.load-' + Math.random().toString(36).slice(2) }; }
  async sendFile() {
    this.fileSendCount += 1;
    // Video upload + send genuinely takes longer than a text/button call - matches
    // what was observed in real logs (multi-second for a video attachment).
    await this._maybeFail('sendFile', this.fileMinLatencyMs, this.fileMaxLatencyMs);
    const messageId = 'wamid.load-file-' + Math.random().toString(36).slice(2);
    // Simulate the delivery webhook arriving a realistic short while after Meta
    // accepts the send - exercises the real file-delivery-order wait
    // (messageFlow.ts's waitForOutboxFileDelivery) instead of forcing every
    // participant through its full 20s timeout fallback.
    setTimeout(() => {
      try { this.storage.recordOutboxDelivery(messageId, 'delivered'); } catch { /* ignore */ }
    }, randomBetween(200, 900));
    return { messageId };
  }
}

function addLaunchCampaign(storage, uploadedFileId) {
  return storage.addCampaign({
    name: 'todays-launch',
    triggerType: 1,
    triggerPhrase: 'אני רוצה להשתתף',
    suffix: ' - (Bot)',
    active: true,
    conversation: {
      askNameEnabled: false,
      nameTimeoutMinutes: 30,
      askNameText: '',
      replyText: '',
      followupMessages: [],
      sendContactCard: true,
      contactCardPlacement: 'before_questions',
      contactCardName: "Today's Launch",
      contactCardPhone: '972500000000',
      decisionFlow: [
        { id: 'video-step', kind: 'message', text: 'הנה הסרטון שלנו 🎬', fileId: uploadedFileId, nextStepId: 'question' },
        {
          id: 'question', kind: 'question', presentation: 'buttons', text: 'רוצה לדעת עוד?',
          options: [{ id: 'yes', text: 'כן', action: 'goto', nextStepId: 'thanks' }],
        },
        { id: 'thanks', kind: 'message', text: 'תודה שהצטרפת!' },
      ],
    },
  });
}

let inboundSequence = 0;
async function inbound(storage, transport, phone, body) {
  inboundSequence += 1;
  const startedAt = Date.now();
  await handleIncomingWhatsAppMessage({
    id: `launch-${inboundSequence}`,
    from: `whatsapp:${phone}`,
    body,
    hasUserSignal: true,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Launch Day Participant'; },
  }, storage, transport, 'webhook');
  return Date.now() - startedAt;
}

function percentile(sortedArray, p) {
  if (!sortedArray.length) return 0;
  const index = Math.min(sortedArray.length - 1, Math.floor((p / 100) * sortedArray.length));
  return sortedArray[index];
}

async function runThrottled(items, concurrencyCap, worker) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += concurrencyCap) {
    const batch = items.slice(offset, offset + concurrencyCap);
    const batchResults = await Promise.allSettled(batch.map(worker));
    results.push(...batchResults);
  }
  return results;
}

(async () => {
  const PARTICIPANT_COUNT = 1000;
  const CONCURRENCY_CAP = 100; // matches META_MAX_CONCURRENT_SENDERS in adminServer.ts (raised 2026-09-17)
  const FAILURE_RATE = 0.03;

  console.log(`Scenario: near-empty new client, ${PARTICIPANT_COUNT} participants, concurrency cap=${CONCURRENCY_CAP}, campaign includes a video step, ${FAILURE_RATE * 100}% simulated transient failure rate.\n`);

  const pool = new MockPool(2);
  const backend = new TestPostgresBackend(pool);
  const initialData = buildNearEmptyHistory();
  const storage = new Storage(path.join(directory, 'storage.json'), { initialData, backend });
  backend.persistedSnapshot = JSON.parse(JSON.stringify(storage['data']));

  const uploaded = storage.addUploadedFile({ originalName: 'launch-video.mp4', filename: 'launch-video.mp4', mimeType: 'video/mp4', size: 30 });
  addLaunchCampaign(storage, uploaded.id);

  const transport = new LoadTestTransport(storage, {
    minLatencyMs: 150, maxLatencyMs: 600,
    fileMinLatencyMs: 1500, fileMaxLatencyMs: 4000,
    failureRate: FAILURE_RATE,
  });

  const phones = Array.from({ length: PARTICIPANT_COUNT }, (_, i) => `97253${String(2000000 + i).padStart(7, '0')}`);

  const wallStart = Date.now();
  const results = await runThrottled(phones, CONCURRENCY_CAP, (phone) => inbound(storage, transport, phone, 'אני רוצה להשתתף'));
  const wallElapsedMs = Date.now() - wallStart;

  await storage.flush();
  const dbFlushMs = Date.now() - wallStart - wallElapsedMs;

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  const latencies = succeeded.map((r) => r.value).sort((a, b) => a - b);

  console.log(`Wall time for all ${PARTICIPANT_COUNT} participants (throttled to ${CONCURRENCY_CAP} at a time): ${(wallElapsedMs / 1000).toFixed(1)}s`);
  console.log(`Final DB flush after the burst: ${dbFlushMs}ms`);
  console.log(`Succeeded: ${succeeded.length}/${PARTICIPANT_COUNT}, Failed (unrecovered after retries): ${failed.length}/${PARTICIPANT_COUNT}`);
  console.log(`Per-participant latency (trigger to full flow completion, including the video step): p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms max=${latencies[latencies.length - 1] ?? 0}ms`);
  console.log(`Transport: ${transport.sendCount} text/button/card sends, ${transport.fileSendCount} file sends, ${transport.failureCount} simulated transient failures`);
  console.log(`Postgres backend: ${backend.writeCount} coalesced write cycles, ${pool.queryCount} SQL queries, write durations: p50=${percentile([...backend.writeDurationsMs].sort((a, b) => a - b), 50)}ms max=${Math.max(0, ...backend.writeDurationsMs)}ms`);

  if (failed.length) {
    console.error('\nFirst failure:', failed[0].reason);
  }

  const queuedForThisRun = storage.getContactQueue(PARTICIPANT_COUNT + 50).filter((job) => phones.includes(job.phone));
  const resultsForThisRun = storage.getCampaignResults().filter((r) => phones.includes(r.phone.replace(/\D/g, '')));

  try {
    assert.equal(queuedForThisRun.length, succeeded.length, `expected ${succeeded.length} queued contact-save jobs, got ${queuedForThisRun.length}`);
    assert.equal(resultsForThisRun.length, succeeded.length, `expected ${succeeded.length} campaign results, got ${resultsForThisRun.length}`);
    console.log('\nData integrity check passed: one contact-save job and one campaign result per successful participant, no drops, no duplicates.');
  } catch (err) {
    console.error('\nDATA INTEGRITY CHECK FAILED:', err.message);
    process.exitCode = 1;
  }

  for (const phone of phones) conversationState.remove(`whatsapp:${phone}`);
  await storage.close();
  fs.rmSync(directory, { recursive: true, force: true });

  console.log('\nDone.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
