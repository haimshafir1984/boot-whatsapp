'use strict';

/**
 * Does a client stay responsive to the gateway while it is busy running a
 * peak of campaign flows?
 *
 * This is the question the gateway starvation test
 * (test-load-gateway-noisy-vs-quiet.js) left open. That test proved that a
 * client which answers the gateway's per-message calls too slowly (>3s)
 * causes PERMANENT message loss for every OTHER campaign on the shared
 * number. What it could not tell us is whether a real client actually gets
 * that slow under a real peak - the campaign flow is mostly network waiting,
 * which Node handles fine, but it also does real synchronous work
 * (snapshot serialisation, flow bookkeeping) on its single JS thread.
 *
 * So: run N real campaign flows (real handleIncomingWhatsAppMessage, real
 * Storage) in a process that ALSO serves an HTTP endpoint doing the same
 * shape of work as /owner-api/meta-pending-route, and have a SEPARATE
 * process poll that endpoint throughout. The probe latency is exactly what
 * the gateway would experience.
 *
 * Also records event-loop lag directly, as a second, independent signal.
 *
 * Child mode:  --serve --count=N --port=P
 * Parent mode: (no args) - spawns the child and probes it.
 *
 * Not part of the regression suite. Run on request.
 */

const PROBE_INTERVAL_MS = 200;
const GATEWAY_TIMEOUT_MS = 3_000; // AbortSignal.timeout in the gateway discovery loop

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ---------------------------------------------------------------- child ---
async function runChild() {
  process.env.NODE_ENV = 'test';
  process.env.BOT_REPLY_DELAY_MS = '0';
  process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const http = require('node:http');

  const PARTICIPANTS = Number(argv.count);
  const PORT = Number(argv.port);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'client-responsiveness-'));
  process.env.UPLOADS_PATH = path.join(directory, 'uploads');
  fs.mkdirSync(process.env.UPLOADS_PATH, { recursive: true });
  for (const name of ['intro.jpg', 'question-flight.jpg']) {
    fs.writeFileSync(path.join(process.env.UPLOADS_PATH, name), 'fake image bytes for load test');
  }

  const { Storage } = require('../dist/storage');
  const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
  const { conversationState } = require('../dist/conversationState');
  const { writeSnapshotDelta, mergeDirtyTables, mergeDirtyRowIdsByTable } = require('../dist/database');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));

  class MockPool {
    constructor(latency = 2) { this.queryLatencyMs = latency; this.queryCount = 0; }
    async connect() {
      const pool = this;
      return {
        async query() { pool.queryCount += 1; if (pool.queryLatencyMs) await sleep(pool.queryLatencyMs); return { rows: [], rowCount: 0 }; },
        release() {},
      };
    }
    async query() { this.queryCount += 1; if (this.queryLatencyMs) await sleep(this.queryLatencyMs); return { rows: [], rowCount: 0 }; }
  }

  class TestPostgresBackend {
    constructor(pool) {
      this.mode = 'postgres'; this.pool = pool; this.persistedSnapshot = null;
      this.queuedSnapshot = null; this.queuedDirtyTables = new Set(); this.queuedDirtyRowIds = {};
      this.draining = false; this.pending = Promise.resolve(); this.writeCount = 0; this.lastError = undefined;
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
          this.queuedSnapshot = null; this.queuedDirtyTables = new Set(); this.queuedDirtyRowIds = {};
          const snapshot = JSON.parse(JSON.stringify(source));
          await writeSnapshotDelta(this.pool, this.persistedSnapshot, snapshot, dirtyTables, dirtyRowIds);
          this.writeCount += 1;
          this.persistedSnapshot = snapshot;
        }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      } finally { this.draining = false; }
    }
    async flush() { do { await this.pending; } while (this.draining || this.queuedSnapshot); if (this.lastError) throw new Error(this.lastError); }
    async close() { await this.flush(); }
    health() { return { enabled: true, ready: !this.lastError, lastError: this.lastError, pendingWrites: this.queuedSnapshot ? 1 : 0 }; }
  }

  class LoadTransport {
    constructor(storage) { this.storage = storage; this.sendCount = 0; this.fileSendCount = 0; }
    async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
    async _wait(min, max) { this.sendCount += 1; await sleep(randomBetween(min, max)); }
    async sendMessage() { await this._wait(150, 600); return { messageId: 'wamid.' + Math.random().toString(36).slice(2) }; }
    async sendContactCard() { await this._wait(150, 600); return { messageId: 'wamid.' + Math.random().toString(36).slice(2) }; }
    async sendContactCards() { await this._wait(150, 600); return { messageId: 'wamid.' + Math.random().toString(36).slice(2) }; }
    async sendInteractiveButtons() { await this._wait(150, 600); return { messageId: 'wamid.' + Math.random().toString(36).slice(2) }; }
    async sendFile() {
      this.fileSendCount += 1;
      await this._wait(1500, 4000);
      const messageId = 'wamid.file-' + Math.random().toString(36).slice(2);
      setTimeout(() => { try { this.storage.recordOutboxDelivery(messageId, 'delivered'); } catch {} }, randomBetween(200, 900));
      return { messageId };
    }
  }

  const pool = new MockPool(2);
  const backend = new TestPostgresBackend(pool);
  const storage = new Storage(path.join(directory, 'storage.json'), {
    initialData: { outboxMessages: [], campaignEvents: [], campaignResults: [], contactQueue: [], contactsList: [] },
    backend,
  });
  backend.persistedSnapshot = JSON.parse(JSON.stringify(storage['data']));

  const fileIds = ['intro.jpg', 'question-flight.jpg'].map((filename) =>
    storage.addUploadedFile({ originalName: filename, filename, mimeType: 'image/jpeg', size: 30 }).id);

  storage.addCampaign({
    name: 'responsiveness load campaign',
    triggerType: 1,
    triggerPhrase: 'פוקוס שירותי משרד לעסקים',
    suffix: ' - (קמפיין)',
    active: true,
    conversation: {
      askNameEnabled: false, sendContactCard: true, contactCardSendMode: 'separate',
      contactCardName: 'פוקוס', contactCardPhone: '0524024311', contactCardIntroText: '',
      contactCardPlacement: 'before_questions', replyText: '', followupMessages: [],
      decisionTimeoutMinutes: 30, nameTimeoutMinutes: 5,
      decisionFlow: [
        { id: 's1', kind: 'message', text: 'ברוכים הבאים', fileId: fileIds[0], nextStepId: 's2' },
        { id: 's2', kind: 'contact_card', text: '', nextStepId: 's3' },
        { id: 's3', kind: 'question', text: 'שמרת?', presentation: 'buttons', timeoutMode: 'stop',
          options: [{ id: 'o1', text: 'שמרתי', nextStepId: 's4' }] },
        { id: 's4', kind: 'message', text: 'אלופים', nextStepId: 's5' },
        { id: 's5', kind: 'question', text: 'לאן לטוס?', fileId: fileIds[1], presentation: 'list',
          timeoutMode: 'continue', timeoutSeconds: 20, timeoutNextStepId: 's6',
          options: [{ id: 'o2', text: 'יוון', nextStepId: 's6' }, { id: 'o3', text: 'אירופה', nextStepId: 's6' }] },
        { id: 's6', kind: 'question', text: 'שאלה 1', presentation: 'buttons', timeoutMode: 'stop',
          options: [{ id: 'o4', text: '1', nextStepId: 's6' }] },
      ],
    },
  });

  // Stands in for /owner-api/meta-pending-route: a small in-memory lookup and
  // a JSON response. Its latency under load is dominated by event-loop
  // queueing, which is exactly what the gateway would experience.
  const server = http.createServer((req, res) => {
    const phone = '972500000000';
    const pending = conversationState.findByPhone ? conversationState.findByPhone(phone) : null;
    const activeWork = storage.getCampaignResults().some((r) => String(r.phone).includes(phone));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pending: Boolean(pending), activeWork }));
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`PORT_READY:${PORT}`);

  // Independent signal: how far behind schedule a 100ms timer actually fires.
  const lags = [];
  let lastTick = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    lags.push(Math.max(0, now - lastTick - 100));
    lastTick = now;
  }, 100);

  const transport = new LoadTransport(storage);
  const phones = Array.from({ length: PARTICIPANTS }, (_, i) => `97253${String(3000000 + i).padStart(7, '0')}`);

  console.log(`LOAD_START:${Date.now()}`);
  const startedAt = Date.now();
  let seq = 0;
  const results = await Promise.allSettled(phones.map((phone) => (async () => {
    seq += 1;
    await handleIncomingWhatsAppMessage({
      id: `resp-${seq}`,
      from: `whatsapp:${phone}`,
      body: 'פוקוס שירותי משרד לעסקים',
      hasUserSignal: true,
      timestamp: Math.floor(Date.now() / 1000),
      async getDisplayName() { return 'Participant'; },
    }, storage, transport, 'webhook');
  })()));
  const loadMs = Date.now() - startedAt;
  clearInterval(lagTimer);
  console.log(`LOAD_DONE:${Date.now()}`);

  await storage.flush();
  const sortedLags = lags.sort((a, b) => a - b);
  console.log('RESULT_JSON:' + JSON.stringify({
    participants: PARTICIPANTS,
    loadMs,
    succeeded: results.filter((r) => r.status === 'fulfilled').length,
    failed: results.filter((r) => r.status === 'rejected').length,
    lagP50: percentile(sortedLags, 50),
    lagP95: percentile(sortedLags, 95),
    lagMax: sortedLags[sortedLags.length - 1] ?? 0,
    lagSamples: sortedLags.length,
    sendCount: transport.sendCount,
    fileSendCount: transport.fileSendCount,
  }));

  for (const phone of phones) conversationState.remove(`whatsapp:${phone}`);
  await storage.close();
  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 100);
}

// --------------------------------------------------------------- parent ---
async function runParent() {
  const { spawn } = require('node:child_process');
  const PARTICIPANTS = Number(argv.count || 100);
  const PORT = 43117;

  console.log(`Client responsiveness under load: ${PARTICIPANTS} real campaign flows running in one client process,`);
  console.log('while a separate process probes its pending-route-shaped endpoint every 200ms.');
  console.log(`The gateway gives this call ${GATEWAY_TIMEOUT_MS}ms before it times out and the message is retried.\n`);

  const child = spawn(process.execPath, [__filename, '--serve', `--count=${PARTICIPANTS}`, `--port=${PORT}`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  let stdout = '';
  let ready = false;
  let loadStarted = false;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!ready && stdout.includes(`PORT_READY:${PORT}`)) ready = true;
    if (!loadStarted && stdout.includes('LOAD_START:')) loadStarted = true;
  });

  const deadline = Date.now() + 30_000;
  while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (!ready) throw new Error('child never became ready');

  const probes = [];
  const probeAll = [];
  let probing = true;
  const probeLoop = (async () => {
    while (probing) {
      const startedAt = Date.now();
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(20_000) });
        await res.json().catch(() => ({}));
        const ms = Date.now() - startedAt;
        probeAll.push({ ms, duringLoad: loadStarted });
        if (loadStarted) probes.push(ms);
      } catch (err) {
        probeAll.push({ ms: Date.now() - startedAt, duringLoad: loadStarted, error: true });
        if (loadStarted) probes.push(Date.now() - startedAt);
      }
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
    }
  })();

  const summary = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => {
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT_JSON:'));
      if (!line) return reject(new Error('child exited without a result'));
      resolve(JSON.parse(line.slice('RESULT_JSON:'.length)));
    });
  });
  probing = false;
  await probeLoop;

  const sorted = probes.sort((a, b) => a - b);
  const overTimeout = sorted.filter((ms) => ms >= GATEWAY_TIMEOUT_MS).length;

  console.log(`Load: ${summary.participants} flows, ${summary.succeeded} succeeded / ${summary.failed} failed, took ${(summary.loadMs / 1000).toFixed(1)}s`);
  console.log(`      (${summary.sendCount} simulated sends, of which ${summary.fileSendCount} were files)\n`);
  console.log(`Probe latency while the client was under load (${sorted.length} probes):`);
  console.log(`      p50=${percentile(sorted, 50)}ms  p95=${percentile(sorted, 95)}ms  p99=${percentile(sorted, 99)}ms  max=${sorted[sorted.length - 1] ?? 0}ms`);
  console.log(`      probes that would have exceeded the gateway's ${GATEWAY_TIMEOUT_MS}ms timeout: ${overTimeout}/${sorted.length}\n`);
  console.log(`Event-loop lag during the same window (${summary.lagSamples} samples):`);
  console.log(`      p50=${summary.lagP50}ms  p95=${summary.lagP95}ms  max=${summary.lagMax}ms\n`);

  if (overTimeout > 0) {
    console.log(`VERDICT: the client DID become slow enough to blow the gateway's timeout (${overTimeout} times).`);
    console.log('         A peak on one campaign can therefore break routing for the others.');
    process.exitCode = 1;
  } else {
    console.log(`VERDICT: the client stayed responsive - no probe came close to the ${GATEWAY_TIMEOUT_MS}ms timeout.`);
    console.log('         A peak on one campaign does NOT, by itself, starve the others through this path.');
  }
}

const main = argv.serve ? runChild() : runParent();
main.catch((err) => { console.error(err); process.exitCode = 1; });
