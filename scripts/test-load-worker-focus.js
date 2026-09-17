'use strict';

/**
 * Worker process for the multi-process peak-load test
 * (test-load-multiprocess-focus.js). Runs its own slice of participants, in
 * its own OS process with its own event loop - not sharing a CPU thread with
 * any other worker's simulated flows, unlike the single-process version
 * (test-load-single-peak-100-focus.js) which measured its OWN CPU
 * contention, not anything real about the campaign or Meta.
 *
 * Not meant to be run directly for its console output - it prints one line
 * prefixed RESULT_JSON: with a machine-readable summary, which the
 * orchestrator parses. Everything else on stdout is the real console.log
 * noise from messageFlow.js et al: expected, ignored by the orchestrator.
 *
 * Args (all required): --count=N --cap=N --workerId=N
 */

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const PARTICIPANT_COUNT = Number(args.count);
const CONCURRENCY_CAP = Number(args.cap);
const WORKER_ID = args.workerId;
if (!PARTICIPANT_COUNT || !CONCURRENCY_CAP || !WORKER_ID) {
  console.error('Usage: node test-load-worker-focus.js --count=N --cap=N --workerId=N');
  process.exit(1);
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), `load-worker-${WORKER_ID}-`));
process.env.UPLOADS_PATH = path.join(directory, 'uploads');
fs.mkdirSync(process.env.UPLOADS_PATH, { recursive: true });
for (const name of ['intro.jpg', 'question-flight.jpg']) {
  fs.writeFileSync(path.join(process.env.UPLOADS_PATH, name), 'fake image bytes for load test');
}

const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');
const { writeSnapshotDelta, mergeDirtyTables, mergeDirtyRowIdsByTable } = require('../dist/database');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function randomBetween(min, max) { return Math.floor(min + Math.random() * (max - min)); }

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
// 4b004adb), re-pulled from production on 2026-09-17 (contact-card split
// out of the first, now image-only, message step). Trimmed to the steps
// this test's scope actually reaches (through the first question).
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
    name: `פוקוס שירותי משרד לעסקים (worker ${WORKER_ID})`,
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
    id: `focus-w${WORKER_ID}-${inboundSequence}`,
    from: `whatsapp:${phone}`,
    body,
    hasUserSignal: true,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Focus Load Participant'; },
  }, storage, transport, 'webhook');
  return Date.now() - startedAt;
}

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

(async () => {
  const FAILURE_RATE = 0.03;

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

  const phones = Array.from({ length: PARTICIPANT_COUNT }, (_, i) => `9725${WORKER_ID}${String(2000000 + i).padStart(7, '0')}`);
  const sem = new Semaphore(CONCURRENCY_CAP);
  const wallStart = Date.now();

  const results = await Promise.all(phones.map((phone) => (async () => {
    await sem.acquire();
    try {
      const latency = await inbound(storage, transport, phone, 'פוקוס שירותי משרד לעסקים');
      return { status: 'fulfilled', value: latency };
    } catch (err) {
      return { status: 'rejected', reason: String(err && err.message || err) };
    } finally {
      sem.release();
    }
  })()));

  const wallElapsedMs = Date.now() - wallStart;
  await storage.flush();

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  const queuedForThisRun = storage.getContactQueue(PARTICIPANT_COUNT + 50).filter((job) => phones.includes(job.phone));
  const resultsForThisRun = storage.getCampaignResults().filter((r) => phones.includes(r.phone.replace(/\D/g, '')));

  for (const phone of phones) conversationState.remove(`whatsapp:${phone}`);
  await storage.close();
  fs.rmSync(directory, { recursive: true, force: true });

  const summary = {
    workerId: WORKER_ID,
    count: PARTICIPANT_COUNT,
    cap: CONCURRENCY_CAP,
    peakActive: sem.peakActive,
    wallElapsedMs,
    succeeded: succeeded.length,
    failed: failed.length,
    latencies: succeeded.map((r) => r.value),
    sendCount: transport.sendCount,
    fileSendCount: transport.fileSendCount,
    transportFailures: transport.failureCount,
    dbWriteCount: backend.writeCount,
    dbQueryCount: pool.queryCount,
    dbWriteDurationsMs: backend.writeDurationsMs,
    integrityOk: queuedForThisRun.length === succeeded.length && resultsForThisRun.length === succeeded.length,
  };
  console.log('RESULT_JSON:' + JSON.stringify(summary));
})().catch((err) => {
  console.error('WORKER_FATAL', err);
  process.exit(1);
});
