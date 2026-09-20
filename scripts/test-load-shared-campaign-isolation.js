'use strict';

/**
 * Local end-to-end load and isolation test for the shared Meta number.
 *
 * It starts the real admin Meta gateway, sends it realistic webhook payloads,
 * and gives it three independent client HTTP stand-ins. Each stand-in runs
 * the real campaign engine with its own Storage instance and a deterministic
 * fake WhatsApp transport. A fourth, Baileys-shaped campaign runs through
 * the same campaign engine at the same time.
 *
 * No network request reaches Meta, Baileys or production. The test is meant
 * to prove routing ownership and queue behaviour, not Graph API capacity.
 * Provider delays are deliberately conservative for a local simulation:
 * 150ms for text/card/button and 900ms for a file. The seven-second SLO is
 * therefore a regression guard for application queueing, not a promise about
 * an external provider outage.
 *
 * Scenarios:
 *   1. 120 simultaneous entrants into the real Focus campaign.
 *   2. 100 Focus + 25 small-A + 25 small-B Meta entrants on one shared number.
 *   3. 60 Baileys entrants at the same time as scenario 2.
 *
 * A run fails on a foreign forward, a duplicate forward/result, a dropped
 * result, a foreign outbox event, or a median trigger-to-first-response time
 * of seven seconds or more.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-campaign-load-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  WHATSAPP_PROVIDER: 'META_CLOUD_API',
  STORAGE_PATH: path.join(root, 'gateway-storage.json'),
  OWNER_STORAGE_PATH: path.join(root, 'owner.json'),
  CONVERSATION_STATE_PATH: path.join(root, 'conversation-state.json'),
  OWNER_ACCESS_TOKEN: 'shared-load-owner',
  CLIENT_ACCESS_TOKEN: 'shared-load-client',
  META_ACCESS_TOKEN: '',
  DOKPLOY_META_ACCESS_TOKEN: '',
  META_PHONE_NUMBER_ID: 'shared-load-phone-id',
  META_DISPLAY_PHONE_NUMBER: '15550001111',
  BOT_REPLY_DELAY_MS: '0',
});

const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');
const { config } = require('../dist/config');

const SHARED_PHONE_ID = 'shared-load-phone-id';
const SHARED_DISPLAY_NUMBER = '15550001111';
const SLO_MEDIAN_MS = 7_000;
const SINGLE_FOCUS_ENTRANTS = 120;
const MIXED_FOCUS_ENTRANTS = 100;
const MIXED_SMALL_A_ENTRANTS = 25;
const MIXED_SMALL_B_ENTRANTS = 25;
const BAILEYS_ENTRANTS = 60;
const SCENARIO = process.env.LOAD_SCENARIO || 'all'; // single | mixed | all
assert.ok(['single', 'mixed', 'all'].includes(SCENARIO), 'LOAD_SCENARIO must be single, mixed, or all');

// The production server is intentionally chatty at this volume. Keep the
// load-test report readable while preserving failures and its PASS lines.
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = (...args) => {
  const first = String(args[0] ?? '');
  if (first.startsWith('[META_') || first.startsWith('[MSG]') || first.startsWith('[SEND') || first.startsWith('\n[') || first.startsWith('   ')) return;
  originalLog(...args);
};
console.warn = (...args) => {
  const first = String(args[0] ?? '');
  if (first.startsWith('[META_')) return;
  originalWarn(...args);
};
console.error = (...args) => {
  if (String(args[0] ?? '').startsWith('[META_GATEWAY_PENDING_CHECK_FAILED]')) return;
  originalError(...args);
};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// Per-group summary (median/p95/p99/max) so a starved small campaign is not
// hidden inside a combined median. Reported as RESULT_JSON for the baseline runner.
function summarize(latencies) {
  return {
    n: latencies.length,
    median: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.length ? Math.max(...latencies) : 0,
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('error', reject);
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function close(server) {
  return Promise.race([
    new Promise((resolve) => server.close(resolve)),
    sleep(1_000), // test-only servers can retain a keep-alive socket briefly
  ]);
}

function makeCampaign(id, name, triggerPhrase, { focus = false } = {}) {
  const firstStep = focus
    ? {
      id: 'focus-welcome', kind: 'contact_card', text: 'ברוכים הבאים לפוקוס',
      fileId: 'focus-intro-file', nextStepId: 'focus-question',
    }
    : { id: 'welcome', kind: 'message', text: `ברוכים הבאים ל-${name}`, nextStepId: 'question' };
  return {
    id,
    name,
    triggerType: 1,
    triggerPhrase,
    suffix: ' - Bot',
    active: true,
    runtimeStatus: 'active',
    conversation: {
      askNameEnabled: false,
      nameTimeoutMinutes: 5,
      askNameText: '',
      replyText: '',
      followupMessages: [],
      sendContactCard: Boolean(focus),
      contactCardName: focus ? 'פוקוס שירותי משרד לעסקים' : '',
      contactCardPhone: focus ? '0524024311' : '',
      contactCardPlacement: 'before_questions',
      decisionTimeoutMinutes: 30,
      decisionTimeoutMode: 'message',
      decisionTimeoutText: '',
      invalidReplyText: 'לא הצלחתי לזהות את התשובה.',
      flowRecoveryText: 'נראה שהשיחה נקטעה.',
      humanHandoffEnabled: false,
      decisionFlow: [
        firstStep,
        {
          id: focus ? 'focus-question' : 'question', kind: 'question', presentation: 'buttons',
          text: focus ? 'שמרת?' : 'רוצה להמשיך?',
          options: [{ id: 'continue', text: 'כן' }], timeoutMode: 'stop',
        },
      ],
    },
  };
}

class FakeTransport {
  constructor(label, stats, onSent) {
    this.label = label;
    this.stats = stats;
    this.onSent = onSent;
    this.sequence = 0;
  }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async send(kind, to, text = '') {
    await sleep(kind === 'file' ? 900 : 150);
    const at = Date.now();
    this.sequence += 1;
    const event = { kind, to, text, at, messageId: `${this.label}-${this.sequence}` };
    this.stats.sent.push(event);
    const phone = String(to).replace(/\D/g, '');
    if (!this.stats.firstResponseAt.has(phone)) this.stats.firstResponseAt.set(phone, at);
    this.onSent?.(event);
    return { messageId: event.messageId };
  }
  sendMessage(to, text) { return this.send('text', to, text); }
  sendContactCard(to) { return this.send('contact_card', to); }
  sendContactCards(to) { return this.send('contact_cards', to); }
  sendInteractiveButtons(to, text) { return this.send('buttons', to, text); }
  sendInteractiveList(to, text) { return this.send('list', to, text); }
  sendFile(to, _file, caption) { return this.send('file', to, caption); }
}

function ownerClientRecord(id, managementUrl) {
  return {
    id, name: id, accessCode: id, ownerAccessToken: `${id}-owner-token`,
    plan: 'self_service', readonlyDashboard: false, maxCampaigns: 7,
    whatsappProvider: 'META_CLOUD_API', metaPhoneNumberId: SHARED_PHONE_ID,
    metaDisplayPhoneNumber: SHARED_DISPLAY_NUMBER, managementUrl,
    provisioningStatus: 'ready', createdAt: new Date().toISOString(),
  };
}

function metaPayload(messageId, phone, body) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: SHARED_PHONE_ID, display_phone_number: SHARED_DISPLAY_NUMBER },
      contacts: [{ wa_id: phone, profile: { name: `Load ${phone.slice(-4)}` } }],
      messages: [{ id: messageId, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
    } }] }],
  };
}

let inboundSequence = 0;

// LOAD_BACKEND=pg: every CLIENT runs on real PostgreSQL (one schema per client in the local test database), like
// production. The gateway stays JSON on purpose - in production it holds no outbox rows. Default (unset) = old JSON fixture.
const LOAD_PG = process.env.LOAD_BACKEND === 'pg';
const pgSchemas = [];
const pgStorages = [];
async function pgStorage(id) {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) { console.error('BLOCKED: LOAD_BACKEND=pg needs TEST_DATABASE_URL'); process.exit(3); }
  const u = new URL(base);
  if (!['localhost', '127.0.0.1'].includes(u.hostname) || !u.pathname.toLowerCase().includes('test')) { console.error('Refusing: TEST_DATABASE_URL must be a local *test* database'); process.exit(1); }
  const schema = ('load_' + id.replace(/[^a-z0-9]/gi, '_') + '_' + process.pid).toLowerCase();
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: base });
  await admin.query('drop schema if exists ' + schema + ' cascade');
  await admin.query('create schema ' + schema);
  await admin.end();
  pgSchemas.push(schema);
  u.searchParams.set('options', '-c search_path=' + schema);
  const url = u.toString();
  const { createPostgresBackend, migrateDatabase } = require('../dist/database');
  const { emptyStorageData } = require('../dist/storage');
  await migrateDatabase(url);
  const backend = await createPostgresBackend(url);
  const made = new Storage(path.join(root, id + '-unused.json'), { initialData: (await backend.loadSnapshot()) ?? emptyStorageData(), backend });
  pgStorages.push(made);
  return made;
}
async function dropPgSchemas() {
  if (!pgSchemas.length) return;
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  for (const sc of pgSchemas) await admin.query('drop schema if exists ' + sc + ' cascade').catch(() => {});
  await admin.end();
}

function createClient(definition, storageOverride) {
  const stats = { forwards: [], sent: [], firstResponseAt: new Map(), errors: [] };
  const storage = storageOverride || new Storage(path.join(root, `${definition.id}.json`));
  if (definition.focus) {
    const uploaded = storage.addUploadedFile({ originalName: 'focus-intro.jpg', filename: 'focus-intro.jpg', mimeType: 'image/jpeg', size: 1 });
    definition.campaign.conversation.decisionFlow[0].fileId = uploaded.id;
  }
  storage.addCampaign(definition.campaign);
  const transport = new FakeTransport(definition.id, stats, (event) => {
    // File steps wait for the delivery webhook before continuing. The real
    // provider sends it asynchronously after accepting the outbound message.
    setTimeout(() => storage.recordOutboxDelivery(event.messageId, 'delivered'), 15);
  });
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/owner-api/meta-routes') {
        return json(res, 200, [{ ...definition.campaign, routeKind: 'campaign' }]);
      }
      if (req.url === '/owner-api/meta-pending-route') return json(res, 200, { pending: false, activeWork: false });
      if (req.url === '/owner-api/meta-clear-pending') return json(res, 200, { removed: 0, cancelled: true });
      if (req.url !== '/internal/meta/whatsapp') return json(res, 404, { error: 'unknown endpoint' });
      const payload = await readBody(req);
      const message = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const phone = String(message?.from || '').replace(/\D/g, '');
      const body = String(message?.text?.body || '');
      stats.forwards.push({ messageId: String(message?.id || ''), phone, body, at: Date.now() });
      inboundSequence += 1;
      const inbound = {
        id: `client-${definition.id}-${inboundSequence}`,
        from: `whatsapp:${phone}`,
        senderPhone: phone,
        body,
        hasUserSignal: true,
        timestamp: Number(message?.timestamp || Math.floor(Date.now() / 1000)),
        async getDisplayName() { return `Load ${phone.slice(-4)}`; },
      };
      // Mirrors the real /internal/meta/whatsapp endpoint: it durably queues
      // work and acknowledges the gateway before the recipient's full flow
      // (including media delivery) finishes. Waiting for that flow here would
      // turn this one Node process into both the gateway and every client,
      // creating a queue that the deployed architecture does not have.
      void handleIncomingWhatsAppMessage(inbound, storage, transport, 'webhook')
        .then(() => storage.flush())
        .catch((error) => stats.errors.push(error instanceof Error ? error.message : String(error)));
      return json(res, 202, { ok: true });
    } catch (error) {
      stats.errors.push(error instanceof Error ? error.message : String(error));
      return json(res, 500, { error: stats.errors.at(-1) });
    }
  });
  return { ...definition, stats, storage, transport, server };
}

function buildEntrants(count, client, prefix) {
  return Array.from({ length: count }, (_, index) => ({
    clientId: client.id,
    campaignId: client.campaign.id,
    phone: `972${prefix}${String(index).padStart(7, '0')}`,
    body: client.campaign.triggerPhrase,
  }));
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function sendBurst(adminUrl, entrants, label) {
  const started = new Map();
  await Promise.all(entrants.map(async (entrant, index) => {
    const messageId = `${label}-${index}`;
    entrant.messageId = messageId;
    started.set(messageId, Date.now());
    const response = await fetch(`${adminUrl}/webhooks/meta/whatsapp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metaPayload(messageId, entrant.phone, entrant.body)),
    });
    assert.equal(response.status, 200, `${label}: gateway must acknowledge ${messageId}`);
  }));
  return started;
}

function assertMetaIsolation(clients, entrants, started, label) {
  const expectedById = new Map(entrants.map((entrant) => [entrant.messageId, entrant]));
  const allForwards = clients.flatMap((client) => client.stats.forwards.map((forward) => ({ client, forward })));
  assert.equal(allForwards.length, entrants.length, `${label}: every inbound Meta message must be forwarded exactly once`);
  for (const { client, forward } of allForwards) {
    const expected = expectedById.get(forward.messageId);
    assert.ok(expected, `${label}: unexpected forwarded message ${forward.messageId}`);
    assert.equal(client.id, expected.clientId, `${label}: ${forward.messageId} was forwarded to the wrong client`);
    assert.equal(forward.phone, expected.phone, `${label}: ${forward.messageId} changed recipient identity`);
  }
  for (const client of clients) {
    const expected = entrants.filter((entrant) => entrant.clientId === client.id);
    const results = client.storage.getCampaignResults();
    assert.equal(results.length, expected.length, `${label}: ${client.id} must have one campaign result per own entrant`);
    assert.ok(results.every((result) => result.campaignId === client.campaign.id), `${label}: ${client.id} has a foreign campaign result`);
    assert.ok(results.every((result) => expected.some((entrant) => entrant.phone === String(result.phone).replace(/\D/g, ''))), `${label}: ${client.id} has a foreign participant result`);
    assert.equal(client.stats.errors.length, 0, `${label}: ${client.id} handler errors: ${client.stats.errors.join('; ')}`);
    assert.ok(client.stats.sent.every((event) => expected.some((entrant) => entrant.phone === String(event.to).replace(/\D/g, ''))), `${label}: ${client.id} sent to a foreign participant`);
  }
  const missingResponses = entrants.filter((entrant) => !clients.find((client) => client.id === entrant.clientId).stats.firstResponseAt.has(entrant.phone));
  assert.equal(
    missingResponses.length,
    0,
    `${label}: ${missingResponses.length} entrants never received a first response; examples=${missingResponses.slice(0, 5).map((entrant) => entrant.messageId + ':' + entrant.phone).join(', ')}`,
  );
  const responseLatencies = entrants.map((entrant) => {
    const at = clients.find((client) => client.id === entrant.clientId).stats.firstResponseAt.get(entrant.phone);
    return at - started.get(entrant.messageId);
  });
  const median = percentile(responseLatencies, 50);
  const groups = {};
  for (const client of clients) {
    const own = entrants
      .filter((entrant) => entrant.clientId === client.id)
      .map((entrant) => client.stats.firstResponseAt.get(entrant.phone) - started.get(entrant.messageId));
    groups[client.id] = summarize(own);
    // Where does the wait go? gatewayLeg = trigger -> forward arrives at the client (routing at the
    // gateway); clientLeg = forward arrives -> first reply (client campaign engine).
    const own2 = entrants.filter((entrant) => entrant.clientId === client.id);
    const forwardAt = new Map(client.stats.forwards.map((f) => [f.messageId, f.at]));
    groups[client.id].gatewayLeg = summarize(own2.map((entrant) => forwardAt.get(entrant.messageId) - started.get(entrant.messageId)));
    groups[client.id].clientLeg = summarize(own2.map((entrant) => client.stats.firstResponseAt.get(entrant.phone) - forwardAt.get(entrant.messageId)));
  }
  return { median, p95: percentile(responseLatencies, 95), max: Math.max(...responseLatencies), groups };
}

function assertMedianSlo(label, metrics) {
  assert.ok(metrics.median < SLO_MEDIAN_MS, `${label}: median ${metrics.median}ms must be below ${SLO_MEDIAN_MS}ms`);
}

async function runBaileysBurst(campaign, count) {
  const storage = LOAD_PG ? await pgStorage('baileys') : new Storage(path.join(root, 'baileys.json'));
  storage.addCampaign(campaign);
  const stats = { sent: [], firstResponseAt: new Map() };
  const transport = new FakeTransport('baileys', stats);
  const entrants = Array.from({ length: count }, (_, index) => ({ phone: `972880${String(index).padStart(6, '0')}` }));
  const started = new Map();
  await Promise.all(entrants.map(async (entrant, index) => {
    started.set(entrant.phone, Date.now());
    await handleIncomingWhatsAppMessage({
      id: `baileys-${index}`, from: `whatsapp:${entrant.phone}`, senderPhone: entrant.phone,
      body: campaign.triggerPhrase, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000),
      async getDisplayName() { return `Baileys ${index}`; },
    }, storage, transport, 'baileys');
  }));
  await storage.flush();
  assert.equal(storage.getCampaignResults().length, count, 'Baileys: one result per entrant');
  assert.ok(storage.getCampaignResults().every((result) => result.campaignId === campaign.id), 'Baileys: foreign campaign result');
  assert.ok(stats.sent.every((event) => entrants.some((entrant) => entrant.phone === String(event.to).replace(/\D/g, ''))), 'Baileys: sent to a Meta participant');
  const latencies = entrants.map((entrant) => stats.firstResponseAt.get(entrant.phone) - started.get(entrant.phone));
  const median = percentile(latencies, 50);
  assert.ok(median < SLO_MEDIAN_MS, `Baileys: median ${median}ms must be below ${SLO_MEDIAN_MS}ms`);
  return { median, p95: percentile(latencies, 95), max: Math.max(...latencies), group: summarize(latencies), storage, entrants };
}

(async () => {
  const focus = createClient({
    id: 'focus-meta', focus: true,
    campaign: makeCampaign('focus-campaign', 'פוקוס שירותי משרד לעסקים', 'פוקוס שירותי משרד לעסקים', { focus: true }),
  }, LOAD_PG ? await pgStorage('focus-meta') : undefined);
  const smallA = createClient({
    id: 'small-meta-a', focus: false,
    campaign: makeCampaign('small-a-campaign', 'קמפיין קטן א', 'קטן א הצטרפות'),
  }, LOAD_PG ? await pgStorage('small-meta-a') : undefined);
  const smallB = createClient({
    id: 'small-meta-b', focus: false,
    campaign: makeCampaign('small-b-campaign', 'קמפיין קטן ב', 'קטן ב הצטרפות'),
  }, LOAD_PG ? await pgStorage('small-meta-b') : undefined);
  const clients = [focus, smallA, smallB];
  const clientUrls = await Promise.all(clients.map((client) => listen(client.server)));
  const ownerPath = path.join(root, 'owner.json');
  fs.writeFileSync(ownerPath, JSON.stringify(clients.map((client, index) => ownerClientRecord(client.id, clientUrls[index])), null, 2));
  config.OWNER_STORAGE_PATH = ownerPath;
  config.ADMIN_PORT = 0;
  const gatewayStorage = new Storage(path.join(root, 'gateway-storage.json'));
  const admin = require('../dist/adminServer').startAdminServer(gatewayStorage);
  if (!admin.listening) await new Promise((resolve) => admin.once('listening', resolve));
  const adminUrl = `http://127.0.0.1:${admin.address().port}`;

  try {
    let completedSingle = 0;
    if (SCENARIO === 'single' || SCENARIO === 'all') {
      const singlePeak = buildEntrants(SINGLE_FOCUS_ENTRANTS, focus, '701');
      const singleStarted = await sendBurst(adminUrl, singlePeak, 'single-focus');
      originalLog(`Running 1/3: ${SINGLE_FOCUS_ENTRANTS} simultaneous Focus entrants...`);
      await waitFor(
        () => focus.stats.forwards.length === singlePeak.length
          && focus.storage.getCampaignResults().length === singlePeak.length
          && focus.stats.firstResponseAt.size === singlePeak.length,
        'single Focus completion',
        45_000,
      );
      const singleMetrics = assertMetaIsolation([focus], singlePeak, singleStarted, 'single Focus peak');
      originalLog('RESULT_JSON:' + JSON.stringify({ scenario: 'single', groups: singleMetrics.groups }));
      assertMedianSlo('single Focus peak', singleMetrics);
      console.log(`PASS 1: ${SINGLE_FOCUS_ENTRANTS} Focus entrants — median=${singleMetrics.median}ms p95=${singleMetrics.p95}ms max=${singleMetrics.max}ms.`);
      completedSingle = SINGLE_FOCUS_ENTRANTS;
    }

    if (SCENARIO === 'mixed' || SCENARIO === 'all') {
      // Reset the per-scenario observations; campaign data remains, so the
      // assertions below deliberately count only the new known phone ranges.
      for (const client of clients) {
        client.stats.forwards = [];
        client.stats.sent = [];
        client.stats.firstResponseAt = new Map();
        client.stats.errors = [];
      }
      let mixed = [
        ...buildEntrants(MIXED_FOCUS_ENTRANTS, focus, '702'),
        ...buildEntrants(MIXED_SMALL_A_ENTRANTS, smallA, '703'),
        ...buildEntrants(MIXED_SMALL_B_ENTRANTS, smallB, '704'),
      ];
      if (process.env.LOAD_ARRIVAL === 'interleaved') {
        // Diagnostic: spread the small campaigns evenly through the burst instead of queueing them
        // behind all 100 Focus entrants (the default order puts them last in the gateway's FIFO).
        const groups = [mixed.filter((e) => e.clientId === focus.id), mixed.filter((e) => e.clientId === smallA.id), mixed.filter((e) => e.clientId === smallB.id)];
        const total = mixed.length; const merged = []; const idx = [0, 0, 0];
        for (let i = 0; i < total; i++) {
          let best = 0; let bestRatio = Infinity;
          groups.forEach((g, gi) => { if (idx[gi] < g.length) { const ratio = (idx[gi] + 0.5) / g.length; if (ratio < bestRatio) { bestRatio = ratio; best = gi; } } });
          merged.push(groups[best][idx[best]++]);
        }
        mixed = merged;
      }
      const baileysCampaign = makeCampaign('baileys-campaign', 'קמפיין Baileys מקביל', 'baileys parallel trigger');
      const [mixedStarted, baileysMetrics] = await Promise.all([
        sendBurst(adminUrl, mixed, 'mixed-meta'),
        runBaileysBurst(baileysCampaign, BAILEYS_ENTRANTS),
      ]);
      originalLog(`Running 2/3: ${mixed.length} Meta entrants across three campaigns, plus ${BAILEYS_ENTRANTS} Baileys entrants...`);
      await waitFor(
        () => clients.reduce((sum, client) => sum + client.stats.forwards.length, 0) === mixed.length
          && focus.storage.getCampaignResults().length === completedSingle + MIXED_FOCUS_ENTRANTS
          && smallA.storage.getCampaignResults().length === MIXED_SMALL_A_ENTRANTS
          && smallB.storage.getCampaignResults().length === MIXED_SMALL_B_ENTRANTS
          && focus.stats.firstResponseAt.size === MIXED_FOCUS_ENTRANTS
          && smallA.stats.firstResponseAt.size === MIXED_SMALL_A_ENTRANTS
          && smallB.stats.firstResponseAt.size === MIXED_SMALL_B_ENTRANTS,
        'mixed Meta completion',
        45_000,
      );
      // Only results created for this scenario count: each number range is unique.
      for (const client of clients) {
        const expectedPhones = new Set(mixed.filter((entrant) => entrant.clientId === client.id).map((entrant) => entrant.phone));
        const originalGetResults = client.storage.getCampaignResults.bind(client.storage);
        client.storage.getCampaignResults = () => originalGetResults().filter((result) => expectedPhones.has(String(result.phone).replace(/\D/g, '')));
      }
      const mixedMetrics = assertMetaIsolation(clients, mixed, mixedStarted, 'mixed Meta + Baileys peak');
      console.log(`PASS 2 ownership: ${mixed.length} Meta entrants across 3 campaigns; no campaign leakage.`);
      console.log(`PASS 3 ownership: ${BAILEYS_ENTRANTS} concurrent Baileys entrants; isolated from Meta.`);
      console.log(`Mixed response metrics: Meta median=${mixedMetrics.median}ms p95=${mixedMetrics.p95}ms max=${mixedMetrics.max}ms; Baileys median=${baileysMetrics.median}ms p95=${baileysMetrics.p95}ms max=${baileysMetrics.max}ms.`);
      originalLog('RESULT_JSON:' + JSON.stringify({ scenario: 'mixed', groups: { ...mixedMetrics.groups, baileys: baileysMetrics.group } }));
      assertMedianSlo('mixed Meta + Baileys peak', mixedMetrics);
    }
  } finally {
    admin.closeAllConnections();
    await close(admin);
    await Promise.all(clients.map((client) => close(client.server)));
    for (const client of clients) {
      for (const result of client.storage.getCampaignResults()) conversationState.removeByPhone(result.phone);
    }
    fs.rmSync(root, { recursive: true, force: true });
    for (const made of pgStorages) await made.close().catch(() => {});
    await dropPgSchemas();
  }
})().then(
  () => setTimeout(() => process.exit(0), 100),
  (error) => { console.error(error); setTimeout(() => process.exit(1), 100); },
);
