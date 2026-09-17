'use strict';

/**
 * Sustained-arrival load test for "פוקוס שירותי משרד לעסקים" (client
 * 4b004adb), run on request. Unlike test-load-burst-focus-campaign.js (one
 * instantaneous 1,000-participant burst - the worst case), this models a
 * more realistic launch: 1,000 participants arriving over time in waves of
 * 50-100 concurrent arrivals each, with real gaps between waves - while
 * PROCESSING stays capped at the real production concurrency limit
 * (META_MAX_CONCURRENT_SENDERS = 50 in adminServer.ts) regardless of how many
 * arrive in a wave. A wave of 100 must have its extra 50 queue correctly
 * behind the cap, not get dropped or processed unbounded.
 *
 * Uses the CURRENT campaign flow (re-pulled from production 2026-09-17,
 * after the contact-card was split out of the first step): step 1 is now a
 * plain image message (no contact card attached), followed by a separate
 * contact_card step, then the first question - not a mock.
 *
 * Same harness design as test-load-burst-focus-campaign.js (real Storage +
 * real handleIncomingWhatsAppMessage, mocked Postgres via the actual
 * writeSnapshotDelta code path) - see that file's header for the full
 * rationale. Scope is the same too: burst-trigger through the first
 * question; the later score-question steps are answered at each
 * participant's own pace and are not simulated here.
 */

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'load-burst-focus-sustained-'));
process.env.UPLOADS_PATH = path.join(directory, 'uploads');
fs.mkdirSync(process.env.UPLOADS_PATH, { recursive: true });
for (const name of ['intro.jpg', 'question-flight.jpg', 'result.jpg']) {
  fs.writeFileSync(path.join(process.env.UPLOADS_PATH, name), 'fake image bytes for load test');
}

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
  return { outboxMessages, campaignEvents: [], campaignResults: [], contactQueue: [], contactsList: [] };
}

// A real Meta send call is a live HTTP round trip - not internally limited by
// our own process. Only OUR system's own concurrency cap (below) governs how
// many run at once; this mock has no cap of its own, matching that.
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
    await this._maybeFail('sendFile', this.fileMinLatencyMs, this.fileMaxLatencyMs);
    const messageId = 'wamid.load-file-' + Math.random().toString(36).slice(2);
    setTimeout(() => {
      try { this.storage.recordOutboxDelivery(messageId, 'delivered'); } catch { /* ignore */ }
    }, randomBetween(200, 900));
    return { messageId };
  }
}

// Current REAL decisionFlow for "פוקוס שירותי משרד לעסקים" (client
// 4b004adb), re-pulled from production on 2026-09-17 AFTER the contact-card
// was split out of the first (now image-only) message step.
const REAL_CONVERSATION = {
  replyText: '',
  askNameText: 'ברוכה הבאה🥰\nבאיזה שם תרצי שאשמור אותך?',
  contactCards: [{ name: 'פוקוס שירותי משרד לעסקים', email: '', phone: '0524024311', organization: '' }],
  decisionFlow: [
    {
      id: 'step-mu56vr6w-m5q6', kind: 'message',
      text: '*ברוכים הבאים לפעילות הכי שווה שיש לבעלי עסקים*',
      fileId: '__FILE_1__', nextStepId: 'step-mu524xsf-5mzi',
    },
    { id: 'step-mu524xsf-5mzi', kind: 'contact_card', text: '', nextStepId: 'step-mu525deu-f926' },
    {
      id: 'step-mu525deu-f926', kind: 'question', text: 'שמרת?',
      options: [{ id: 'option-mu525deu-ovh4', text: '✅ שמרתי', nextStepId: 'step-mu526aab-ecyb' }],
      timeoutMode: 'stop', presentation: 'buttons',
    },
    { id: 'step-mu526aab-ecyb', kind: 'message', text: '*אלופים!!*', nextStepId: 'step-mu526mk3-w9o6' },
    {
      id: 'step-mu526mk3-w9o6', kind: 'question', text: 'לאיפה תרצו לטוס?',
      fileId: '__FILE_2__',
      options: [
        { id: 'option-mu526mk4-4tuu', text: 'יוון', nextStepId: 'step-mu528mxv-5g5o' },
        { id: 'option-mu526mk4-4ulg', text: 'אירופה', nextStepId: 'step-mu528mxv-5g5o' },
      ],
      timeoutMode: 'continue', presentation: 'list', listButtonText: 'לאפשרויות 👇',
      timeoutSeconds: 20, timeoutNextStepId: 'step-mu528mxv-5g5o', listSelectionDisplay: 'text',
    },
    {
      id: 'step-mu528mxv-5g5o', kind: 'score_question', text: 'שאלה 1 מתוך 5',
      options: [
        { id: 'option-mu528mxv-63dz', text: '1', score: 1, nextStepId: 'step-mu529qeu-f9mb' },
        { id: 'option-mu528mxv-567e', text: '2', score: 2, nextStepId: 'step-mu529qeu-f9mb' },
        { id: 'option-mu529m82-5jda', text: '3', score: 3, nextStepId: 'step-mu529qeu-f9mb' },
      ],
      timeoutMode: 'stop', presentation: 'buttons',
    },
  ],
  askNameEnabled: false,
  completionLinks: [],
  contactCardName: 'פוקוס שירותי משרד לעסקים',
  sendContactCard: true,
  contactCardEmail: '',
  contactCardPhone: '0524024311',
  flowRecoveryText: 'נראה שהשיחה נקטעה. נחזור לשאלה האחרונה כדי שאפשר יהיה להמשיך.',
  followupMessages: [],
  humanHandoffText: 'אני מענה אוטומטי.',
  invalidReplyText: 'לא הצלחתי לזהות את התשובה.',
  completionFileIds: [],
  humanHandoffPhone: '',
  preNamePromptText: '',
  nameTimeoutMinutes: 5,
  contactCardSendMode: 'separate',
  decisionTimeoutMode: 'message',
  decisionTimeoutText: 'אסטרטגיה של קמפיין זה נבנתה על ידי אביה ברזני',
  humanHandoffEnabled: false,
  contactCardIntroText: '',
  contactCardPlacement: 'before_questions',
  decisionTimeoutMinutes: 30,
  contactCardOrganization: '',
  decisionTimeoutNextStepId: '',
  preNamePromptAutoContinue: true,
  preNamePromptTimeoutMinutes: 1,
  contactCardWaitForConfirmation: false,
  contactCardConfirmationTimeoutMinutes: 30,
};

function addFocusCampaign(storage, fileIds) {
  const flow = JSON.parse(JSON.stringify(REAL_CONVERSATION));
  const replaceFileId = (id) => id === '__FILE_1__' ? fileIds[0] : id === '__FILE_2__' ? fileIds[1] : id;
  for (const step of flow.decisionFlow) {
    if (step.fileId) step.fileId = replaceFileId(step.fileId);
  }
  return storage.addCampaign({
    name: 'פוקוס שירותי משרד לעסקים (sustained load test copy)',
    triggerType: 1,
    triggerPhrase: 'פוקוס שירותי משרד לעסקים',
    suffix: ' - (קמפיין)',
    active: true,
    conversation: flow,
  });
}

let inboundSequence = 0;
async function inbound(storage, transport, phone, body) {
  inboundSequence += 1;
  const startedAt = Date.now();
  await handleIncomingWhatsAppMessage({
    id: `focus-sustained-${inboundSequence}`,
    from: `whatsapp:${phone}`,
    body,
    hasUserSignal: true,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Focus Load Participant'; },
  }, storage, transport, 'webhook');
  return Date.now() - startedAt;
}

function percentile(sortedArray, p) {
  if (!sortedArray.length) return 0;
  const index = Math.min(sortedArray.length - 1, Math.floor((p / 100) * sortedArray.length));
  return sortedArray[index];
}

// Global semaphore: models the real system's own concurrency cap
// (metaGatewayDrainer's maxConcurrentSenders), independent of arrival
// timing. A wave larger than the cap must have its overflow wait here, not
// get dropped or run unbounded.
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.peakActive = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
  }
  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

// Builds an arrival schedule: waves of 50-100 participants each, with a real
// gap between consecutive waves - not one instantaneous block, and not a
// smooth trickle either. Returns [{ startAtMs, phones: [...] }, ...].
function buildWaveSchedule(totalParticipants, phones, { waveMin, waveMax, gapMinMs, gapMaxMs }) {
  const waves = [];
  let offset = 0;
  let cursorMs = 0;
  while (offset < totalParticipants) {
    const size = Math.min(randomBetween(waveMin, waveMax + 1), totalParticipants - offset);
    waves.push({ startAtMs: cursorMs, phones: phones.slice(offset, offset + size) });
    offset += size;
    cursorMs += randomBetween(gapMinMs, gapMaxMs + 1);
  }
  return waves;
}

(async () => {
  const PARTICIPANT_COUNT = 1000;
  const CONCURRENCY_CAP = 100; // matches META_MAX_CONCURRENT_SENDERS in adminServer.ts (raised 2026-09-17)
  const FAILURE_RATE = 0.03;
  const WAVE_MIN = 50;
  const WAVE_MAX = 100;
  const GAP_MIN_MS = 3_000;
  const GAP_MAX_MS = 8_000;

  const pool = new MockPool(2);
  const backend = new TestPostgresBackend(pool);
  const initialData = buildNearEmptyHistory();
  const storage = new Storage(path.join(directory, 'storage.json'), { initialData, backend });
  backend.persistedSnapshot = JSON.parse(JSON.stringify(storage['data']));

  const fileIds = ['intro.jpg', 'question-flight.jpg'].map((filename) =>
    storage.addUploadedFile({ originalName: filename, filename, mimeType: 'image/jpeg', size: 30 }).id);
  addFocusCampaign(storage, fileIds);

  const transport = new LoadTestTransport(storage, {
    minLatencyMs: 150, maxLatencyMs: 600,
    fileMinLatencyMs: 1500, fileMaxLatencyMs: 4000,
    failureRate: FAILURE_RATE,
  });

  const phones = Array.from({ length: PARTICIPANT_COUNT }, (_, i) => `97253${String(2000000 + i).padStart(7, '0')}`);
  const waves = buildWaveSchedule(PARTICIPANT_COUNT, phones, { waveMin: WAVE_MIN, waveMax: WAVE_MAX, gapMinMs: GAP_MIN_MS, gapMaxMs: GAP_MAX_MS });
  const totalArrivalSpanMs = waves[waves.length - 1].startAtMs;

  console.log(`Scenario: current "פוקוס שירותי משרד לעסקים" flow, ${PARTICIPANT_COUNT} participants arriving in ${waves.length} waves of ${WAVE_MIN}-${WAVE_MAX} each over ~${(totalArrivalSpanMs / 1000).toFixed(0)}s, processing cap=${CONCURRENCY_CAP} (real production limit), ${FAILURE_RATE * 100}% simulated transient failure rate.\n`);
  console.log('Scope: burst-trigger through the welcome image + contact card + first question. Later score-question steps are answered at each participant\'s own pace and are not part of this simulation.\n');
  for (const wave of waves) console.log(`  wave at +${(wave.startAtMs / 1000).toFixed(1)}s: ${wave.phones.length} arrivals`);
  console.log('');

  const sem = new Semaphore(CONCURRENCY_CAP);
  const wallStart = Date.now();
  const allSettled = [];

  await Promise.all(waves.map((wave) => (async () => {
    if (wave.startAtMs > 0) await sleep(wave.startAtMs);
    for (const phone of wave.phones) {
      allSettled.push((async () => {
        await sem.acquire();
        try {
          const latency = await inbound(storage, transport, phone, 'פוקוס שירותי משרד לעסקים');
          return { status: 'fulfilled', value: latency };
        } catch (err) {
          return { status: 'rejected', reason: err };
        } finally {
          sem.release();
        }
      })());
    }
  })()));

  const results = await Promise.all(allSettled);
  const wallElapsedMs = Date.now() - wallStart;

  await storage.flush();
  const dbFlushMs = Date.now() - wallStart - wallElapsedMs;

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  const latencies = succeeded.map((r) => r.value).sort((a, b) => a - b);

  console.log(`Total wall time (last arrival wave started at +${(totalArrivalSpanMs / 1000).toFixed(0)}s, all processing finished at +${(wallElapsedMs / 1000).toFixed(1)}s): ${(wallElapsedMs / 1000).toFixed(1)}s`);
  console.log(`Peak concurrent processing observed: ${sem.peakActive} (cap was ${CONCURRENCY_CAP} - must never exceed it)`);
  console.log(`Final DB flush after the run: ${dbFlushMs}ms`);
  console.log(`Succeeded: ${succeeded.length}/${PARTICIPANT_COUNT}, Failed (unrecovered after retries): ${failed.length}/${PARTICIPANT_COUNT}`);
  console.log(`Per-participant latency (trigger to welcome-image+contact-card+first-question sent): p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms max=${latencies[latencies.length - 1] ?? 0}ms`);
  console.log(`Transport: ${transport.sendCount} text/button/card sends, ${transport.fileSendCount} file sends, ${transport.failureCount} simulated transient failures`);
  console.log(`Postgres backend: ${backend.writeCount} coalesced write cycles, ${pool.queryCount} SQL queries, write durations: p50=${percentile([...backend.writeDurationsMs].sort((a, b) => a - b), 50)}ms max=${Math.max(0, ...backend.writeDurationsMs)}ms`);

  if (failed.length) {
    console.error('\nFirst failure:', failed[0].reason);
  }
  if (sem.peakActive > CONCURRENCY_CAP) {
    console.error(`\nCONCURRENCY CAP VIOLATED: peak ${sem.peakActive} exceeded cap ${CONCURRENCY_CAP}`);
    process.exitCode = 1;
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
