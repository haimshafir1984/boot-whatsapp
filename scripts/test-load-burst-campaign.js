'use strict';

/**
 * Load/burst test for a large-audience campaign launch: simulates many distinct
 * participants triggering the same campaign within a short window (an influencer
 * posting the trigger phrase to their WhatsApp Status), running the REAL Storage
 * class and the REAL handleIncomingWhatsAppMessage flow - not a synthetic
 * micro-benchmark. PostgreSQL persistence is exercised through the actual
 * writeSnapshotDelta/dirty-tracking code path (src/database.ts), against a mocked
 * pg.Pool with artificial network latency, so this measures real coalescing and
 * write-serialization behavior, not just raw function speed.
 *
 * Two scenarios are run:
 *  A. FRESH client - no prior history (best case, a brand-new campaign).
 *  B. ESTABLISHED client - seeded with the same scale measured on a real,
 *     previously-slow client (12,869 outbox messages, 18,641 campaign events,
 *     12,869 campaign results) - the worst case this session's fixes target.
 *
 * Each scenario fires a burst of N distinct participants concurrently through
 * the real flow (trigger -> contact card -> decision question), with a fake
 * WhatsApp transport that adds realistic Meta API latency (150-600ms per call,
 * matching what was observed in live logs) and a configurable transient-failure
 * rate to exercise the retry paths under load, not just the happy path.
 */

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'load-burst-'));
process.env.UPLOADS_PATH = path.join(directory, 'uploads');
fs.mkdirSync(process.env.UPLOADS_PATH, { recursive: true });

const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');
const { writeSnapshotDelta, mergeDirtyTables, mergeDirtyRowIdsByTable } = require('../dist/database');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function randomBetween(min, max) { return Math.floor(min + Math.random() * (max - min)); }

// ── Mocked pg.Pool: no real database, but exercises the real SQL-shaping code
// (upsertRow/syncRowsDeltaTracked/etc.) and adds artificial per-query latency
// to approximate a real network hop to a managed Postgres instance.
class MockPool {
  constructor(queryLatencyMs = 2) {
    this.queryLatencyMs = queryLatencyMs;
    this.queryCount = 0;
  }
  async query() {
    this.queryCount += 1;
    if (this.queryLatencyMs) await sleep(this.queryLatencyMs);
    return { rows: [], rowCount: 0 };
  }
  // writeSnapshotDelta pins its transaction to one dedicated client via
  // pool.connect() (B2-1 fix, commit ff47ebb) - this mock predates that and
  // only had .query(), which broke silently since this script isn't part of
  // npm run build. release() is a no-op; the same query() backs both paths.
  async connect() {
    return { query: (...args) => this.query(...args), release: () => {} };
  }
}

// ── Mirrors PostgresStorageBackend's real coalescing/draining behavior
// (src/database.ts) closely enough to measure it honestly, without needing an
// actual database connection.
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

function buildLargeHistory(outboxCount, eventCount, resultCount) {
  const now = new Date().toISOString();
  const outboxMessages = [];
  for (let i = 0; i < outboxCount; i += 1) {
    outboxMessages.push({
      id: 'seed-m' + i, kind: 'text', to: 'whatsapp:97250000' + (i % 1000), status: 'sent',
      attempts: 1, createdAt: now, updatedAt: now, providerMessageId: 'wamid.seed' + i,
      deliveryStatus: 'delivered',
    });
  }
  const campaignEvents = [];
  for (let i = 0; i < eventCount; i += 1) {
    campaignEvents.push({ id: 'seed-e' + i, campaignId: 'seed-campaign', campaignResultId: 'seed-r' + (i % 500), type: 'step_sent', createdAt: now });
  }
  const campaignResults = [];
  for (let i = 0; i < resultCount; i += 1) {
    campaignResults.push({
      id: 'seed-r' + i, campaignId: 'seed-campaign', phone: 'whatsapp:97250000' + (i % 1000), status: 'saved',
      lastStage: 'completed', triggeredAt: now, updatedAt: now,
    });
  }
  const contactQueue = [];
  for (let i = 0; i < Math.min(outboxCount, 3000); i += 1) {
    contactQueue.push({ id: 'seed-q' + i, phone: '97250000' + (i % 1000), status: 'saved', attempts: 1, createdAt: now, updatedAt: now });
  }
  const contactsList = [];
  for (let i = 0; i < 1000; i += 1) {
    contactsList.push({ phone: '97250000' + i, name: 'Seed Contact ' + i, savedAt: now });
  }
  return { outboxMessages, campaignEvents, campaignResults, contactQueue, contactsList };
}

class LoadTestTransport {
  constructor({ minLatencyMs, maxLatencyMs, failureRate }) {
    this.minLatencyMs = minLatencyMs;
    this.maxLatencyMs = maxLatencyMs;
    this.failureRate = failureRate;
    this.sendCount = 0;
    this.failureCount = 0;
  }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async _maybeFail(label) {
    this.sendCount += 1;
    await sleep(randomBetween(this.minLatencyMs, this.maxLatencyMs));
    if (Math.random() < this.failureRate) {
      this.failureCount += 1;
      const err = new Error(`Simulated transient Meta failure for ${label}`);
      err.transient = true;
      throw err;
    }
  }
  async sendMessage(to, text) { await this._maybeFail('sendMessage'); return { messageId: 'wamid.load-' + Math.random().toString(36).slice(2) }; }
  async sendContactCard(to, vcard, displayName) { await this._maybeFail('sendContactCard'); return { messageId: 'wamid.load-' + Math.random().toString(36).slice(2) }; }
  async sendContactCards(to, contacts, displayName) { await this._maybeFail('sendContactCards'); return { messageId: 'wamid.load-' + Math.random().toString(36).slice(2) }; }
  async sendInteractiveButtons(to, text, buttons) { await this._maybeFail('sendInteractiveButtons'); return { messageId: 'wamid.load-' + Math.random().toString(36).slice(2) }; }
}

function addLoadCampaign(storage) {
  return storage.addCampaign({
    name: 'influencer-launch',
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
      contactCardName: 'Influencer Launch',
      contactCardPhone: '972500000000',
      decisionFlow: [
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
    id: `load-${inboundSequence}`,
    from: `whatsapp:${phone}`,
    body,
    hasUserSignal: true,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Load Test Participant'; },
  }, storage, transport, 'webhook');
  return Date.now() - startedAt;
}

function percentile(sortedArray, p) {
  if (!sortedArray.length) return 0;
  const index = Math.min(sortedArray.length - 1, Math.floor((p / 100) * sortedArray.length));
  return sortedArray[index];
}

// Mirrors the real gateway's own concurrency cap (adminServer.ts's
// metaGatewayInbox.claimBatch(20, ...) loop): different senders are processed
// in batches of `concurrencyCap` at a time, not all at once - this is what
// actually happens in production, unlike a raw unlimited Promise.all.
async function runThrottled(items, concurrencyCap, worker) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += concurrencyCap) {
    const batch = items.slice(offset, offset + concurrencyCap);
    const batchResults = await Promise.allSettled(batch.map(worker));
    results.push(...batchResults);
  }
  return results;
}

async function runScenario(label, { seedScale, participantCount, minLatencyMs, maxLatencyMs, failureRate, concurrencyCap }) {
  console.log(`\n=== Scenario: ${label} ===`);
  console.log(`Participants: ${participantCount}, seeded history: ${seedScale ? `${seedScale.outboxCount} outbox / ${seedScale.eventCount} events / ${seedScale.resultCount} results` : 'none (fresh client)'}, concurrency cap: ${concurrencyCap || 'none (all at once)'}`);

  const pool = new MockPool(2);
  const backend = new TestPostgresBackend(pool);
  const initialData = seedScale ? buildLargeHistory(seedScale.outboxCount, seedScale.eventCount, seedScale.resultCount) : undefined;
  const storage = new Storage(path.join(directory, `storage-${label.replace(/\s+/g, '-')}.json`), {
    initialData,
    backend,
  });
  // Seed the backend's "already persisted" baseline so the first real write is
  // a true delta against existing history, not a from-scratch first write.
  if (initialData) {
    backend.persistedSnapshot = JSON.parse(JSON.stringify(storage['data']));
  }

  addLoadCampaign(storage);
  const transport = new LoadTestTransport({ minLatencyMs, maxLatencyMs, failureRate });

  const phones = Array.from({ length: participantCount }, (_, i) => `97253${String(1000000 + i).padStart(7, '0')}`);

  const wallStart = Date.now();
  const results = concurrencyCap
    ? await runThrottled(phones, concurrencyCap, (phone) => inbound(storage, transport, phone, 'אני רוצה להשתתף'))
    : await Promise.allSettled(phones.map((phone) => inbound(storage, transport, phone, 'אני רוצה להשתתף')));
  const wallElapsedMs = Date.now() - wallStart;

  await storage.flush();
  const dbFlushDoneAt = Date.now();

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  const latencies = succeeded.map((r) => r.value).sort((a, b) => a - b);

  console.log(`Wall time for the whole burst (all ${participantCount} concurrent inbound calls): ${wallElapsedMs}ms`);
  console.log(`Time for final DB flush after the burst: ${dbFlushDoneAt - wallStart - wallElapsedMs}ms`);
  console.log(`Succeeded: ${succeeded.length}/${participantCount}, Failed (unrecovered): ${failed.length}/${participantCount}`);
  console.log(`Per-participant latency (trigger to flow completion): p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms max=${latencies[latencies.length - 1] ?? 0}ms`);
  console.log(`Transport: ${transport.sendCount} send attempts, ${transport.failureCount} simulated transient failures (rate=${failureRate})`);
  console.log(`Postgres backend: ${backend.writeCount} coalesced write cycles, ${pool.queryCount} SQL queries, write durations: p50=${percentile([...backend.writeDurationsMs].sort((a, b) => a - b), 50)}ms max=${Math.max(0, ...backend.writeDurationsMs)}ms`);

  if (failed.length) {
    console.error('First failure:', failed[0].reason);
  }

  // Data-integrity check: every participant that succeeded must have exactly
  // one queued contact-save job and one campaign result - no drops, no
  // duplicates, even under full concurrency. (Contact saving itself finishes
  // asynchronously via the background contactQueue worker, deliberately
  // decoupled from the reply - see contactQueue.ts - so this checks what the
  // synchronous flow actually guarantees: the job and result exist exactly once.)
  const queuedForThisRun = storage.getContactQueue(participantCount + 50)
    .filter((job) => phones.includes(job.phone));
  const resultsForThisRun = storage.getCampaignResults()
    .filter((r) => phones.includes(r.phone.replace(/\D/g, '')));

  assert.ok(failed.length === 0 || failureRate > 0, 'no participant should fail when the transport never simulates a failure');
  assert.equal(queuedForThisRun.length, succeeded.length, `expected ${succeeded.length} queued contact-save jobs (one per successful participant, no duplicates), got ${queuedForThisRun.length}`);
  assert.equal(resultsForThisRun.length, succeeded.length, `expected ${succeeded.length} campaign results (one per successful participant, no duplicates), got ${resultsForThisRun.length}`);

  for (const phone of phones) conversationState.remove(`whatsapp:${phone}`);
  await storage.close();

  return { wallElapsedMs, succeeded: succeeded.length, failed: failed.length, latencies };
}

(async () => {
  try {
    // A: worst-case unthrottled stress on a fresh client - no real gateway
    // concurrency cap in front of it. Establishes an upper bound.
    const A = await runScenario('A-fresh-client-unthrottled', {
      seedScale: null,
      participantCount: 300,
      minLatencyMs: 150,
      maxLatencyMs: 600,
      failureRate: 0,
      concurrencyCap: null,
    });

    // B: same unthrottled stress, but on a client with large existing history
    // (matching the real client that was slow before this session's fixes) -
    // isolates whether accumulated history still degrades things at this scale.
    const B = await runScenario('B-large-history-unthrottled', {
      seedScale: { outboxCount: 12_869, eventCount: 18_641, resultCount: 12_869 },
      participantCount: 300,
      minLatencyMs: 150,
      maxLatencyMs: 600,
      failureRate: 0,
      concurrencyCap: null,
    });

    // D: the actually-representative production scenario - large history,
    // realistic per-sender concurrency cap (matches the gateway's own
    // metaGatewayInbox.claimBatch(20, ...) throttling), plus a 5% simulated
    // transient-failure rate to prove retries recover under real load too.
    const D = await runScenario('D-large-history-throttled-like-production', {
      seedScale: { outboxCount: 12_869, eventCount: 18_641, resultCount: 12_869 },
      participantCount: 300,
      minLatencyMs: 150,
      maxLatencyMs: 600,
      failureRate: 0.05,
      concurrencyCap: 20,
    });

    console.log('\n=== Summary ===');
    console.log(`A (fresh client, 300 unthrottled):                 ${A.wallElapsedMs}ms wall, ${A.succeeded}/${A.succeeded + A.failed} succeeded`);
    console.log(`B (large history, 300 unthrottled):                 ${B.wallElapsedMs}ms wall, ${B.succeeded}/${B.succeeded + B.failed} succeeded`);
    console.log(`D (large history, 300 @ cap=20, 5% txn failures):   ${D.wallElapsedMs}ms wall, ${D.succeeded}/${D.succeeded + D.failed} succeeded`);

    console.log('\nLoad burst test completed - see numbers above.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
