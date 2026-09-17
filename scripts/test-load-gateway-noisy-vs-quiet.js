'use strict';

/**
 * Does a NOISY campaign starve a QUIET one on the shared Meta gateway?
 *
 * Every load test before this one called handleIncomingWhatsAppMessage
 * directly - i.e. measured only the CLIENT side, which is NOT shared: each
 * client runs in its own container with its own inbox and its own
 * META_MAX_CONCURRENT_SENDERS. The only genuinely shared resource is the
 * gateway, and the only realistic starvation path through it is this:
 *
 *   routeMetaGatewayInbound asks EVERY client on the shared number
 *   "do you have a pending conversation with this sender?" - a LIVE HTTP
 *   call, per inbound message, to all 10 clients (adminServer.ts discovery
 *   loop). A client that is loaded and answers slowly therefore slows
 *   routing for EVERY other client's messages too.
 *
 * This test runs the REAL startAdminServer with 10 fake client HTTP servers
 * (matching production's 10 Meta clients on one number) and fires real
 * webhook payloads at the real /webhooks/meta/whatsapp endpoint. It measures
 * the quiet campaign's webhook -> forwarded-to-its-client latency while a
 * noisy campaign floods the gateway, under three conditions:
 *
 *   1. baseline   - noisy client answers pending-checks fast (healthy)
 *   2. slow       - noisy client answers in 2s (loaded, but inside the 3s
 *                   AbortSignal.timeout, so no failure - just slow)
 *   3. timing-out - noisy client answers in 5s (past the timeout, so its
 *                   pending check FAILS). This is the exact condition
 *                   today's blast-radius fix was built for: the quiet
 *                   campaign must still route.
 *
 * The client side is deliberately faked (fast 202s) because it is not
 * shared and was measured separately; faking it isolates the gateway.
 *
 * Not part of the regression suite. Run on request.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-noisy-quiet-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  WHATSAPP_PROVIDER: 'META_CLOUD_API',
  STORAGE_PATH: path.join(root, 'storage.json'),
  OWNER_STORAGE_PATH: path.join(root, 'owner.json'),
  CONVERSATION_STATE_PATH: path.join(root, 'state.json'),
  OWNER_ACCESS_TOKEN: 'synthetic-owner',
  CLIENT_ACCESS_TOKEN: 'synthetic-client',
  META_ACCESS_TOKEN: '',
  META_APP_SECRET: '',
  DOKPLOY_META_ACCESS_TOKEN: '',
  META_PHONE_NUMBER_ID: 'shared-phone-id',
  META_DISPLAY_PHONE_NUMBER: '15550001111',
  BOT_REPLY_DELAY_MS: '0',
});

const NOISY_TRIGGER = 'noisy campaign start';
const QUIET_TRIGGER = 'quiet campaign start';
const BYSTANDER_COUNT = 8; // + noisy + quiet = 10 clients, matching production
const NOISY_MESSAGES = 100;
const QUIET_MESSAGES = 6;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function clientRecord(id, managementUrl) {
  return {
    id,
    name: id,
    accessCode: id,
    ownerAccessToken: `${id}-owner-token`,
    plan: 'self_service',
    readonlyDashboard: false,
    maxCampaigns: 7,
    whatsappProvider: 'META_CLOUD_API',
    metaPhoneNumberId: 'shared-phone-id',
    metaDisplayPhoneNumber: '15550001111',
    managementUrl,
    provisioningStatus: 'ready',
    createdAt: new Date().toISOString(),
  };
}

function campaign(id, triggerPhrase) {
  return { id, name: id, triggerType: 1, triggerPhrase, suffix: '', active: true, runtimeStatus: 'active' };
}

function metaPayload(id, from, body) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'shared-phone-id', display_phone_number: '15550001111' },
          contacts: [{ wa_id: from, profile: { name: 'Load participant' } }],
          messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
        },
      }],
    }],
  };
}

/**
 * A stand-in for one client app. `pendingDelayMs` models how long this
 * client takes to answer the gateway's per-message pending check - the one
 * thing a loaded client actually makes slower for everyone else.
 */
function makeFakeClient({ id, routes, pendingDelayMs = 0, clearDelayMs, recoverAfterMs = 0, forwardLog }) {
  // A loaded client is slow at EVERY endpoint, not just the pending check -
  // so clear-pending defaults to the same delay. Override it to isolate
  // which of the two calls is actually doing the blocking.
  const effectiveClearDelay = clearDelayMs === undefined ? pendingDelayMs : clearDelayMs;
  const state = {
    id, pendingDelayMs, clearDelayMs: effectiveClearDelay, recoverAfterMs,
    pendingCalls: 0, clearCalls: 0, forwards: 0, recoveredAt: 0,
    startedAt: Date.now(),
  };
  // A client that is restarting (a redeploy, a crash, an OOM) REFUSES
  // connections while it is gone - it does not hang. That distinction
  // matters: a refused connection fails instantly, so the message burns
  // through its retry budget fast, whereas a hang costs 3s per attempt and
  // accidentally survives longer. Production showed the refusing kind, so
  // the outage below actually stops listening (see runScenario).
  const server = http.createServer(async (req, res) => {
    if (req.url === '/owner-api/meta-routes') return json(res, 200, routes);
    if (req.url === '/owner-api/meta-pending-route') {
      state.pendingCalls += 1;
      await readBody(req);
      if (state.pendingDelayMs) await sleep(state.pendingDelayMs);
      return json(res, 200, { pending: false, activeWork: false });
    }
    if (req.url === '/owner-api/meta-clear-pending') {
      state.clearCalls += 1;
      await readBody(req);
      if (state.clearDelayMs) await sleep(state.clearDelayMs);
      return json(res, 200, { removed: 0, cancelled: true });
    }
    if (req.url === '/internal/meta/whatsapp') {
      state.forwards += 1;
      const body = await readBody(req);
      const messageId = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;
      if (forwardLog && messageId) forwardLog.set(messageId, Date.now());
      // Mirrors the real client: queue and return 202 immediately, never
      // holding the gateway's slot for the campaign flow itself.
      return json(res, 202, { ok: true, queued: 1 });
    }
    return json(res, 404, {});
  });
  return { state, server };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function runScenario(label, noisyPendingDelayMs, noisyClearDelayMs, recoverAfterMs = 0) {
  const forwardLog = new Map(); // messageId -> forwarded-at timestamp
  const clients = [];

  const noisy = makeFakeClient({
    id: 'noisy-client',
    routes: [campaign('noisy-campaign', NOISY_TRIGGER)],
    pendingDelayMs: noisyPendingDelayMs,
    clearDelayMs: noisyClearDelayMs,
    recoverAfterMs,
    forwardLog,
  });
  const quiet = makeFakeClient({
    id: 'quiet-client',
    routes: [campaign('quiet-campaign', QUIET_TRIGGER)],
    forwardLog,
  });
  clients.push(noisy, quiet);
  for (let i = 0; i < BYSTANDER_COUNT; i += 1) {
    clients.push(makeFakeClient({ id: `bystander-${i + 1}`, routes: [], forwardLog }));
  }

  const records = [];
  for (const c of clients) {
    const url = await listen(c.server);
    records.push(clientRecord(c.state.id, url));
  }

  const ownerPath = path.join(root, `owner-${label}.json`);
  fs.writeFileSync(ownerPath, JSON.stringify(records, null, 2));
  process.env.OWNER_STORAGE_PATH = ownerPath;

  const { Storage } = require('../dist/storage');
  const { config } = require('../dist/config');
  config.OWNER_STORAGE_PATH = ownerPath;
  config.ADMIN_PORT = 0;
  const storage = new Storage(path.join(root, `storage-${label}.json`));
  const admin = require('../dist/adminServer').startAdminServer(storage);
  if (!admin.listening) await new Promise((resolve) => admin.once('listening', resolve));
  const adminUrl = `http://127.0.0.1:${admin.address().port}`;

  // Warm the gateway's route cache so the first messages are not measuring a
  // cold cache instead of the thing under test.
  await fetch(`${adminUrl}/webhooks/meta/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metaPayload(`${label}-warmup`, '15559990000', 'no trigger here')),
  });
  await sleep(1_500);

  const sentAt = new Map(); // messageId -> webhook POST timestamp
  const post = async (messageId, from, body) => {
    sentAt.set(messageId, Date.now());
    const res = await fetch(`${adminUrl}/webhooks/meta/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metaPayload(messageId, from, body)),
    });
    assert.equal(res.status, 200);
  };

  // Take the noisy client offline for the outage window, exactly as a
  // restarting container does: stop listening (connections are refused),
  // then come back on the same port.
  if (recoverAfterMs > 0) {
    const noisyPort = noisy.server.address().port;
    await new Promise((resolve) => noisy.server.close(resolve));
    setTimeout(() => {
      noisy.server.listen(noisyPort, '127.0.0.1', () => { noisy.state.recoveredAt = Date.now(); });
    }, recoverAfterMs);
  }

  const startedAt = Date.now();
  const quietIds = [];
  const posts = [];

  // The noisy campaign floods; the quiet campaign's handful of messages are
  // spread through the flood, so each one lands while the gateway is busy.
  for (let i = 0; i < NOISY_MESSAGES; i += 1) {
    posts.push(post(`${label}-noisy-${i}`, `1555100${String(1000 + i)}`, NOISY_TRIGGER));
    if (i > 0 && i % Math.floor(NOISY_MESSAGES / QUIET_MESSAGES) === 0 && quietIds.length < QUIET_MESSAGES) {
      const quietId = `${label}-quiet-${quietIds.length}`;
      quietIds.push(quietId);
      posts.push(post(quietId, `1555200${String(2000 + quietIds.length)}`, QUIET_TRIGGER));
    }
  }
  await Promise.all(posts);

  // Wait for the gateway to drain, or give up after a generous window.
  const deadline = Date.now() + (recoverAfterMs ? 360_000 : 120_000);
  while (Date.now() < deadline) {
    const routed = quietIds.filter((id) => forwardLog.has(id)).length;
    const noisyRouted = noisy.state.forwards;
    if (routed === quietIds.length && noisyRouted >= NOISY_MESSAGES) break;
    await sleep(100);
  }
  const drainedMs = Date.now() - startedAt;

  const quietLatencies = quietIds
    .filter((id) => forwardLog.has(id))
    .map((id) => forwardLog.get(id) - sentAt.get(id))
    .sort((a, b) => a - b);

  const result = {
    label,
    noisyPendingDelayMs,
    noisyClearDelayMs: noisy.state.clearDelayMs,
    quietRouted: quietLatencies.length,
    quietTotal: quietIds.length,
    quietP50: percentile(quietLatencies, 50),
    quietP95: percentile(quietLatencies, 95),
    quietMax: quietLatencies[quietLatencies.length - 1] ?? 0,
    noisyRouted: noisy.state.forwards,
    noisyTotal: NOISY_MESSAGES,
    drainedMs,
    pendingCallsOnNoisy: noisy.state.pendingCalls,
    clearCallsOnNoisy: noisy.state.clearCalls,
    recoverAfterMs,
  };

  admin.closeAllConnections();
  await close(admin);
  await Promise.all(clients.map((c) => close(c.server)));
  return result;
}

const SCENARIOS = [
  // [label, pending-check delay, clear-pending delay (undefined = same as pending)]
  ['baseline', 0, undefined],
  ['slow-2s', 2_000, undefined],
  ['timeout-5s', 5_000, undefined],
  // Same failing pending check, but this client still answers clear-pending
  // quickly. Isolates whether the blocking comes from the blind
  // clear-pending handover step specifically.
  ['timeout-5s-fastclear', 5_000, 200],
  // The real-world case: a client is unreachable for 60s (a redeploy or a
  // crash-restart) and then recovers. With a short retry budget the quiet
  // campaign's messages are abandoned before it comes back.
  ['outage-60s-then-recovers', 0, undefined, 60_000],
];

// Each scenario runs in its OWN child process. startAdminServer leaves
// uncleared setInterval timers (route-cache refresh, inbox drainers) and
// module-level singletons behind, so a second scenario in the same process
// would be polluted by the first one's still-running gateway.
async function runAsChild() {
  const { spawn } = require('node:child_process');
  console.log(`Gateway noisy-vs-quiet test: ${BYSTANDER_COUNT + 2} clients on one shared Meta number (production has 10).`);
  console.log(`Noisy campaign fires ${NOISY_MESSAGES} messages; the quiet campaign's ${QUIET_MESSAGES} messages are spread through that flood.`);
  console.log('Measured: webhook POST -> forwarded to the quiet campaign\'s own client.');
  console.log('Each scenario runs in its own process for full isolation.\n');

  const results = [];
  for (const [label, delay, clearDelay, recoverAfter] of SCENARIOS) {
    console.log(`--- scenario: ${label} (noisy client answers pending checks in ${delay}ms) ---`);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [__filename, `--scenario=${label}`, `--delay=${delay}`, ...(clearDelay === undefined ? [] : [`--clearDelay=${clearDelay}`]), ...(recoverAfter ? [`--recoverAfter=${recoverAfter}`] : [])], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        const line = stdout.split('\n').find((l) => l.startsWith('RESULT_JSON:'));
        if (!line) return reject(new Error(`scenario ${label} exited ${code} without a result`));
        resolve(JSON.parse(line.slice('RESULT_JSON:'.length)));
      });
    });
    results.push(result);
    console.log(`  quiet routed: ${result.quietRouted}/${result.quietTotal}   noisy routed: ${result.noisyRouted}/${result.noisyTotal}`);
    console.log(`  quiet latency (webhook -> forwarded): p50=${result.quietP50}ms p95=${result.quietP95}ms max=${result.quietMax}ms`);
    console.log(`  whole batch drained in: ${(result.drainedMs / 1000).toFixed(1)}s   pending-checks made to the noisy client: ${result.pendingCallsOnNoisy}\n`);
  }

  console.log('=== summary ===');
  for (const r of results) {
    console.log(`${r.label.padEnd(12)} quiet p50=${String(r.quietP50).padStart(6)}ms  p95=${String(r.quietP95).padStart(6)}ms  max=${String(r.quietMax).padStart(6)}ms  routed ${r.quietRouted}/${r.quietTotal}  drained ${(r.drainedMs / 1000).toFixed(1)}s`);
  }

  const allQuietRouted = results.every((r) => r.quietRouted === r.quietTotal);
  console.log(`\nQuiet campaign delivered in every scenario: ${allQuietRouted ? 'YES' : 'NO'}`);
  if (!allQuietRouted) process.exitCode = 1;
  console.log('\nDone.');
}

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v];
}));

const main = argv.scenario
  ? (async () => {
      const result = await runScenario(argv.scenario, Number(argv.delay), argv.clearDelay === undefined ? undefined : Number(argv.clearDelay), argv.recoverAfter === undefined ? 0 : Number(argv.recoverAfter));
      console.log('RESULT_JSON:' + JSON.stringify(result));
    })()
  : runAsChild();

main.then(
  () => setTimeout(() => process.exit(process.exitCode ?? 0), 200),
  (error) => { console.error(error); setTimeout(() => process.exit(1), 200); },
);
