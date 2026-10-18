#!/usr/bin/env node
/**
 * PEAK HARNESS - three campaigns on ONE shared Meta number, the whole system, local only (nothing leaves the machine).
 *
 *   node scripts/measure-peak-3campaigns.js --dist dist --label NAME [--preset target|severe|catastrophe] [--scale 0.1] [options]
 *
 * What is real: the gateway process and every client process (dist/index.js), PostgreSQL (local test server, one schema per client),
 * the real campaign engine, outbox, inbox, status queue and gateway routing/fan-out. What is simulated:
 *   - Meta (scripts/lib/fake-meta-server.js): ONE server for the whole number - 80 msg/s limit (429), text/media latency, 5xx,
 *     accepted-but-response-lost, and the DELIVERY STATUS webhooks (sent/delivered/read/failed, duplicates, slow tail) that Meta posts
 *     to the gateway. A file step waits for `delivered`, so the status path is on the critical path of every flow.
 *   - The gateway -> client hop goes through scripts/lib/peak-proxy.js: exact fan-out counts, true status lag, and per-client faults.
 *   - Participants (this process): think time, abandon / drop-off, and the noisy behaviours below.
 *
 * Fleet: 3 campaign clients (A, B = big, C = small) + `--clients` minus 3 idle clients, all on the same number (production: ~11-15).
 * Flows: ~10 outbound messages each, part of them images, two button questions (the participant answers each).
 *
 * Arrival (per campaign): `peak` triggers inside `--peak-seconds` (front-loaded), the rest spread over `--tail-seconds`
 * (the real 18h is COMPRESSED - the tail here is far denser than production).
 *
 * Options (all optional; --preset sets defaults, an explicit flag always wins)
 *   --big-n 1000 --big-peak 100 --small-n 300 --small-peak 30 --peak-seconds 120 --peak-shape front|burst|uniform --tail-seconds 1800
 *   --scale F             multiply every participant count and every duration (quick smoke: 0.1)
 *   --clients 15 --mps 80 --think-ms 4000 --bot-delay 250 --abandon 0.25 --drop2 0.2
 *   --same-switch P       participant switches to a SECOND campaign on the SAME client (A->D, B->E) mid-flow
 *   --crossover P --impatient P --double-click P --dup-webhooks P     noisy participants (excluded from strict loss accounting)
 *   --drain-wait SECONDS  after the flows end, wait this long for the gateway status queue to drain before collecting (default 180)
 *   --lost-resp P --base-5xx P   accepted-but-response-lost / 5xx probability per message ATTEMPT; the decision is a hash of (seed, message identity, attempt), so every run injects the same faults into the same messages
 *   --client-max-senders N   sets META_MAX_CONCURRENT_SENDERS on every CLIENT process (not the gateway); 0 = leave unset (product default 50)
 *   --gateway-pool-max N     sets INBOX_DB_POOL_MAX on the GATEWAY process only (1..100); 0 = leave unset (product default 10)
 *   --status-batch off|http|http+journal   sets META_STATUS_BATCH on the GATEWAY (default off = today's behaviour); --status-batch-max N sets META_STATUS_BATCH_MAX
 *   --pg-trace               measurement-only preload wrapper around pg pool/query/connect; emits bounded @@PG summaries (off by default)
 *   --reply-after-delivered  participants wait for the simulator's delivered delay before replying (legacy mode replies after send is observed)
 *   --file-poll-ms N      sets FILE_DELIVERY_POLL_INTERVAL_MS on every CLIENT (0 = unset = product default 300)
 *   --reject-interactive P   share of question messages (buttons) answered 429 on every attempt (identity-keyed) -> the product falls back to a numbered TEXT question
 *   --quiz-n N --quiz-peak N   the 4th campaign: a quiz with an AUDIO clip (m,a,q,m) on its own client (default 60 / 15; 0 disables)
 *   --gateway-trace       GATEWAY_TRACE=1 on the gateway: every stage of a message's life inside the gateway, stamped with the time of the event IN the gateway process;
 *                         writes docs/results-data/peak-<label>-gt.jsonl (+ -msgs.json). Analyse with: node scripts/lib/analyze-gateway-trace.js <label>
 *   --text-ms 150 --media-ms 900 --delivered-ms 1500 --delivered-image-ms 2500 --read-frac 0.6 --status-tail 0.03 --status-dup 0.05 --failed-status 0.005
 *   --history H --seed-conversations M                                 gateway inbox history never pruned / expired conversations per client
 *   --fault LIST          comma separated kind@S[:a[:b[:c]]]  (S = seconds after start, after --scale)
 *        client-down@S:D:SEL   kill-client@S:SEL   term-client@S:SEL      SEL = A|B|C|idle0|idle1|...|all
 *        kill-gateway@S   term-gateway@S   db-outage@S:D
 *        proxy-slow@S:D:MS:SEL   proxy-hang@S:D:SEL   proxy-flaky@S:D:RATE:SEL
 *        meta-slow@S:D:FACTOR   meta-errors@S:D:RATE   meta-blackout@S:D   meta-429@S:D:MPS   meta-lost@S:D:RATE
 *        status-delay@S:D:FACTOR   status-loss@S:D
 *   --gateway-prof        write a V8 CPU profile of the gateway process to docs/results-data/peak-<label>-gateway-prof/ (analyse: node scripts/lib/summarize-cpuprofile.js <file>)
 *   --dump-lines          write every log line of every process to docs/results-data/peak-<label>-lines.log (debugging, large)
 *   --timeout SECONDS     max wait after the last trigger (default 1200)     --seed N
 *   --slo-first-p99 5000 --slo-reply-p99 5000 --slo-gap-text-p99 3000 --slo-gap-image-p99 15000 --slo-complete-p99 120000
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { Pool } = require('pg');
const { inboxTestUrl, assertInboxTestDb, ensureInboxTestDb } = require('./inbox-test-db');
const { preflight, resultsPath } = require('./measure-preflight');
const { distinctStepCount, duplicateGroups, classifyAudioStepSends } = require('./lib/peak-send-grouping');
const { analyseExpectedDelivery, classifySwitchMessages, summarizeResponseLatencies, summarizeGapLatencies, auditDeliveryByWamid, selfTestHarnessAnalysis } = require('./lib/peak-harness-analysis');
const det = require('./lib/detrand');

// ------------------------------------------------------------------------------------------------ options
const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const raw = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const PRESETS = {
  target: { crossover: 0.1, 'same-switch': 0.1 },
  // fixed-fault scenario for duplicate / reorder analysis: smaller, with frequent accepted-but-response-lost and 5xx, all keyed by message identity
  dupcheck: { 'big-n': 300, 'big-peak': 40, 'small-n': 100, 'small-peak': 15, 'peak-seconds': 60, 'tail-seconds': 400, crossover: 0.1, 'same-switch': 0.1, 'lost-resp': 0.02, 'base-5xx': 0.01 },
  burst: { 'big-n': 400, 'big-peak': 150, 'small-n': 100, 'small-peak': 40, 'peak-seconds': 10, 'peak-shape': 'burst', 'tail-seconds': 300, crossover: 0.1, 'same-switch': 0.1 },
  severe: { 'big-peak': 200, 'peak-seconds': 60, crossover: 0.05, 'same-switch': 0.05, impatient: 0.1, 'double-click': 0.05, 'dup-webhooks': 0.05, abandon: 0.3, history: 5000, 'seed-conversations': 2000, 'status-tail': 0.06,
    fault: 'proxy-slow@60:120:1500:idle0,client-down@240:75:idle1,meta-slow@120:60:4,meta-errors@300:45:0.1,status-delay@180:90:6,meta-429@360:40:15' },
  catastrophe: { 'big-peak': 250, 'small-peak': 60, 'peak-seconds': 45, 'peak-shape': 'burst', crossover: 0.08, 'same-switch': 0.1, impatient: 0.15, 'double-click': 0.1, 'dup-webhooks': 0.1, abandon: 0.35, history: 10000, 'seed-conversations': 5000, 'status-tail': 0.1,
    fault: 'client-down@30:900:idle2,proxy-slow@60:120:2500:idle0,proxy-hang@150:30:idle1,term-client@170:A,meta-slow@120:60:5,status-loss@100:40,kill-gateway@200,kill-client@260:B,meta-errors@300:45:0.15,status-delay@330:90:8,meta-429@400:40:10,meta-blackout@460:15,db-outage@520:20' },
};
const presetName = raw('preset') || 'target';
if (!PRESETS[presetName]) { console.error('unknown preset ' + presetName); process.exit(2); }
// CALIBRATION PROFILES: parameters measured from a real launch log (scripts/calibrate-from-launch-log.js), applied under any explicit flag.
//   focus-real = the Focus launch of 2026-10-17/18 (406 participants, FULL client log): button answers took a median 13.9s (lognormal sigma 0.85),
//   `delivered`/`read` arrived a median ~0.35s after `sent` (93% of messages were read), 22% never answered the first question and a further ~13% left
//   before the 3rd. Send latencies: media 3000ms reproduces the real 3.1s first response; text 1600ms reproduces the real 2.2s answer->first message (p10 1.9s, p90 2.7s).
const PROFILES = {
  'focus-real': { 'think-ms': 13900, 'think-sigma': 0.85, 'think-max': 180000, 'text-ms': 1600, 'media-ms': 3000, 'delivered-ms': 350, 'delivered-image-ms': 600, 'read-frac': 0.93, abandon: 0.22, drop2: 0.13, 'status-tail': 0.005, 'status-dup': 0.05 },
};
const profileName = raw('profile') || '';
if (profileName && !PROFILES[profileName]) { console.error('unknown profile ' + profileName); process.exit(2); }
const profile = PROFILES[profileName] || {};
const opt = (n, d) => (has(n) ? raw(n) : profile[n] !== undefined ? String(profile[n]) : PRESETS[presetName][n] !== undefined ? String(PRESETS[presetName][n]) : String(d));
const num = (n, d) => Number(opt(n, d));
const SCALE = num('scale', 1);
const sc = (v) => Math.max(1, Math.round(v * SCALE));
const O = {
  bigN: sc(num('big-n', 1000)), bigPeak: sc(num('big-peak', 100)), smallN: sc(num('small-n', 300)), smallPeak: sc(num('small-peak', 30)),
  peakS: Math.max(5, num('peak-seconds', 120) * Math.max(SCALE, 0.25)), peakShape: opt('peak-shape', 'front'), tailS: Math.max(10, num('tail-seconds', 1800) * SCALE),
  clients: num('clients', 15), mps: num('mps', 80), thinkMs: num('think-ms', 4000), thinkSigma: num('think-sigma', 0.6), thinkMax: num('think-max', 60000), botDelay: num('bot-delay', 250), abandon: num('abandon', 0.25), drop2: num('drop2', 0.2),
  crossover: num('crossover', 0), sameSwitch: num('same-switch', 0), impatient: num('impatient', 0), doubleClick: num('double-click', 0), dupWebhooks: num('dup-webhooks', 0),
  gatewayTrace: has('gateway-trace'), clientMaxSenders: num('client-max-senders', 0), filePollMs: num('file-poll-ms', 0), rejectInteractive: num('reject-interactive', 0), quizN: sc(num('quiz-n', 60)), quizPeak: sc(num('quiz-peak', 15)), statusBatch: opt('status-batch', 'off'), statusBatchMax: num('status-batch-max', 0),
  lostResp: num('lost-resp', 0.0005), base5xx: num('base-5xx', 0),
  gatewayPoolMax: num('gateway-pool-max', 0), pgTrace: has('pg-trace'), replyAfterDelivered: has('reply-after-delivered'),
  textMs: num('text-ms', 150), mediaMs: num('media-ms', 900), deliveredMs: num('delivered-ms', 1500), deliveredImageMs: num('delivered-image-ms', 2500), readFrac: num('read-frac', 0.6),
  statusTail: num('status-tail', 0.03), statusDup: num('status-dup', 0.05), failedStatus: num('failed-status', 0.005),
  history: num('history', 0), seedConv: num('seed-conversations', 0), timeoutS: num('timeout', 1200), seed: num('seed', 4242),
  fault: opt('fault', ''),
  campaignFile: raw('campaign-file') || '',
  realN: sc(num('real-n', 60)), realPeak: sc(num('real-peak', 40)),
  slo: { first: num('slo-first-p99', 5000), reply: num('slo-reply-p99', 5000), gapText: num('slo-gap-text-p99', 3000), gapImage: num('slo-gap-image-p99', 15000), complete: num('slo-complete-p99', 120000) },
};
// faults are specified in "real" seconds of a full-size run; with --scale they shrink with the run
const FAULT_SCALE = Math.max(SCALE, 0.25);
const dist = path.resolve(raw('dist') || 'dist');
const label = raw('label') || `peak-${presetName}`;
if (!fs.existsSync(path.join(dist, 'index.js'))) { console.error('--dist must contain index.js (run npm run build)'); process.exit(2); }
if (O.clients < 5) { console.error('--clients must be >= 5 (4 campaign clients + at least one idle)'); process.exit(2); }
if (O.gatewayPoolMax && (O.gatewayPoolMax < 1 || O.gatewayPoolMax > 100 || !Number.isInteger(O.gatewayPoolMax))) { console.error('--gateway-pool-max must be an integer from 1 to 100'); process.exit(2); }

const RUN = `pk${Date.now().toString(36)}`;
const PN = 'shared-phone-id';
const pre = preflight();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maxOf = (a) => { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; };   // Math.max(...a) throws RangeError above ~120k elements
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(0); };
const stat = (a) => ({ n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: a.length ? Math.round(maxOf(a)) : null, mean: a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null });
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fileSha256 = (p) => { try { return sha256(fs.readFileSync(p)); } catch { return null; } };
let seedState = O.seed >>> 0;
const rnd = () => { seedState |= 0; seedState = (seedState + 0x6D2B79F5) | 0; let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const think = (p) => Math.min(O.thinkMax, Math.max(800, O.thinkMs * Math.exp(O.thinkSigma * det.gauss(O.seed, 'think', p.phone, p.qSeen))));   // a function of WHO and WHICH question, not of call order
const preload = path.join(__dirname, 'lib', 'load-preload.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${RUN}-`));
const baseUrl = new URL(inboxTestUrl());
const wantsDbOutage = /db-outage/.test(O.fault);
const gwDbName = wantsDbOutage ? 'flowsbiz_inbox_test_gw' : baseUrl.pathname.slice(1);
const gwInboxUrl = (() => { const u = new URL(baseUrl); u.pathname = '/' + gwDbName; return u.toString(); })();
const schemaUrl = (schema) => { const u = new URL(baseUrl); u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };

// ------------------------------------------------------------------------------------------------ campaigns
/**
 * REAL-CAMPAIGN MODE (--campaign-file): instead of the synthetic spec strings below, load the
 * production campaign objects exactly as they are stored (kinds, nextStepId graph, per-step
 * delayMs, score rules, contact card, files) and run THEM through the real engine. Every variant
 * lives on ONE client, the way a real customer's links do. Only two things are changed: a
 * [KEY#n] marker is appended to every text the flow can send (the harness identifies messages by
 * it), and fileIds are rewritten to files created here with the SAME byte sizes as production.
 */
const REAL = O.campaignFile ? JSON.parse(fs.readFileSync(O.campaignFile, 'utf8')) : null;
/**
 * The order a participant actually WALKS a flow is the nextStepId graph, not the array order the
 * steps happen to be stored in - this campaign's array order is 1..18 but its real path is
 * 1..13, 18, 14, 15, 17, 16. Markers (and therefore every "is this message in order / did the
 * participant stop early" check in this harness) must follow the walk, so they are numbered by
 * traversal position here. Branches are followed through the first option / first result rule;
 * if a flow's branches ever diverged to different steps this would need a per-participant path,
 * which is why the walk is asserted to cover every step before a run is accepted.
 */
function flowWalkOrder(flow) {
  const byId = new Map(flow.map((st) => [st.id, st]));
  const order = []; const seen = new Set();
  let cur = flow[0];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id); order.push(flow.indexOf(cur));
    const next = cur.nextStepId
      || (Array.isArray(cur.options) && cur.options[0] && cur.options[0].nextStepId)
      || (Array.isArray(cur.resultRules) && cur.resultRules[0] && cur.resultRules[0].nextStepId)
      || cur.fallbackNextStepId;
    cur = next ? byId.get(next) : null;
  }
  return order;
}
const CAMPS = REAL ? REAL.campaigns.map((rc, i) => {
  const flow = (rc.data.conversation || {}).decisionFlow || [];
  const walk = flowWalkOrder(flow);
  if (walk.length !== flow.length) {
    console.error(`campaign ${rc.id}: the nextStepId walk reaches ${walk.length} of ${flow.length} steps - unreachable or branching steps are not modelled`);
    process.exit(2);
  }
  const toks = walk.map((ai) => flow[ai]).map((st) => (st.kind === 'question' || st.kind === 'score_question' ? 'q' : st.fileId ? 'i' : 'm'));
  const per = Math.max(1, Math.round(O.realN / REAL.campaigns.length));
  const perPeak = Math.max(1, Math.round(O.realPeak / REAL.campaigns.length));
  return { key: String.fromCharCode(65 + i), idx: 0, digit: String(i + 1), n: per, peak: perPeak,
    phrase: rc.trigger_phrase, spec: toks.join(','), real: rc.data, walk };
}) : [
  { key: 'A', idx: 0, digit: '1', n: O.bigN, peak: O.bigPeak, phrase: 'alpha promo', spec: 'm,i,m,q,m,i,m,q,m,i' },     // 10 outbound, 3 images
  { key: 'B', idx: 1, digit: '2', n: O.bigN, peak: O.bigPeak, phrase: 'bravo promo', spec: 'm,m,i,q,i,m,m,q,m,m' },     // 10 outbound, 2 images
  { key: 'C', idx: 2, digit: '3', n: O.smallN, peak: O.smallPeak, phrase: 'charlie promo', spec: 'm,i,q,m,m,q,m,m' },   //  8 outbound, 1 image
  { key: 'Q', idx: 3, digit: '6', n: O.quizN, peak: O.quizPeak, phrase: 'quiz promo', spec: 'm,a,q,m' },                      //  4 outbound: intro, AUDIO clip, the guess (buttons), result
];
const EXTRA = REAL ? [] : [
  { key: 'D', idx: 0, digit: '4', n: 0, peak: 0, phrase: 'delta promo', spec: 'm,i,m,q,m,m' },    // 2nd campaign on A's client
  { key: 'E', idx: 1, digit: '5', n: 0, peak: 0, phrase: 'echo promo', spec: 'm,m,i,q,m,m' },     // 2nd campaign on B's client
];
for (const c of [...CAMPS, ...EXTRA]) { c.toks = c.spec.split(','); c.qpos = c.toks.map((t, i) => (t === 'q' ? i : -1)).filter((i) => i >= 0); c.total = c.toks.length; c.images = c.toks.filter((t) => t === 'i').length; c.audios = c.toks.filter((t) => t === 'a').length; }
const prefixOwner = Object.fromEntries(CAMPS.map((c) => [`9725${c.digit}`, `c${c.idx}`]));
// how many of the fleet's clients actually carry a campaign (REAL mode puts every variant on ONE client)
const CAMP_CLIENT_COUNT = new Set(CAMPS.map((c) => c.idx)).size;
const campsForClient = (i) => CAMPS.filter((c) => c.idx === i);
function makeCampaign(c, fileId, audioFileId) {
  const steps = c.toks.map((tk, i) => {
    const id = `s${i + 1}`; const next = i < c.toks.length - 1 ? `s${i + 2}` : undefined; const text = `campaign ${c.key} step ${i + 1} [${c.key}#${i + 1}]`;
    if (tk === 'q') return { id, kind: 'question', presentation: 'buttons', text, options: [{ id: `go${i + 1}`, text: `כן ${i + 1}`, ...(next ? { nextStepId: next } : {}) }], timeoutMode: 'stop' };
    if (tk === 'i') return { id, kind: 'message', text, fileId, ...(next ? { nextStepId: next } : {}) };
    if (tk === 'a') return { id, kind: 'message', text, fileId: audioFileId, ...(next ? { nextStepId: next } : {}) };   // an audio clip: WhatsApp audio has no caption, so the product sends this text as its own message just before the clip
    return { id, kind: 'message', text, ...(next ? { nextStepId: next } : {}) };
  });
  return { id: `camp-${c.key}`, name: `campaign ${c.key}`, triggerType: 1, triggerPhrase: c.phrase, suffix: ' - Bot', active: true, runtimeStatus: 'active',
    conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], sendContactCard: false, decisionTimeoutMinutes: 30, decisionTimeoutMode: 'message', decisionTimeoutText: '',
      invalidReplyText: 'invalid reply', flowRecoveryText: 'flow interrupted', humanHandoffEnabled: false, decisionFlow: steps } };
}
/** The production campaign, with markers appended to every text it can send and fileIds remapped. */
function makeRealCampaign(c, fileIdMap) {
  const src = JSON.parse(JSON.stringify(c.real));
  const conv = src.conversation || {};
  const posOf = new Map(c.walk.map((arrayIndex, position) => [arrayIndex, position + 1]));
  const flow = (conv.decisionFlow || []).map((st, i) => {
    const n = posOf.get(i);                                  // traversal position, not array index
    const tag = ` [${c.key}#${n}]`;
    const mark = (v) => (typeof v === 'string' && v.trim() ? `${v}${tag}` : v);
    const step = { ...st };
    step.text = typeof step.text === 'string' && step.text.trim() ? `${step.text}${tag}` : `step ${n}${tag}`;
    if (step.fileId) step.fileId = fileIdMap.get(step.fileId) || step.fileId;
    if (typeof step.fallbackText === 'string') step.fallbackText = mark(step.fallbackText);
    if (typeof step.timeoutText === 'string') step.timeoutText = mark(step.timeoutText);
    if (Array.isArray(step.resultRules)) step.resultRules = step.resultRules.map((r) => ({ ...r, endText: mark(r.endText) }));
    if (Array.isArray(step.options)) step.options = step.options.map((o) => ({ ...o, endText: mark(o.endText) }));
    return step;
  });
  return { ...src, id: `camp-${c.key}`, name: `${src.name || c.key} [${c.key}]`, triggerType: 1, triggerPhrase: c.phrase,
    suffix: ' - Bot', active: true, runtimeStatus: 'active', conversation: { ...conv, decisionFlow: flow } };
}
function makeIdleCampaign(i) {
  return { id: `camp-idle${i}`, name: `idle ${i}`, triggerType: 1, triggerPhrase: `idle promo ${i}`, suffix: ' - Bot', active: true, runtimeStatus: 'active',
    conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], sendContactCard: false, decisionTimeoutMinutes: 30, decisionTimeoutMode: 'message', decisionTimeoutText: '',
      invalidReplyText: 'x', flowRecoveryText: 'x', humanHandoffEnabled: false, decisionFlow: [{ id: 'a', kind: 'message', text: 'hello', nextStepId: undefined }] } };
}
// a ~40KB stand-in for a 10-second song clip (the product accepts audio uploads up to 2MB; Meta sees it as audio/mpeg)
const AUDIO = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40000, 9)]);
// 1x1 PNG padded to ~30KB so the upload is not trivially small
const PNG = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), Buffer.alloc(30000, 7)]);

// ------------------------------------------------------------------------------------------------ process plumbing
const events = { lag: { gateway: [], client: [] }, logs: {}, alerts: {}, gwLines: [], harnessLag: null };
const bump = (k) => { events.logs[k] = (events.logs[k] || 0) + 1; };
const LOG_PATTERNS = [
  ['fileDeliveryWaitTimeout', /FILE_DELIVERY_WAIT_TIMEOUT/], ['sendRetry', /\[SEND_RETRY\]/], ['sendFail', /\[SEND_FAIL\]/], ['outboxUncertain', /uncertain/i], ['staleTrigger', /stale trigger ignored/],
  ['gatewayClientSkipped', /META_GATEWAY_CLIENT_SKIPPED/], ['gatewayPendingCheckFailed', /META_GATEWAY_PENDING_CHECK_FAILED/], ['gatewayClearPendingFailed', /META_GATEWAY_CLEAR_PENDING_FAILED/],
  ['gatewayInboxRetry', /META_GATEWAY_INBOX_RETRY/], ['gatewayInboxFailed', /META_GATEWAY_INBOX_FAILED/], ['clientInboxRetry', /META_CLIENT_INBOX_RETRY/], ['clientInboxFailed', /META_CLIENT_INBOX_FAILED/],
  ['statusForwardRetry', /META_STATUS_FORWARD_RETRY/], ['statusForwardExpired', /META_STATUS_DRAIN_FAILED/], ['inboxStoreFailed', /INBOX_STORE_FAILED/], ['inboxAmbiguous', /INBOX_AMBIGUOUS_REVIEW/],
  ['gatewayRoutingRetry', /META_GATEWAY_ROUTING_RETRY/], ['gatewayAmbiguous', /META_GATEWAY_AMBIGUOUS/], ['persistFailed', /PERSIST_FAILED/], ['unhandled', /UnhandledPromiseRejection|Uncaught/],
  ['metaApi429', /Meta message failed \(429\)/], ['deliveryFailedTracked', /\[META_DELIVERY_FAILED\]/], ['gatewayForwardRetry', /META_GATEWAY_RETRY\]/],
];
const routeMs = []; const metaFaults = []; const gtEvents = []; const pgTrace = []; const msgInfo = new Map();   // @@GT lines: {e, t = event time in the gateway, a = arrival time here}; msgInfo: message id -> {kind, camp}
const deliveredWamids = new Set(); const failedWamids = new Set(); const pendingReplies = new Map();
const ackAt = new Map(), routedAt = new Map(), pickupAt = new Map();   // message id -> ms: gateway answered 200 / gateway forwarded it to the client / the client's handler started it (log-line arrival time in the harness)
const procs = [];
const dumpFile = has('dump-lines') ? resultsPath(`peak-${raw('label') || 'run'}-lines.log`) : null; if (dumpFile) fs.writeFileSync(dumpFile, '');
const pgTraceFile = has('pg-trace') ? resultsPath(`peak-${raw('label') || 'run'}-pgtrace.jsonl`) : null; if (pgTraceFile) fs.writeFileSync(pgTraceFile, '');
const pgTraceLimit = 50000; let pgTraceDropped = 0;
function onLine(name, line, kind) {
  if (dumpFile && !line.startsWith('@@LAG') && !line.startsWith('@@PX ') && !line.startsWith('@@META ')) fs.appendFileSync(dumpFile, `${Date.now()} [${name}] ${line}
`);
  if (kind === 'meta') {
    if (line.startsWith('@@SEND ')) { try { onMetaSend(JSON.parse(line.slice(7))); } catch { /* ignore */ } return; }
    if (line.startsWith('@@DELIVER ')) { try { onFakeDelivered(JSON.parse(line.slice(10))); } catch { /* ignore */ } return; }
    if (line.startsWith('@@TERMINAL ')) { try { const j = JSON.parse(line.slice(11)); if (j.status === 'failed') failedWamids.add(j.id); } catch { /* ignore */ } return; }
    if (line.startsWith('@@FAULT ')) { try { metaFaults.push(JSON.parse(line.slice(8))); } catch { /* ignore */ } return; }
    if (line.startsWith('@@METADUMP ')) { metaDump = JSON.parse(line.slice(11)); return; }
    if (line.startsWith('@@META ')) { try { lastMeta = JSON.parse(line.slice(7)); } catch { /* */ } return; }
    return;
  }
  if (kind === 'proxy') {
    if (line.startsWith('@@PXDUMP ')) { proxyDump = JSON.parse(line.slice(9)); return; }
    if (line.startsWith('@@PX ')) { try { lastPx = JSON.parse(line.slice(5)); } catch { /* */ } return; }
    return;
  }
  if (kind === 'gateway' && line.startsWith('@@GT ')) { const a = Date.now(); try { const ev = JSON.parse(line.slice(5)); ev.a = a; gtEvents.push(ev); } catch { /* ignore */ } return; }
  if (line.startsWith('@@PG ')) { try { const ev = JSON.parse(line.slice(5)); if (pgTrace.length < pgTraceLimit) { pgTrace.push(ev); if (pgTraceFile) fs.appendFileSync(pgTraceFile, JSON.stringify(ev) + '\n'); } else pgTraceDropped += 1; } catch { /* ignore */ } return; }
  if (kind === 'gateway' && line.startsWith('@@JW ')) { try { lastJW = JSON.parse(line.slice(5)); } catch { /* ignore */ } return; }
  if (kind === 'client' && line.startsWith('@@FL ')) { try { lastFL[name.replace(/b$/, '')] = JSON.parse(line.slice(5)); } catch { /* ignore */ } return; }
  if (line.startsWith('@@LAG ')) { const j = JSON.parse(line.slice(6)); events.lag[kind === 'gateway' ? 'gateway' : 'client'].push({ ...j, name }); return; }
  if (line.startsWith('@@')) return;
  for (const [k, re] of LOG_PATTERNS) if (re.test(line)) bump((kind === 'gateway' ? 'gw.' : 'cl.') + k);
  let m;
  if (kind === 'gateway' && (m = /\[META_GATEWAY_ROUTED\] (\S+) /.exec(line)) && !routedAt.has(m[1])) routedAt.set(m[1], Date.now());
  if (kind === 'client' && (m = /\[META_INBOUND\] (\S+) /.exec(line)) && !pickupAt.has(m[1])) pickupAt.set(m[1], Date.now());
  if (kind === 'gateway' && (m = /\[META_GATEWAY_ROUTED\].*route_ms=(\d+)/.exec(line))) routeMs.push(Number(m[1]));
  if ((m = /\[SYSTEM_ALERT_(SENT|THROTTLED|EMAIL_FAILED)\] (\S+)/.exec(line)) || (m = /\[SYSTEM_ALERT_(SENT)\] (\S+)/.exec(line))) events.alerts[m[2].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')] = (events.alerts[m[2]] || 0) + 1;
  if (/ERROR|FAILED|Unhandled|Uncaught/.test(line) && events.gwLines.length < 600) events.gwLines.push(`${new Date().toISOString().slice(11, 23)} [${name}] ${line.slice(0, 260)}`);
}
function launch(name, env, kind, cwd, scriptArgs, useDist = true, extraNodeArgs = []) {
  fs.mkdirSync(cwd, { recursive: true });
  const nodeArgs = useDist ? [...extraNodeArgs, '--require', preload, path.join(dist, 'index.js')] : scriptArgs;
  const child = spawn(process.execPath, nodeArgs, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const entry = { name, child, kind, env, cwd, exited: false };
  const buf = { out: '', err: '' };
  entry.readyPromise = new Promise((resolve) => { entry.resolveReady = resolve; });
  const feed = (k) => (d) => { buf[k] += d; let i; while ((i = buf[k].indexOf('\n')) >= 0) { const line = buf[k].slice(0, i); buf[k] = buf[k].slice(i + 1); onLine(name, line, kind); if ((/Admin dashboard/.test(line) && (kind === 'client' || kind === 'gateway')) || line.startsWith('@@READY')) entry.resolveReady(); } };
  child.stdout.on('data', feed('out')); child.stderr.on('data', feed('err'));
  child.on('exit', () => { entry.exited = true; });
  procs.push(entry); return entry;
}
const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function stopProc(entry, signal = 'SIGTERM', waitMs = 15000) {
  if (entry.exited) return;
  if (entry.kind === 'meta' || entry.kind === 'proxy') { entry.child.kill('SIGKILL'); await sleep(100); return; }
  if (signal === 'SIGTERM' && entry.child.connected) entry.child.send('SIGTERM'); else entry.child.kill(signal);   // Windows: graceful stop over IPC (see load-preload.js)
  const t0 = Date.now(); while (!entry.exited && Date.now() - t0 < waitMs) await sleep(50);
  if (!entry.exited) { entry.child.kill('SIGKILL'); await sleep(200); }
}
const lastFL = {};
let metaDump = null; let lastMeta = null; let proxyDump = null; let lastPx = null; let lastJW = null;
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });
const post = (port, pathname, body) => new Promise((resolve) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0)); req.setTimeout(30000, () => { req.destroy(); resolve(0); }); req.end(data);
});
const inboundPayload = (id, from, kind, body, btnId, btnTitle) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const message = kind === 'text' ? { from, id, timestamp: ts, type: 'text', text: { body } } : { from, id, timestamp: ts, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: btnId || 'go1', title: btnTitle || 'כן 1' } } };
  return { object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PN, display_phone_number: '15550001111' }, contacts: [{ profile: { name: 'P' }, wa_id: from }], messages: [message] } }] }] };
};

// ------------------------------------------------------------------------------------------------ participants
const participants = []; const byPhone = new Map(); let gwPort = 0;
const acked = new Set(); const postStats = { ok: 0, retried: 0, gaveUp: 0, dupPosted: 0 };
let msgSeq = 0;
// Meta re-delivers a webhook that was not answered 2xx (backoff 1s..8s, up to 3 minutes). Only acknowledged messages count as "lost" if they vanish.
async function deliver(id, payload, p) {
  const first = Date.now(); let wait = 1000;
  for (let attempt = 0; ; attempt++) {
    const st = await post(gwPort, '/webhooks/meta/whatsapp', payload);
    if (st === 200) { acked.add(id); if (!ackAt.has(id)) ackAt.set(id, Date.now()); postStats.ok += 1; if (attempt > 0) postStats.retried += 1; return true; }
    if (Date.now() - first > 180000) { postStats.gaveUp += 1; return false; }
    await sleep(wait); wait = Math.min(8000, wait * 2);
  }
}
async function postInbound(p, kind, body, btnId, causeKind, btnTitle, causeMeta = {}) {
  const id = `m-${RUN}-${++msgSeq}`; p.lastPostedId = id; msgInfo.set(id, { kind: causeKind || (kind === 'text' ? 'text' : 'other'), camp: p.cur.key, origin: p.camp.key, postStart: Date.now() });
  const causeId = causeKind ? `cause-${id}` : null;
  if (causeKind) p.causes.push({ id: causeId, t: Date.now(), kind: causeKind, camp: p.cur.key, expectedNextIdx: causeMeta.expectedNextIdx || 1 });
  const payload = inboundPayload(id, p.phone, kind, body, btnId, btnTitle);
  const ok = deliver(id, payload, p);
  p.msgN = (p.msgN || 0) + 1;
  if (det.unit(O.seed, 'dupwh', p.phone, p.msgN) < O.dupWebhooks) { postStats.dupPosted += 1; void sleep(50 + det.unit(O.seed, 'dupwhDelay', p.phone, p.msgN) * 450).then(() => post(gwPort, '/webhooks/meta/whatsapp', payload)); }   // Meta sent the very same message twice
  return ok;
}
function onFakeDelivered(j) {
  deliveredWamids.add(j.id);
  const pending = pendingReplies.get(j.id);
  if (!pending || pending.fired) return;
  pending.fired = true;
  void sleep(pending.delayMs).then(() => {
    if (failedWamids.has(j.id)) return;
    return pending.fn();
  });
}
function buildParticipants() {
  for (const c of CAMPS) {
    const times = [];
    const peakN = Math.min(c.peak, c.n);
    for (let i = 0; i < peakN; i++) {
      const u = rnd();
      times.push(O.peakShape === 'burst' ? u * 8 : O.peakShape === 'uniform' ? u * O.peakS : -(O.peakS / 3) * Math.log(1 - u * (1 - Math.exp(-3))));
    }
    for (let i = peakN; i < c.n; i++) times.push(O.peakS + rnd() * O.tailS);
    times.sort((a, b) => a - b);
    times.forEach((tS, k) => {
      const noisy = { crossover: rnd() < O.crossover, sameClient: rnd() < O.sameSwitch && c.key !== 'C', impatient: rnd() < O.impatient, doubleClick: rnd() < O.doubleClick };
      const p = { camp: c, cur: c, k, phone: `9725${c.digit}${String(1000000 + k)}`, atS: tS, phase: tS <= O.peakS + 30 ? 'peak' : 'tail', abandon: rnd() < O.abandon, drop2: rnd() < O.drop2, noisy, isNoisy: noisy.crossover || noisy.sameClient || noisy.impatient || noisy.doubleClick,
        sends: [], causes: [], qSeen: 0, trigPosted: 0, crossDone: false };
      participants.push(p); byPhone.set(p.phone, p);
    });
  }
}
function expectedSends(p) {
  const q = p.camp.qpos; if (p.abandon) return q[0] + 1; if (p.drop2) return q[1] + 1; return p.camp.total;
}
function switchTarget(p) {
  if (p.noisy.crossover) return CAMPS.find((c) => c.key === (p.camp.key === 'A' ? 'B' : 'A'));          // another client
  if (p.noisy.sameClient) return EXTRA.find((e) => e.idx === p.camp.idx) || null;                         // another campaign on the SAME client
  return null;
}
function onMetaSend(j) {
  const p = byPhone.get(j.to); if (!p) return;
  // camp = what the MESSAGE says it belongs to (marker [X#n] in its text); wantCamp = what the harness expects at that moment
  const expectedClient = `client${p.cur.idx}`;
  const actualSendingClient = j.sourceClient ? String(j.sourceClient).replace(/^client-(\d+)$/, 'client$1') : null;
  const causeCandidates = p.causes.filter((c) => c.t <= j.t && c.camp === j.camp && c.expectedNextIdx === j.idx);
  const linkedCause = causeCandidates.length === 1 ? causeCandidates[0] : null;
  p.sends.push({ t: j.t, type: j.type, idx: j.idx, camp: j.camp, wantCamp: p.cur.key, expectedClient, actualSendingClient, actualStoredClient: null, session: p.cur.key, causeId: linkedCause && linkedCause.id, causeLink: linkedCause ? 'stage-exact' : causeCandidates.length > 1 ? 'ambiguous' : 'unknown', key: j.key, attempt: j.attempt, prev: j.prev, lost: j.lost, id: j.id });
  if (p.sends.length === 1) {
    const target = switchTarget(p);
    if (target && !p.switched) {
      p.switched = { kind: p.noisy.crossover ? 'crossover' : 'sameClient', from: p.camp.key, to: target.key, at: 0 };
      void sleep(1000 + det.unit(O.seed, 'switchDelay', p.phone) * 5000).then(async () => { p.cur = target; p.qSeen = 0; p.switched.at = p.crossAt = Date.now(); await postInbound(p, 'text', target.phrase, null, 'crossover'); });
    }
    if (p.noisy.impatient) void sleep(1500).then(() => postInbound(p, 'text', 'שלום? יש כאן מישהו?', null, null)).then(() => sleep(1500)).then(() => postInbound(p, 'text', 'hello??', null, null));
  }
  const isQuestionStep = j.idx != null && j.camp === p.cur.key && p.cur.qpos.includes(j.idx - 1);
  if (j.type === 'text' && isQuestionStep) {   // the question was demoted from buttons to a numbered text list (429 on the buttons): answer the way a person does - by number, or by typing the option
    p.qSeen += 1; p.downgradedQuestions = (p.downgradedQuestions || 0) + 1;
    if (!p.switched) { if (p.abandon) return; if (p.drop2 && p.qSeen >= 2) return; }
    const byNumber = p.qSeen === 1 && det.hash32(p.phone) % 2 === 0;   // the number '1' only for a first question: the same text twice within 15s is dropped as a duplicate reply by design
    const reply = byNumber ? '1' : `כן ${j.idx}`; p.textAnswers = (p.textAnswers || 0) + 1;
    const answer = () => postInbound(p, 'text', reply, null, 'answer', null, { expectedNextIdx: j.idx + 1 });
    if (O.replyAfterDelivered) pendingReplies.set(j.id, { delayMs: think(p), fn: answer, fired: false, question: { participant: p.phone, camp: j.camp, idx: j.idx } });
    else void sleep(think(p)).then(answer);
    return;
  }
  if (j.type === 'interactive' && j.btn) {
    if (j.camp && j.camp !== p.cur.key) return;       // a question of a flow the participant has already left: not answered
    p.qSeen += 1;
    if (!p.switched) { if (p.abandon) return; if (p.drop2 && p.qSeen >= 2) return; }
    const btn = j.btn; const title = j.title;
    const answer = async () => {
      await postInbound(p, 'interactive', null, btn, 'answer', title, { expectedNextIdx: j.idx + 1 });
      if (p.noisy.doubleClick) { await sleep(800); await postInbound(p, 'interactive', null, btn, null, title); }
    };
    if (O.replyAfterDelivered) pendingReplies.set(j.id, { delayMs: think(p), fn: answer, fired: false, question: { participant: p.phone, camp: j.camp, idx: j.idx } });
    else void sleep(think(p)).then(answer);
  }
}

// ------------------------------------------------------------------------------------------------ main
(async () => {
  const harnessSelfTest = selfTestHarnessAnalysis();
  if (!harnessSelfTest.ok) throw new Error('peak harness analysis self-test failed: ' + JSON.stringify(harnessSelfTest.results));
  const hist = monitorEventLoopDelay({ resolution: 10 }); hist.enable();
  await ensureInboxTestDb();
  const admin = new Pool({ connectionString: inboxTestUrl(), max: 4 });
  const ident = await assertInboxTestDb(admin);
  const maxConn = Number((await admin.query('show max_connections')).rows[0].max_connections);
  if (O.clients * 14 > maxConn - 20) console.warn(`[warn] PostgreSQL max_connections=${maxConn}; ${O.clients} clients may exhaust it (each opens a storage pool and an inbox pool). Lower --clients if clients fail to start.`);
  if (gwDbName !== baseUrl.pathname.slice(1)) {
    if (!(await admin.query('select 1 from pg_database where datname = $1', [gwDbName])).rowCount) await admin.query(`create database ${gwDbName}`);
    await admin.query(`alter database ${gwDbName} with allow_connections true`);
  }
  const { migrateDatabase, createPostgresBackend } = require(path.join(dist, 'database'));
  const { Storage, emptyStorageData } = require(path.join(dist, 'storage'));
  buildParticipants();
  const totalTriggers = participants.length;
  console.log(`[${label}] preset=${presetName} scale=${SCALE} clients=${O.clients} participants=${totalTriggers} (${CAMPS.map((c) => c.key + ' ' + c.n).join(', ')}) peak/camp=${CAMPS.map((c) => c.peak).join('/')} in ${O.peakS}s${REAL ? ` REAL-CAMPAIGN(${O.campaignFile}) campaignClients=${CAMP_CLIENT_COUNT}` : ''} tail=${O.tailS}s fault="${O.fault}" db=${ident.db} max_connections=${maxConn} pgTrace=${O.pgTrace ? 'on' : 'off'} gatewayPool=${O.gatewayPoolMax || 'default(10)'}`);

  // ---- clients
  const clients = [];
  for (let i = 0; i < O.clients; i++) {
    const schema = `${RUN}_c${i}`; await admin.query(`create schema ${schema}`);
    const url = schemaUrl(schema); await migrateDatabase(url);
    const dir = path.join(tmp, `client${i}`); fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
    const backend = await createPostgresBackend(url); const snap = await backend.loadSnapshot();
    const st = new Storage(path.join(tmp, `c${i}-setup.json`), { initialData: snap ?? emptyStorageData(), backend });
    const mine = campsForClient(i);
    if (mine.length && REAL) {
      // every production file, recreated at its REAL byte size so the client does the same disk/upload work
      const fileIdMap = new Map();
      for (const rf of REAL.files) {
        const meta = rf.data || {};
        const size = Number(meta.size) || 1024;
        const name = String(meta.originalName || meta.filename || `${rf.id}.bin`);
        const ext = path.extname(name) || '.bin';
        const filename = `${rf.id}${ext}`;
        const head = /mp4|video/i.test(String(meta.mimeType || '')) ? Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42')]) : PNG.subarray(0, Math.min(PNG.length, size));
        fs.writeFileSync(path.join(dir, 'uploads', filename), Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 5)]));
        fileIdMap.set(rf.id, st.addUploadedFile({ originalName: name, filename, mimeType: meta.mimeType || 'application/octet-stream', size }).id);
      }
      for (const c of mine) st.addCampaign(makeRealCampaign(c, fileIdMap));
    } else if (mine.length) {
      fs.writeFileSync(path.join(dir, 'uploads', 'promo.png'), PNG);
      const f = st.addUploadedFile({ originalName: 'promo.png', filename: 'promo.png', mimeType: 'image/png', size: PNG.length });
      let audioId; if (mine.some((c) => c.audios)) { fs.writeFileSync(path.join(dir, 'uploads', 'quiz-Q2.mp3'), AUDIO); audioId = st.addUploadedFile({ originalName: 'quiz-Q2.mp3', filename: 'quiz-Q2.mp3', mimeType: 'audio/mpeg', size: AUDIO.length }).id; }
      for (const c of mine) st.addCampaign(makeCampaign(c, f.id, audioId));
      for (const x of EXTRA.filter((e) => e.idx === i)) st.addCampaign(makeCampaign(x, f.id));
    } else st.addCampaign(makeIdleCampaign(i));
    await st.flush(); await st.close();
    if (O.seedConv > 0) await admin.query(`insert into ${schema}.conversation_state(jid, kind, sender_phone, campaign_id, campaign_result_id, scheduled_at, data, updated_at)
        select 'whatsapp:9726' || lpad(g::text, 8, '0'), 'expired-decision', '9726' || lpad(g::text, 8, '0'), 'seed', 'old' || g, now() + interval '20 hours',
               jsonb_build_object('kind','expired-decision','senderJid','whatsapp:9726' || lpad(g::text, 8, '0'),'senderPhone','9726' || lpad(g::text, 8, '0'),'campaignId','seed','campaignResultId','old' || g,'stepId','x','timestamp',(extract(epoch from now())*1000)::bigint), now()
          from generate_series(1, $1) g`, [O.seedConv]);
    clients.push({ i, schema, url, port: await freePort(), proxyPort: await freePort(), token: `${RUN}-c${i}-owner`, dir });
  }

  // ---- fake Meta (one server), gateway port first because Meta posts statuses to it
  gwPort = await freePort();
  const metaPort = await freePort();
  const fm = launch('fakemeta', { FM_CONFIG: JSON.stringify({ port: metaPort, gatewayPort: gwPort, pn: PN, mps: O.mps, textMs: O.textMs, mediaMs: O.mediaMs, deliveredMedianMs: O.deliveredMs, deliveredMedianImageMs: O.deliveredImageMs, readFrac: O.readFrac, slowTailFrac: O.statusTail, dupStatusFrac: O.statusDup, failedFrac: O.failedStatus, lostResp: O.lostResp, base5xx: O.base5xx, rejectInteractive: O.rejectInteractive, seed: O.seed }) },
    'meta', tmp, [path.join(__dirname, 'lib', 'fake-meta-server.js')], false);
  const pxEntry = launch('proxy', { PX_CONFIG: JSON.stringify({ listeners: clients.map((c) => ({ id: `c${c.i}`, port: c.proxyPort, target: c.port })), prefixOwner }) }, 'proxy', tmp, [path.join(__dirname, 'lib', 'peak-proxy.js')], false);
  await Promise.all([fm.readyPromise, pxEntry.readyPromise]);
  const metaCmd = (key, value) => fm.child.send({ cmd: 'set', key, value });
  const proxyMode = (id, mode, ms, rate) => pxEntry.child.send({ cmd: 'mode', id, mode, ms, rate });

  const clientEnv = (c) => ({
    NODE_ENV: 'production', WHATSAPP_PROVIDER: 'META_CLOUD_API', PORT: String(c.port), OWNER_ACCESS_TOKEN: c.token, CLIENT_ACCESS_TOKEN: `${c.token}-client`,
    META_ACCESS_TOKEN: 'load-token', META_PHONE_NUMBER_ID: PN, META_DISPLAY_PHONE_NUMBER: '15550001111', META_APP_SECRET: '', BOT_REPLY_DELAY_MS: String(O.botDelay), CLIENT_NAME: `client-${c.i}`,
    STORAGE_PATH: path.join(c.dir, 'data', 'contacts.json'), CONVERSATION_STATE_PATH: path.join(c.dir, 'data', 'conversation-state.json'), UPLOADS_PATH: path.join(c.dir, 'uploads'), SESSION_PATH: path.join(c.dir, 'session'),
    DATABASE_URL: c.url, INBOX_BACKEND: 'postgres', INBOX_NAMESPACE: `${RUN}-c${c.i}`, INBOX_DB_POOL_MAX: '4', FAKE_META_URL: `http://127.0.0.1:${metaPort}`,
    ...(O.pgTrace ? { PEAK_TRACE_PG: '1' } : {}),
    ...(O.clientMaxSenders > 0 ? { META_MAX_CONCURRENT_SENDERS: String(O.clientMaxSenders) } : {}),
    ...(O.filePollMs > 0 ? { FILE_DELIVERY_POLL_INTERVAL_MS: String(O.filePollMs) } : {}),
  });
  for (let b = 0; b < clients.length; b += 5) {   // start in batches: 15 simultaneous migrations/boots would only measure the boot
    const batch = clients.slice(b, b + 5);
    for (const c of batch) c.entry = launch(`client${c.i}`, clientEnv(c), 'client', c.dir);
    await Promise.all(batch.map((c) => Promise.race([c.entry.readyPromise, sleep(120000).then(() => { throw new Error(`client ${c.i} did not start`); })])));
  }

  // ---- gateway (managementUrl -> proxy)
  const gwDir = path.join(tmp, 'gateway'); fs.mkdirSync(path.join(gwDir, 'owner'), { recursive: true });
  fs.writeFileSync(path.join(gwDir, 'owner', 'clients.json'), JSON.stringify(clients.map((c) => ({ id: `client-${c.i}`, name: `client-${c.i}`, accessCode: `code-${c.i}`, ownerAccessToken: c.token, plan: 'self_service', readonlyDashboard: false, maxCampaigns: 7,
    whatsappProvider: 'META_CLOUD_API', metaPhoneNumberId: PN, metaDisplayPhoneNumber: '15550001111', managementUrl: `http://127.0.0.1:${c.proxyPort}`, provisioningStatus: 'ready', createdAt: new Date().toISOString() })), null, 1));
  const gwEnv = { NODE_ENV: 'production', WHATSAPP_PROVIDER: 'META_CLOUD_API', PORT: String(gwPort), OWNER_ACCESS_TOKEN: `${RUN}-gw`, CLIENT_ACCESS_TOKEN: `${RUN}-gw-client`, META_ACCESS_TOKEN: 'load-token', META_PHONE_NUMBER_ID: PN, META_DISPLAY_PHONE_NUMBER: '15550001111', META_APP_SECRET: '',
    STORAGE_PATH: path.join(gwDir, 'data', 'contacts.json'), OWNER_STORAGE_PATH: path.join(gwDir, 'owner', 'clients.json'), CONVERSATION_STATE_PATH: path.join(gwDir, 'data', 'conversation-state.json'), UPLOADS_PATH: path.join(gwDir, 'uploads'), SESSION_PATH: path.join(gwDir, 'session'), DATABASE_URL: '',
    INBOX_BACKEND: 'postgres', INBOX_DATABASE_URL: gwInboxUrl, INBOX_NAMESPACE: RUN, FAKE_META_URL: `http://127.0.0.1:${metaPort}`,
    ...(O.gatewayPoolMax > 0 ? { INBOX_DB_POOL_MAX: String(O.gatewayPoolMax) } : {}), ...(O.pgTrace ? { PEAK_TRACE_PG: '1' } : {}),
    ...(O.gatewayTrace ? { GATEWAY_TRACE: '1' } : {}), ...(O.statusBatch !== 'off' ? { META_STATUS_BATCH: O.statusBatch } : {}), ...(O.statusBatchMax > 0 ? { META_STATUS_BATCH_MAX: String(O.statusBatchMax) } : {}) };
  {
    const { createInboxPool, migrateInboxSchema } = require(path.join(dist, 'inbox', 'schema'));
    const gp = createInboxPool(gwInboxUrl, { max: 2 }); await migrateInboxSchema(gp);
    await gp.query(`insert into inbox_senders(namespace, role, sender_key, sender_phone, next_seq) select $1, 'gateway', $2 || ':972509' || lpad(g::text, 6, '0'), '972509' || lpad(g::text, 6, '0'), 1000000 from generate_series(0, 1999) g`, [RUN, PN]);
    if (O.history > 0) await gp.query(`insert into inbox_items(namespace, role, phone_number_id, message_id, sender_key, sender_phone, sender_seq, status, payload, received_at, updated_at, resolution, attempts)
      select $1, 'gateway', $2, 'hist' || n, $2 || ':972509' || lpad((n % 2000)::text, 6, '0'), '972509' || lpad((n % 2000)::text, 6, '0'), n, case when n % 2 = 0 then 'held' else 'failed' end, $3::jsonb, clock_timestamp() - interval '1 day', clock_timestamp() - interval '1 hour', 'exhausted', 60
      from generate_series(1, $4) n`, [RUN, PN, JSON.stringify(inboundPayload('x', '972509000000', 'text', 'old')), O.history]);
    await gp.query('analyze inbox_items'); await gp.end();
  }
  const gwProf = has('gateway-prof') ? ['--cpu-prof', '--cpu-prof-dir=' + path.join(path.dirname(resultsPath('x')), `peak-${label}-gateway-prof`)] : [];
  const gw = launch('gateway', gwEnv, 'gateway', gwDir, undefined, true, gwProf);
  await Promise.race([gw.readyPromise, sleep(120000).then(() => { throw new Error('gateway did not start'); })]);
  await sleep(2500);

  // ---- faults
  const startedAt = Date.now(); const faultLog = []; const faultPromises = [];
  const selClients = (sel) => {
    if (!sel || sel === 'A') return [clients[0]]; if (sel === 'B') return [clients[1]]; if (sel === 'C') return [clients[2]]; if (sel === 'all') return clients;
    const m = /^idle(\d+)$/.exec(sel); const c = m ? clients[CAMP_CLIENT_COUNT + Number(m[1])] : null; if (!c) throw new Error(`fault selector "${sel}" not found (clients=${clients.length})`); return [c];
  };
  const restart = async (c, how) => {
    if (how === 'term') await stopProc(c.entry, 'SIGTERM', 20000); else await stopProc(c.entry, 'SIGKILL');
    await sleep(how === 'term' ? 1000 : 4000); c.entry = launch(`client${c.i}b`, clientEnv(c), 'client', c.dir); await c.entry.readyPromise;
  };
  const faultActions = {
    'client-down': async (d, sel) => { for (const c of selClients(sel)) { await stopProc(c.entry, 'SIGKILL'); } await sleep(d * 1000); for (const c of selClients(sel)) { c.entry = launch(`client${c.i}b`, clientEnv(c), 'client', c.dir); await c.entry.readyPromise; } },
    'kill-client': async (sel) => { for (const c of selClients(sel)) await restart(c, 'kill'); },
    'term-client': async (sel) => { for (const c of selClients(sel)) await restart(c, 'term'); },
    'kill-gateway': async () => { await stopProc(gw, 'SIGKILL'); await sleep(3000); const g2 = launch('gateway2', gwEnv, 'gateway', gwDir); await g2.readyPromise; },
    'term-gateway': async () => { await stopProc(gw, 'SIGTERM', 20000); await sleep(1000); const g2 = launch('gateway2', gwEnv, 'gateway', gwDir); await g2.readyPromise; },
    'db-outage': async (d) => {
      await admin.query(`alter database ${gwDbName} with allow_connections false`);
      await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [gwDbName]);
      await sleep(d * 1000); await admin.query(`alter database ${gwDbName} with allow_connections true`);
    },
    'proxy-slow': async (d, ms, sel) => { for (const c of selClients(sel)) proxyMode(`c${c.i}`, 'delay', Number(ms)); await sleep(d * 1000); for (const c of selClients(sel)) proxyMode(`c${c.i}`, 'ok'); },
    'proxy-hang': async (d, sel) => { for (const c of selClients(sel)) proxyMode(`c${c.i}`, 'hang'); await sleep(d * 1000); for (const c of selClients(sel)) proxyMode(`c${c.i}`, 'ok'); },
    'proxy-flaky': async (d, rate, sel) => { for (const c of selClients(sel)) proxyMode(`c${c.i}`, 'flaky', 0, Number(rate)); await sleep(d * 1000); for (const c of selClients(sel)) proxyMode(`c${c.i}`, 'ok'); },
    'meta-slow': async (d, f) => { metaCmd('latFactor', Number(f)); await sleep(d * 1000); metaCmd('latFactor', 1); },
    'meta-errors': async (d, r) => { metaCmd('err5xx', Number(r)); await sleep(d * 1000); metaCmd('err5xx', 0); },
    'meta-blackout': async (d) => { metaCmd('blackout', true); await sleep(d * 1000); metaCmd('blackout', false); },
    'meta-429': async (d, m) => { metaCmd('mps', Number(m)); await sleep(d * 1000); metaCmd('mps', O.mps); },
    'meta-lost': async (d, r) => { metaCmd('lostResp', Number(r)); await sleep(d * 1000); metaCmd('lostResp', 0.0005); },
    'status-delay': async (d, f) => { metaCmd('statusMult', Number(f)); await sleep(d * 1000); metaCmd('statusMult', 1); },
    'status-loss': async (d) => { metaCmd('statusLoss', true); await sleep(d * 1000); metaCmd('statusLoss', false); },
  };
  const NODUR = new Set(['kill-client', 'term-client', 'kill-gateway', 'term-gateway']);
  for (const spec of O.fault.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z0-9-]+)@([\d.]+)(?::(.*))?$/.exec(spec); if (!m || !faultActions[m[1]]) throw new Error(`bad --fault "${spec}"`);
    const [, kind, at, rest] = m; const a = rest ? rest.split(':') : [];
    const atMs = Number(at) * 1000 * FAULT_SCALE;
    // start time and duration scale with the run; every other argument is passed through unchanged
    const args = NODUR.has(kind) ? a : [Number(a[0] ?? 0) * FAULT_SCALE, ...a.slice(1)];
    faultPromises.push(new Promise((resolve) => setTimeout(async () => {
      const entry = { kind, spec, plannedAtS: +(atMs / 1000).toFixed(1), realAtS: +((Date.now() - startedAt) / 1000).toFixed(1) }; faultLog.push(entry);
      try { await faultActions[kind](...args); } catch (err) { entry.error = String(err && err.message || err); }
      entry.doneS = +((Date.now() - startedAt) / 1000).toFixed(1); resolve();
    }, atMs)));
  }

  // ---- timeline (every 30s)
  const timeline = []; let lastTl = Date.now(); let cpuPrev = os.cpus().map((c) => ({ ...c.times }));
  const hostCpuBusy = () => { const cur = os.cpus().map((c) => ({ ...c.times })); let busy = 0, total = 0; cur.forEach((c, i) => { const p = cpuPrev[i]; const d = (k) => c[k] - p[k]; const tot = d('user') + d('nice') + d('sys') + d('idle') + d('irq'); total += tot; busy += tot - d('idle'); }); cpuPrev = cur; return total ? Math.round(100 * busy / total) : 0; };
  const gp = new Pool({ connectionString: gwInboxUrl, max: 1 });
  const hostBusy = [];
  const tlTimer = setInterval(async () => {
    const now = Date.now(); const from = lastTl; lastTl = now; const busy = hostCpuBusy(); hostBusy.push(busy);
    const win = (arr) => arr.filter((x) => x.t > from && x.t <= now);
    const gl = win(events.lag.gateway); const posted = participants.filter((p) => p.trigPosted > from && p.trigPosted <= now);
    const fr = posted.filter((p) => p.sends.length).map((p) => p.sends[0].t - p.trigPosted);
    let gwCounts = null, oldest = null;
    try {
      gwCounts = Object.fromEntries((await gp.query("select status, count(*)::int n from inbox_items where namespace = $1 and role = 'gateway' and status in ('queued','retry','processing','review') group by status", [RUN])).rows.map((r) => [r.status, r.n]));
      oldest = (await gp.query("select coalesce(extract(epoch from (clock_timestamp() - min(due_at))) * 1000, 0)::int as ms from inbox_senders where namespace = $1 and role = 'gateway' and head_id is not null and due_at <= statement_timestamp()", [RUN])).rows[0].ms;
    } catch { /* gateway inbox db may be in an outage fault */ }
    let journalBytes = null; try { journalBytes = fs.statSync(path.join(gwDir, 'owner', 'meta-status-forward.jsonl')).size; } catch { /* not yet */ }
    const done = participants.filter((p) => !p.isNoisy && distinctStepCount(p.sends) >= expectedSends(p)).length;
    const row = { tS: Math.round((now - startedAt) / 1000), triggersPosted: participants.filter((p) => p.trigPosted).length, completed: done, sends: lastMeta ? lastMeta.accepted : null, firstResponseMs: { n: fr.length, p50: pct(fr, 50), p99: pct(fr, 99), max: fr.length ? Math.max(...fr) : null },
      statusLagWindowMs: lastPx?.statusLagWindowMs ?? null, statusCallsToClients: lastPx?.totals?.status ?? null, gatewayLagMs: { p99Worst: gl.length ? Math.max(...gl.map((x) => x.p99)) : null, max: gl.length ? Math.max(...gl.map((x) => x.max)) : null, cpuPctMax: gl.length ? Math.max(...gl.map((x) => x.cpuPct ?? 0)) : null, rssMB: gl.length ? gl[gl.length - 1].rssMB : null },
      gatewayInbox: gwCounts, gatewayOldestDueMs: oldest, statusJournalBytes: journalBytes, hostCpuBusyPct: busy, harnessLagP99Ms: +(hist.percentile(99) / 1e6).toFixed(0), r429: lastMeta?.r429 ?? null, faultsActive: faultLog.filter((f) => f.doneS === undefined).map((f) => f.kind) };
    hist.reset(); timeline.push(row);
    console.log(`[${label}] t=${row.tS}s trig=${row.triggersPosted}/${totalTriggers} done=${done} 1st p50/p99/max=${row.firstResponseMs.p50}/${row.firstResponseMs.p99}/${row.firstResponseMs.max}ms (n=${fr.length}) statusLag p99=${row.statusLagWindowMs?.p99 ?? '-'}ms gwLag p99=${row.gatewayLagMs.p99Worst}ms queue=${JSON.stringify(gwCounts)} host=${busy}% faults=${row.faultsActive.join('+') || '-'}`);
  }, 30000);

  // ---- client inbox sampler: /health (as the dashboard sees it) AND the inbox table itself. NOTE /health inbox counters are refreshed by the
  // client every 5s (refreshInboxHealth), so they can be up to 5s stale; the SQL numbers are exact.
  const healthSeries = []; let sampling = false; const pgConnSeries = []; const statusCallSeries = [];
  const getJson = (port, p2) => new Promise((resolve) => { const rq = http.get({ host: '127.0.0.1', port, path: p2, agent: false, timeout: 3000 }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); rq.on('error', () => resolve(null)); rq.on('timeout', () => { rq.destroy(); resolve(null); }); });
  const sampleClients = async () => {
    if (sampling) return; sampling = true; const tS = +((Date.now() - startedAt) / 1000).toFixed(1);
    try {
      try { const r = await admin.query('select count(*)::int n from pg_stat_activity'); pgConnSeries.push([tS, r.rows[0].n]); } catch { /* ignore */ }
      if (lastPx && lastPx.totals) statusCallSeries.push([tS, lastPx.totals.status]);
      await Promise.all(clients.map(async (c) => {
        const [h, q] = await Promise.all([getJson(c.port, '/health'), admin.query(`select status, count(*)::int n, coalesce(extract(epoch from (clock_timestamp() - min(received_at))) * 1000, 0)::int age_ms from ${c.schema}.inbox_items where status in ('queued','retry','processing') group by status`).catch(() => ({ rows: [] }))]);
        const by = Object.fromEntries(q.rows.map((r) => [r.status, r]));
        const cv = h && h.conversations;
        healthSeries.push({ tS, client: c.i, sqlProcessing: by.processing ? by.processing.n : 0, sqlQueued: (by.queued ? by.queued.n : 0) + (by.retry ? by.retry.n : 0), sqlOldestWaitingMs: Math.max(by.queued ? by.queued.age_ms : 0, by.retry ? by.retry.age_ms : 0),
          healthMetaClientInbox: cv ? cv.metaClientInbox : null, healthInboxOldestDueMs: cv && cv.inboxOldestDueAgeMs ? cv.inboxOldestDueAgeMs.client : null, flowInboundQueued: cv && cv.flowHealth ? cv.flowHealth.inboundQueued : null, flowActiveSenderQueues: cv && cv.flowHealth ? cv.flowHealth.activeSenderQueues : null,
          outbox: h ? h.outbox : null, pending: cv ? cv.pending : null });
      }));
    } finally { sampling = false; }
  };
  const sampleTimer = setInterval(() => { void sampleClients(); }, num('health-sample-ms', 2000));
  // ---- drive: triggers on schedule
  const order = [...participants].sort((a, b) => a.atS - b.atS);
  const driveStart = Date.now();
  for (const p of order) {
    const plannedAt = driveStart + p.atS * 1000;
    const wait = plannedAt - Date.now(); if (wait > 3) await sleep(wait);
    p.trigPlanned = plannedAt; p.trigScheduleDelayMs = Date.now() - plannedAt;
    p.trigPosted = Date.now(); p.causes.push({ id: `cause-${p.trigId || p.phone}-trigger`, t: p.trigPosted, kind: 'trigger', camp: p.camp.key });
    void postInbound(p, 'text', p.camp.phrase, null, 'trigger'); p.trigId = p.lastPostedId; { const mi = msgInfo.get(p.trigId); if (mi) mi.kind = 'trigger'; }   // cause recorded with the exact post moment
  }
  const driveEndedAt = Date.now();
  console.log(`[${label}] all ${totalTriggers} triggers posted in ${((driveEndedAt - driveStart) / 1000).toFixed(0)}s; waiting for the flows to finish (max ${O.timeoutS}s)`);

  // ---- wait: every strict participant reaches its expected number of messages, or the timeout
  const strictDone = () => participants.filter((p) => !p.isNoisy).every((p) => distinctStepCount(p.sends) >= expectedSends(p));
  const deadline = Date.now() + O.timeoutS * 1000;
  while (Date.now() < deadline && !strictDone()) await sleep(1000);
  await Promise.all(faultPromises);
  await sleep(12000);   // late duplicates / retries surface here
  const readJournal = () => { try { const lines = fs.readFileSync(path.join(gwDir, 'owner', 'meta-status-forward.jsonl'), 'utf8').split('\n').filter(Boolean); const add = new Set(), done = new Set(); for (const l of lines) { try { const j = JSON.parse(l); if (j.t === 'add') add.add(j.id); else done.add(j.id); } catch { /* torn */ } } return { readable: true, lines: lines.length, addedPairs: add.size, stillPending: [...add].filter((i) => !done.has(i)).length }; } catch (err) { return { readable: false, error: String(err && err.code || err && err.message || err), stillPending: null }; } };
  const drainStart = Date.now(); let drainLeft = null;
  let drainReason = 'deadline';
  for (let waited = 0; waited < num('drain-wait', 180) * 1000; waited = Date.now() - drainStart) {
    const j = readJournal(); drainLeft = j.stillPending;
    const fakeDone = lastMeta && (lastMeta.pendingStatusTimers || 0) === 0 && (lastMeta.postsInFlight || 0) === 0;
    const journalDone = j.readable && j.stillPending === 0;
    if (fakeDone && journalDone) { drainReason = 'fake-meta-and-status-journal-drained'; break; }
    await sleep(1000);
  }
  const drainWaitedS = +((Date.now() - drainStart) / 1000).toFixed(0);
  const journal = { ...readJournal(), drainWaitedS, drainReason, fakeMetaPendingAtStop: lastMeta ? { pendingStatusTimers: lastMeta.pendingStatusTimers, postsInFlight: lastMeta.postsInFlight, terminalAttempted: lastMeta.delivery && lastMeta.delivery.terminalAttempted, terminalAcked: lastMeta.delivery && lastMeta.delivery.terminalAcked } : null };
  const endedAt = Date.now(); clearInterval(tlTimer); clearInterval(sampleTimer);

  // ---- collect
  fm.child.send({ cmd: 'dump' }); pxEntry.child.send({ cmd: 'dump' });
  for (let i = 0; i < 1200 && (!metaDump || !proxyDump); i++) await sleep(100);   // up to 2 min: the proxy sorts every latency sample before answering
  if (!proxyDump) console.warn('[warn] proxy dump not received: fanOut / statusLag summaries will be null');
  const analyze = (list) => {
    const firstResp = [], replyFirst = [], complete = [], byIdx = {};
    for (const p of list) {
      const sends = [...p.sends].sort((a, b) => a.t - b.t); const causes = [...p.causes].sort((a, b) => a.t - b.t);
      const groups = causes.map(() => []);
      for (const s of sends) { let ci = -1; for (let i = 0; i < causes.length; i++) if (causes[i].t <= s.t) ci = i; if (ci >= 0) groups[ci].push(s); }
      causes.forEach((c, ci) => {
        const g = groups[ci]; if (!g.length) return;
        const lat = g[0].t - c.t;
        if (c.kind === 'trigger') firstResp.push(lat); else if (c.kind === 'answer') replyFirst.push(lat);
        for (let k = 0; k < g.length; k++) {
          const ref = k === 0 ? c.t : g[k - 1].t; if (g[k].idx != null) (byIdx[g[k].idx] = byIdx[g[k].idx] || { fromCause: [], gap: [] }).fromCause.push(g[k].t - c.t);
          if (k > 0) { const gap = g[k].t - ref; if (g[k].idx != null) byIdx[g[k].idx].gap.push(gap); }
        }
      });
      if (!p.isNoisy && sends.length >= p.camp.total && causes.length) complete.push(sends[sends.length - 1].t - causes[0].t);
    }
    const idxOut = {}; for (const k of Object.keys(byIdx).sort((a, b) => a - b)) idxOut[k] = { sinceCause: stat(byIdx[k].fromCause), gapFromPrevious: stat(byIdx[k].gap) };
    const gapByPrevious = summarizeGapLatencies(list);
    return { firstResponseMs: stat(firstResp), firstResponseToAnswerMs: stat(replyFirst), gapAfterTextMs: gapByPrevious.textToTextMs, gapAfterImageMs: gapByPrevious.imageToNextMs, gapByPrevious, completionMs: stat(complete), byMessageIndex: idxOut, triggersWithNoResponse: list.filter((p) => !(p.sends || []).length).length };
  };
  const strict = participants.filter((p) => !p.isNoisy); const noisy = participants.filter((p) => p.isNoisy);
  const byCamp = {}; for (const c of CAMPS) byCamp[c.key] = analyze(strict.filter((p) => p.camp === c));
  const byPhase = { peak: analyze(strict.filter((p) => p.phase === 'peak')), tail: analyze(strict.filter((p) => p.phase === 'tail')) };
  const overall = analyze(strict);
  // ---- first response split at the three hand-over points. Timestamps of the middle two are the harness's arrival time of the gateway's
  // [META_GATEWAY_ROUTED] line and the client's [META_INBOUND] line (ms-level skew possible, so this is exact enough for seconds-scale waits).
  const seg = (list) => {
    const A = [], B = [], Cc = [], D = [], T = [];
    for (const p of list) {
      if (!p.trigId || !p.sends.length) continue; const ack = ackAt.get(p.trigId), routed = routedAt.get(p.trigId), pick = pickupAt.get(p.trigId); const first = [...p.sends].sort((a, b) => a.t - b.t)[0].t;
      T.push(first - p.trigPosted); if (ack) A.push(ack - p.trigPosted); if (ack && routed) B.push(routed - ack); if (routed && pick) Cc.push(pick - routed); if (pick) D.push(first - pick);
    }
    return { postToGatewayAck: stat(A), gatewayAckToForwarded: stat(B), forwardedToClientPickup_waitForSlot: stat(Cc), pickupToFirstMessage_work: stat(D), total: stat(T), participantsWithAllTimestamps: Math.min(A.length, B.length, Cc.length, D.length) };
  };
  const slotHold = (list) => {   // how long ONE round of a flow keeps its slot: pickup of the trigger -> the question (first interactive send) leaves
    const hold = [], imageWait = [];
    for (const p of list) { const pick = pickupAt.get(p.trigId); if (!pick) continue; const ss = [...p.sends].sort((a, b) => a.t - b.t); const q = ss.find((x) => x.type === 'interactive'); if (!q) continue; hold.push(q.t - pick);
      let w = 0; for (let i = 1; i < ss.length && ss[i].t <= q.t; i++) if (ss[i - 1].type === 'image') w += ss[i].t - ss[i - 1].t; imageWait.push(w); }
    return { round0_holdMs: stat(hold), round0_timeSpentWaitingAfterImagesMs: stat(imageWait) };
  };
  const firstResponseBreakdown = {}; const slotHoldByCampaign = {};
  for (const c of CAMPS) { const L2 = strict.filter((p) => p.camp === c); firstResponseBreakdown[`${c.key}(client${c.idx})`] = seg(L2); slotHoldByCampaign[`${c.key}(client${c.idx})`] = slotHold(L2); }
  firstResponseBreakdown.peakWindowOnly = Object.fromEntries(CAMPS.map((c) => [c.key, seg(strict.filter((p) => p.camp === c && p.phase === 'peak'))]));
  // series per client (SQL = exact; health = what /health reports)
  const sampleEveryS = num('health-sample-ms', 2000) / 1000;
  const clientQueue = {};
  for (const c of clients) {
    const sr = healthSeries.filter((x) => x.client === c.i); if (!sr.length) continue;
    const maxP = Math.max(...sr.map((x) => x.sqlProcessing)); const atCap = sr.filter((x) => x.sqlProcessing >= 50).length;
    const hp = sr.map((x) => (x.healthMetaClientInbox && x.healthMetaClientInbox.processing) || 0);
    clientQueue['client' + c.i] = { samples: sr.length, sampleEveryS, sql: { maxProcessing: maxP, secondsAt50OrMore: +(atCap * sampleEveryS).toFixed(0), secondsAbove40: +(sr.filter((x) => x.sqlProcessing > 40).length * sampleEveryS).toFixed(0), maxQueued: Math.max(...sr.map((x) => x.sqlQueued)), maxOldestWaitingMs: Math.max(...sr.map((x) => x.sqlOldestWaitingMs)) },
      health: { maxProcessing: Math.max(...hp), maxInboxOldestDueMs: Math.max(...sr.map((x) => x.healthInboxOldestDueMs || 0)), maxFlowInboundQueued: Math.max(...sr.map((x) => x.flowInboundQueued || 0)), maxActiveSenderQueues: Math.max(...sr.map((x) => x.flowActiveSenderQueues || 0)), maxPendingConversations: Math.max(...sr.map((x) => x.pending || 0)) },
      series: sr.map((x) => [x.tS, x.sqlProcessing, x.sqlQueued, x.sqlOldestWaitingMs, (x.healthMetaClientInbox && x.healthMetaClientInbox.processing) || 0, x.healthInboxOldestDueMs || 0]) };
  }
  const allSendTimes = participants.filter((p) => !p.isNoisy).flatMap((p) => p.sends.map((x) => x.t));
  const flowsFinishedAtS = allSendTimes.length ? +((Math.max(...allSendTimes.slice(0, 100000)) - startedAt) / 1000).toFixed(1) : null;
  const finalStatusCalls = statusCallSeries.length ? statusCallSeries[statusCallSeries.length - 1][1] : null;
  const statusForwardingDoneAtS = finalStatusCalls ? (statusCallSeries.find((r) => r[1] >= finalStatusCalls * 0.999) || [null])[0] : null;
  const triggersDoneAtS = +((driveEndedAt - startedAt) / 1000).toFixed(1);
  const arrivalDelayMs = stat(participants.map((p) => p.trigScheduleDelayMs));
  const runShape = { triggersDoneAtS, flowsFinishedAtS, statusForwardingDoneAtS, finalStatusCalls, avgStatusCallsPerSecond: finalStatusCalls && statusForwardingDoneAtS ? Math.round(finalStatusCalls / statusForwardingDoneAtS) : null,
    arrivalDelayMs,
    pgConnections: { max: pgConnSeries.length ? Math.max(...pgConnSeries.map((r) => r[1])) : null, serverLimit: maxConn, series: pgConnSeries.filter((_, i) => i % 5 === 0) } };
  // noisy: the handover latency (trigger of the other campaign -> its first message) is its own number
  const handover = []; for (const p of noisy.filter((x) => x.crossAt)) { const s = p.sends.filter((x) => x.t > p.crossAt).sort((a, b) => a.t - b.t)[0]; if (s) handover.push(s.t - p.crossAt); }
  // identity of every message: a message whose OWN marker names another campaign than the one the participant is in is a mix-up
  let crossStrict = 0, foreignNoisy = 0, staleAfterSwitch = 0, unmarkedStrict = 0; const staleByKind = { crossover: 0, sameClient: 0 }; const crossExamples = [];
  // A contact card is a vCard: WhatsApp gives it no text field at all, so a step marker cannot ride on it.
  // It is a legitimate product message, not the fallback/invalid-reply text this check exists to catch.
  let markerlessContactCards = 0; const unmarkedByType = {};
  for (const p of strict) for (const sd of p.sends) { if (!sd.camp) { if (sd.type === 'contacts') { markerlessContactCards += 1; continue; } unmarkedStrict += 1; unmarkedByType[sd.type || 'unknown'] = (unmarkedByType[sd.type || 'unknown'] || 0) + 1; continue; } if (sd.camp !== p.camp.key) { crossStrict += 1; if (crossExamples.length < 8) crossExamples.push({ phoneTail: p.phone.slice(-5), expected: p.camp.key, got: sd.camp, idx: sd.idx }); } }
  for (const p of noisy) for (const sd of p.sends) {
    if (!sd.camp) continue;
    const allowed = p.switched ? [p.switched.from, p.switched.to] : [p.camp.key];
    if (!allowed.includes(sd.camp)) { foreignNoisy += 1; if (crossExamples.length < 8) crossExamples.push({ phoneTail: p.phone.slice(-5), allowed, got: sd.camp, idx: sd.idx, noisy: true }); }
    else if (p.switched && sd.camp === p.switched.from && p.switched.at && sd.t > p.switched.at + 10000) { staleAfterSwitch += 1; staleByKind[p.switched.kind] += 1; }   // old flow still sending 10s after the participant left it
  }
  const crossCampaignMessages = crossStrict + foreignNoisy;
  const switchedList = noisy.filter((p) => p.switched);
  const switchedDetailed = switchedList.slice(0, 80).map((p) => ({ participant: p.phone.slice(-6), kind: p.switched.kind, from: p.switched.from, to: p.switched.to, ...classifySwitchMessages(p) }));
  const switchedSummary = ['crossover', 'sameClient'].map((kind) => {
    const L2 = switchedList.filter((p) => p.switched.kind === kind);
    const lat = []; let completedTarget = 0;
    for (const p of L2) { const first = p.sends.filter((x) => x.t > p.switched.at && x.camp === p.switched.to).sort((a, b) => a.t - b.t)[0]; if (first) lat.push(first.t - p.switched.at); const tc = [...CAMPS, ...EXTRA].find((c) => c.key === p.switched.to); if (new Set(p.sends.filter((x) => x.camp === p.switched.to).map((x) => x.idx)).size >= tc.total) completedTarget += 1; }
    return { kind, participants: L2.length, gotTargetFirstMessage: lat.length, completedTargetFlow: completedTarget, handoverToFirstMessageMs: stat(lat) };
  });
  // planned-abandon vs genuinely stopped (only the last one is a failure)
  const completion = { strictParticipants: strict.length, fullFlow: 0, plannedAbandonAfterQ1: 0, plannedAbandonAfterQ2: 0, unexplainedStop: 0, unexplainedExamples: [] }; const unexplainedPhones = new Set();
  for (const p of strict) {
    const got = new Set(p.sends.filter((x) => x.camp === p.camp.key).map((x) => x.idx)).size; const want = expectedSends(p);
    if (got < want) { completion.unexplainedStop += 1; unexplainedPhones.add(p.phone); if (completion.unexplainedExamples.length < 8) completion.unexplainedExamples.push({ phoneTail: p.phone.slice(-5), camp: p.camp.key, want, got }); }
    else if (p.abandon) completion.plannedAbandonAfterQ1 += 1; else if (p.drop2) completion.plannedAbandonAfterQ2 += 1; else completion.fullFlow += 1;
  }
  // ================= KPI: outbound messages per participant (what the shared number has to carry), by campaign and by kind
  const MEDIA = new Set(['image', 'audio', 'video', 'document', 'sticker']);
  const kindOf = (sd, camp) => (sd.idx != null && camp.qpos.includes(sd.idx - 1) ? 'question' : MEDIA.has(sd.type) ? 'media' : 'text');
  const kpiOf = (list, camp) => {
    const out = { participants: list.length, messages: 0, distinctSteps: 0, extraCopies: 0, byKind: { text: 0, media: 0, question: 0 }, extraByKind: { text: 0, media: 0, question: 0 } };
    for (const p of list) {
      // Two sets on purpose: an extra COPY is the same step sent twice in the same kind (an audio
      // step's caption and its clip are one step in two kinds, and counting that pair as a copy
      // made every quiz participant look duplicated), while a distinct STEP stays one step.
      const seenKind = new Set(); const seenStep = new Set();
      for (const sd of p.sends) {
        const k = kindOf(sd, camp || p.camp); out.messages += 1; out.byKind[k] += 1;
        if (sd.idx == null) continue;
        const step = (sd.camp || '?') + '#' + sd.idx;
        if (seenKind.has(step + '|' + k)) { out.extraCopies += 1; out.extraByKind[k] += 1; } else seenKind.add(step + '|' + k);
        seenStep.add(step);
      }
      out.distinctSteps += seenStep.size;
    }
    const per = (v) => (list.length ? +(v / list.length).toFixed(2) : null);
    return { ...out, messagesPerParticipant: per(out.messages), distinctStepsPerParticipant: per(out.distinctSteps), extraCopiesPerParticipant: per(out.extraCopies),
      perParticipantByKind: Object.fromEntries(Object.entries(out.byKind).map(([k, v]) => [k, per(v)])) };
  };
  const messagesPerParticipant = { allParticipants: kpiOf(participants), strictParticipants: kpiOf(strict), byCampaign: Object.fromEntries(CAMPS.map((c) => [c.key, { plannedFullFlow: c.total, planned: { text: c.toks.filter((t) => t === 'm').length, media: c.toks.filter((t) => t === 'i' || t === 'a').length, question: c.qpos.length }, all: kpiOf(participants.filter((p) => p.camp === c)), completedFullFlowOnly: kpiOf(strict.filter((p) => p.camp === c && !p.abandon && !p.drop2)) }])),
    metaAcceptedPerParticipant: metaDump ? +(metaDump.accepted / participants.length).toFixed(2) : null, typingIndicatorsAndReadReceiptsPerParticipant_notMessages: metaDump ? +(metaDump.markRead / participants.length).toFixed(2) : null };
  const expectedPartsFor = (p) => {
    const out = []; const n = expectedSends(p);
    for (let i = 0; i < n; i++) {
      const tk = p.camp.toks[i]; const idx = i + 1; const common = { client: `client${p.camp.idx}`, expectedClient: `client${p.camp.idx}`, camp: p.camp.key, session: p.camp.key, idx };
      if (tk === 'a') { out.push({ ...common, type: 'text' }); out.push({ ...common, type: 'audio' }); }
      else if (tk === 'i') out.push({ ...common, type: 'image' });
      else if (tk === 'q') out.push({ ...common, type: 'interactive' });
      else out.push({ ...common, type: 'text' });
    }
    return out;
  };
  // ================= order protection around media: the next message must not be sent before Meta posted the media's delivered/failed status, unless the 20s wait timed out
  const term = (metaDump && metaDump.terminalPostedAt) || {};
  const mediaOrder = {}; for (const ty of ['image', 'audio']) mediaOrder[ty] = { sends: 0, lastMessageOfFlow: 0, nextWasSentAfterTerminalStatus: 0, nextWasSentByTimeout: 0, VIOLATION_nextSentBeforeTerminalStatusAndNotByTimeout: 0, notFollowedByNextStep: 0, examples: [] };
  const slowSet = new Set((metaDump && metaDump.injected && metaDump.injected.slowTail) || []); const failSet = new Set((metaDump && metaDump.injected && metaDump.injected.failedStatus) || []);
  const waitTimeouts = []; const audioChecks = { audioStepParticipants: 0, sentAsAudio: 0, sentAsDocumentOrOther: 0, questionSentBeforeAudio: 0, questionAfterAudioInOrder: 0, audioCopies: 0, captionSentAsItsOwnMessage: 0, audioStepsWithoutACaption: 0 };
  for (const p of strict) {
    const ss = [...p.sends].sort((a, b) => a.t - b.t);
    for (let k = 0; k < ss.length; k++) {
      const m = ss[k]; if (m.type !== 'image' && m.type !== 'audio') continue; const R = mediaOrder[m.type]; R.sends += 1;
      const next = ss[k + 1]; if (!next) { R.lastMessageOfFlow += 1; continue; }
      if (next.idx !== m.idx + 1 || next.camp !== m.camp) { R.notFollowedByNextStep += 1; continue; }
      const gap = next.t - m.t; const tt = term[m.id];
      if (gap >= 19000) { R.nextWasSentByTimeout += 1; const tag = m.key + '#' + m.attempt; waitTimeouts.push({ type: m.type, campaign: m.camp, client: 'client' + p.camp.idx, phase: p.phase, atS: Math.round((m.t - startedAt) / 1000), reason: slowSet.has(tag) ? 'designed slow-tail delivered status (20-90s late)' : failSet.has(tag) ? 'failed status' : 'status late for another reason (not injected)' }); }
      else if (tt !== undefined && next.t >= tt) R.nextWasSentAfterTerminalStatus += 1;
      else { R.VIOLATION_nextSentBeforeTerminalStatusAndNotByTimeout += 1; if (R.examples.length < 5) R.examples.push({ participant: p.phone.slice(-6), campaign: m.camp, idx: m.idx, gapMs: gap, terminalPostedMsAfterMedia: tt === undefined ? null : tt - m.t }); }
    }
    if (p.camp.audios) {
      const audioSends = ss.filter((x) => x.camp === p.camp.key && x.idx === 2); const q = ss.find((x) => x.camp === p.camp.key && x.idx === 3);
      // WhatsApp has no caption on audio, so the step text arrives as its own `text` message just
      // before the clip. That text is expected - only the CLIP's type is the thing under test here.
      if (audioSends.length) {
        const split = classifyAudioStepSends(audioSends);
        audioChecks.audioStepParticipants += 1;
        audioChecks.audioCopies += split.clips.length;
        audioChecks.sentAsAudio += split.sentAsAudio;
        audioChecks.sentAsDocumentOrOther += split.sentAsSomethingElse;
        audioChecks.captionSentAsItsOwnMessage += split.captions.length;
        if (!split.captions.length) audioChecks.audioStepsWithoutACaption += 1;
      }
      if (q && audioSends.length) { if (q.t < audioSends[0].t) audioChecks.questionSentBeforeAudio += 1; else audioChecks.questionAfterAudioInOrder += 1; }
    }
  }
  const countBy = (arr, fn) => arr.reduce((o, x) => { const k = fn(x); o[k] = (o[k] || 0) + 1; return o; }, {});
  const deliveryWaitTimeouts = { total: waitTimeouts.length, ofMediaSendsWithANextStep: mediaOrder.image.sends + mediaOrder.audio.sends - mediaOrder.image.lastMessageOfFlow - mediaOrder.audio.lastMessageOfFlow, byReason: countBy(waitTimeouts, (x) => x.reason), byType: countBy(waitTimeouts, (x) => x.type), byCampaign: countBy(waitTimeouts, (x) => x.campaign), byPhase: countBy(waitTimeouts, (x) => x.phase), byClient: countBy(waitTimeouts, (x) => x.client), byThirtySecondBucket: countBy(waitTimeouts, (x) => Math.floor(x.atS / 30) * 30), note: 'in this simulation a status can only be late because (a) the simulator injects a slow tail (--status-tail) or (b) the gateway->client path lagged; real Meta causes are not modelled' };
  const downgraded = { questionsSentAsText: participants.reduce((a, p) => a + (p.downgradedQuestions || 0), 0), participantsWithADowngradedQuestion: participants.filter((p) => p.downgradedQuestions).length, answeredByTextReply: participants.reduce((a, p) => a + (p.textAnswers || 0), 0), injectedInteractiveRejections: metaDump ? metaDump.rejectedInteractive : null };
  // peak arrival shape actually scheduled
  const atSorted = participants.map((p) => p.atS).sort((a, b) => a - b); let maxIn1s = 0, maxIn10s = 0;
  for (let i = 0, j1 = 0, j10 = 0; i < atSorted.length; i++) { while (atSorted[i] - atSorted[j1] > 1) j1++; while (atSorted[i] - atSorted[j10] > 10) j10++; maxIn1s = Math.max(maxIn1s, i - j1 + 1); maxIn10s = Math.max(maxIn10s, i - j10 + 1); }
  // integrity (strict participants only) - and a full explanation of every duplicate and every out-of-order pair
  let lost = 0, dup = 0, reordered = 0, shortParticipants = 0; const examples = [];
  const duplicateDetail = [], reorderDetail = [];
  const faultsByKey = new Map(); for (const f of metaFaults) { const a = faultsByKey.get(f.key) || []; a.push({ attempt: f.attempt, kind: f.kind }); faultsByKey.set(f.key, a); }
  const injectedOn = (sd) => [...(faultsByKey.get(sd.key) || []), ...(sd.lost ? [{ attempt: sd.attempt, kind: 'response-lost' }] : [])];
  const idxOfKey = (k) => Number(/#(\d+)$/.exec(k || '')?.[1]);
  // a fault on a LATER step of the same participant's flow, between the first send and the re-send, is what makes the engine replay the round
  const roundTrigger = (p, first, second) => {
    const cands = [];
    for (const sd of p.sends) if (sd.lost && sd.idx > first.idx && sd.camp === first.camp && sd.t >= first.t - 1000 && sd.t <= second.t) cands.push({ kind: 'response-lost', key: sd.key, idx: sd.idx, attempt: sd.attempt });
    for (const f of metaFaults) { if (f.key.split('|')[0] !== p.phone || f.kind === '429') continue; const fi = idxOfKey(f.key); if (fi > first.idx && f.key.includes('|' + first.camp + '#') && f.t >= first.t - 1000 && f.t <= second.t) cands.push({ kind: f.kind, key: f.key, idx: fi, attempt: f.attempt }); }
    return cands;
  };
  const explainDup = (second, ctx) => {
    if (!second.attempt || second.attempt < 2) return 'two requests for the same message (first attempt each) - the engine sent it twice';
    if (second.prev === 'accepted-lost') return 'retry after an injected response-loss (Meta had accepted the previous attempt but the answer never arrived)';
    if (second.prev === 'accepted') {
      const trig = ctx ? roundTrigger(ctx.p, ctx.first, second) : [];
      if (trig.length) return 'ROUND REPLAY: step ' + trig[0].idx + ' hit an injected ' + trig[0].kind + ' and the engine re-sent earlier steps of the same round that Meta had already accepted';
      return 'RESEND AFTER A SUCCESSFULLY ANSWERED ATTEMPT - no injected fault explains it';
    }
    if (second.prev === '5xx' || second.prev === '429') return 'previous attempt was rejected yet two copies were accepted (should be impossible)';
    return 'unclassified';
  };
  for (const p of strict) {
    const want = expectedSends(p); const got = p.sends.length; const idxs = [...p.sends].sort((a, b) => a.t - b.t).map((s) => s.idx);
    const seen = new Set(); let d = 0; for (const i of idxs) seen.add(i);
    // A duplicate is one message sent twice. An audio step legitimately emits its caption AND the
    // clip under the same step marker, so duplicates are counted per (step, message type).
    for (const g of duplicateGroups(p.sends)) d += g.length - 1;
    let ro = false;
    const sortedSends = [...p.sends].sort((a, b) => a.t - b.t);
    for (let i = 1; i < idxs.length; i++) if (idxs[i] != null && idxs[i - 1] != null && idxs[i] < idxs[i - 1]) {
      ro = true; const a = sortedSends[i - 1], b = sortedSends[i];
      reorderDetail.push({ campaign: p.camp.key, participant: p.phone, orderSeen: idxs.join(','), earlierSent: { idx: a.idx, attempt: a.attempt, wamid: a.id, key: a.key }, laterSent: { idx: b.idx, attempt: b.attempt, wamid: b.id, key: b.key }, gapMs: b.t - a.t,
        anyRetryInvolved: (a.attempt > 1) || (b.attempt > 1), injectedOnTheseMessages: [...injectedOn(a), ...injectedOn(b)] });
    }
    for (const g of duplicateGroups(p.sends)) duplicateDetail.push({ campaign: p.camp.key, participant: p.phone, stepIdx: g[0].idx, sentType: g[0].type, copies: g.length, key: g[0].key, sends: g.map((x) => ({ attempt: x.attempt, wamid: x.id, tMs: x.t - g[0].t, previousAttemptOutcome: x.prev, responseLost: x.lost })), reason: explainDup(g[1], { p, first: g[0] }), triggeringFault: g.length > 1 && g[1].prev === 'accepted' ? roundTrigger(p, g[0], g[1])[0] || null : null, injectedOnThisMessage: injectedOn(g[0]).concat(g.slice(1).flatMap(injectedOn)) });
    const missing = []; for (let i = 1; i <= want; i++) if (!seen.has(i)) missing.push(i);
    lost += missing.length; dup += d; if (ro) reordered += 1; if (missing.length) { shortParticipants += 1; if (examples.length < 8) examples.push({ phoneTail: p.phone.slice(-5), camp: p.camp.key, want, got, missing: missing.slice(0, 6) }); }
  }
  const lostTags = (metaDump && metaDump.injected && metaDump.injected.lostResp) || [];
  const faultOutcomes = lostTags.map((tag) => {
    const h = tag.lastIndexOf('#'); const key = tag.slice(0, h); const attempt = Number(tag.slice(h + 1)); const phone = key.split('|')[0]; const p = byPhone.get(phone);
    const copies = p ? p.sends.filter((x) => x.key === key).length : null;
    return { key, attempt, participantClass: p ? (p.isNoisy ? 'noisy' : 'strict') : 'unknown', copiesSentToThatMessage: copies, becameDuplicate: copies > 1 };
  });
  const lostSummary = { injected: lostTags.length, onStrictParticipants: faultOutcomes.filter((x) => x.participantClass === 'strict').length,
    becameDuplicate: faultOutcomes.filter((x) => x.becameDuplicate).length, notResent: faultOutcomes.filter((x) => x.copiesSentToThatMessage === 1).length };
  const results = [];
  for (const k of CAMPS) {
    const c = clients[k.idx];
    const r = await admin.query(`select count(distinct phone)::int d, count(*)::int n from ${c.schema}.campaign_results where campaign_id = $1`, [`camp-${k.key}`]);
    results.push({ campaign: k.key, triggers: participants.filter((p) => p.camp === k).length, distinctResults: r.rows[0].d, rows: r.rows[0].n });
  }
  // delivery accounting: what Meta accepted vs what every client ended up recording (outbox), and what became of the failed statuses
  const failedMap = new Map((metaDump && metaDump.failedIds) || []);
  const outboxByDelivery = {}; const outboxByWamid = new Map(); const outboxRowsForAudit = []; let outboxRows = 0;
  for (const c of clients) for (const r of (await admin.query(`select provider_message_id pm, status, data->>'deliveryStatus' ds from ${c.schema}.outbox_messages where provider_message_id is not null`)).rows) {
    outboxRows += 1; outboxByDelivery[r.ds || 'none'] = (outboxByDelivery[r.ds || 'none'] || 0) + 1;
    const row = { wamid: r.pm, client: `client${c.i}`, status: r.status, ds: r.ds || 'none' };
    outboxRowsForAudit.push(row);
    const list = outboxByWamid.get(r.pm) || []; list.push(row); outboxByWamid.set(r.pm, list);
  }
  for (const p of participants) for (const sd of p.sends) {
    const rows = outboxByWamid.get(sd.id) || [];
    const clientsForWamid = [...new Set(rows.map((r) => r.client))];
    sd.actualStoredClient = clientsForWamid.length === 1 ? clientsForWamid[0] : null;
    sd.actualStoredClientState = clientsForWamid.length === 1 ? 'known' : rows.length > 1 ? 'ambiguous' : 'unknown';
  }
  const failedHandling = { statusesPosted: failedMap.size, foundInOutbox: 0, recordedAsDeliveryFailed: 0, outboxStatusOfThose: {}, recipientsThatStoppedUnexplained: 0, systemAlertsMetaDeliveryFailed: Object.entries(events.alerts).filter(([k]) => k.startsWith('meta-delivery-failed')).reduce((a, [, n]) => a + n, 0) };
  for (const [wamid, recipient] of failedMap) { const rows = outboxByWamid.get(wamid) || []; const row = rows[0]; if (row) { failedHandling.foundInOutbox += 1; if (row.ds === 'failed') failedHandling.recordedAsDeliveryFailed += 1; failedHandling.outboxStatusOfThose[row.status] = (failedHandling.outboxStatusOfThose[row.status] || 0) + 1; } if (unexplainedPhones.has(String(recipient))) failedHandling.recipientsThatStoppedUnexplained += 1; }
  const clientTerminal = (outboxByDelivery.delivered || 0) + (outboxByDelivery.read || 0) + (outboxByDelivery.failed || 0);
  const deliveryByWamid = auditDeliveryByWamid({ metaAccepted: metaDump?.acceptedIds || [], terminalAcked: metaDump?.terminalAckedIds || [], webhookPosted: metaDump?.statusAckedIds || [], outboxRows: outboxRowsForAudit.map((row) => ({ wamid: row.wamid, client: row.client, status: row.status, deliveryStatus: row.ds })) });
  const harnessExpectedAudit = analyseExpectedDelivery(strict, expectedPartsFor);
  const mutatedMissing = strict[0] ? analyseExpectedDelivery([{ ...strict[0], sends: strict[0].sends.slice(1) }], expectedPartsFor) : { ok: false, failures: [{ kind: 'no_strict_participant_to_mutate' }], coverage: {} };
  const mutatedWrongOwner = strict[0] ? analyseExpectedDelivery([{ ...strict[0], sends: strict[0].sends.map((s, i) => (i === 0 ? { ...s, actualSendingClient: 'client999', actualStoredClient: 'client999' } : s)) }], expectedPartsFor) : { ok: false, failures: [{ kind: 'no_strict_participant_to_mutate' }], coverage: {} };
  const mutatedMissingOwner = strict[0] ? analyseExpectedDelivery([{ ...strict[0], sends: strict[0].sends.map((s, i) => (i === 0 ? { ...s, actualSendingClient: null, actualStoredClient: null } : s)) }], expectedPartsFor) : { ok: false, failures: [], coverage: { actualSendingCoverage: null, actualStoredCoverage: null } };
  const ownershipCoverageComplete = harnessExpectedAudit.coverage.actualSendingCoverage === 1 && harnessExpectedAudit.coverage.actualStoredCoverage === 1;
  const harnessExpectedAuditCheck = { ok: harnessExpectedAudit.ok && ownershipCoverageComplete && !mutatedMissing.ok && !mutatedWrongOwner.ok && ((mutatedMissingOwner.coverage.actualSendingCoverage !== 1) || (mutatedMissingOwner.coverage.actualStoredCoverage !== 1)), coverage: harnessExpectedAudit.coverage, failures: harnessExpectedAudit.failures.slice(0, 20), mutationFailedAsExpected: !mutatedMissing.ok, ownerMutationFailedAsExpected: !mutatedWrongOwner.ok, missingOwnerPreventsFullCoverage: (mutatedMissingOwner.coverage.actualSendingCoverage !== 1) || (mutatedMissingOwner.coverage.actualStoredCoverage !== 1), mutationFailureKinds: mutatedMissing.failures.map((f) => f.kind).concat(mutatedWrongOwner.failures.map((f) => f.kind)).slice(0, 10) };
  const deliveryAccounting = { metaAccepted: metaDump?.delivery?.accepted ?? null, metaStatusAcked: metaDump?.delivery?.statusAcked ?? null, metaTerminalAttempted: metaDump?.delivery?.terminalAttempted ?? null, metaTerminalAcked: metaDump?.delivery?.terminalAcked ?? null, metaFailedPosted: failedMap.size, metaAcceptedWithoutTerminal: metaDump?.delivery?.acceptedWithoutTerminal ?? null,
    outboxRowsWithProviderId: outboxRows, outboxByDeliveryStatus: outboxByDelivery, clientTerminalRecorded: clientTerminal, terminalPostedButNotRecordedByClient: metaDump ? metaDump.delivery.terminalAcked - clientTerminal : null, byWamid: deliveryByWamid.details, byWamidSummary: deliveryByWamid.summary, byWamidAnomalies: deliveryByWamid.anomalies, byWamidNote: deliveryByWamid.details.length ? 'all accepted wamids; state is recorded_terminal only when terminal webhook and final client outbox state agree' : 'fake Meta did not expose per-wamid accepted ids in this run', statusJournal: journal, failedHandling };
  const inboxCounts = { gateway: Object.fromEntries((await gp.query('select status, count(*)::int n from inbox_items where namespace = $1 and role = $2 group by status', [RUN, 'gateway']).catch(() => ({ rows: [] }))).rows.map((r) => [r.status, r.n])), clients: {} };
  for (const c of clients) for (const r of (await admin.query(`select status, count(*)::int n from ${c.schema}.inbox_items group by status`)).rows) inboxCounts.clients[r.status] = (inboxCounts.clients[r.status] || 0) + r.n;
  inboxCounts.clientFailedReasons = {};
  for (const c of clients) for (const r of (await admin.query(`select coalesce(resolution, '-') res, left(coalesce(last_error, '-'), 110) err, count(*)::int n from ${c.schema}.inbox_items where status = 'failed' group by 1, 2`)).rows) { const k = r.res + ' | ' + r.err; inboxCounts.clientFailedReasons[k] = (inboxCounts.clientFailedReasons[k] || 0) + r.n; }
  const lagSummary = (arr) => ({ p99Median: pct(arr.map((x) => x.p99), 50), worstP99: arr.length ? Math.max(...arr.map((x) => x.p99)) : null, max: arr.length ? Math.max(...arr.map((x) => x.max)) : null, cpuPctMax: arr.length ? Math.max(...arr.map((x) => x.cpuPct ?? 0)) : null, cpuPctMedian: pct(arr.map((x) => x.cpuPct ?? 0), 50), rssMBMax: arr.length ? Math.max(...arr.map((x) => x.rssMB)) : null, samples: arr.length,
    maxElapsedMs: arr.length ? Math.max(...arr.map((x) => x.elapsedMs ?? 0)) : null, stalledSamples_over4s: arr.filter((x) => (x.elapsedMs ?? 0) > 4000).length,
    topStalls: [...arr].sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0)).slice(0, 5).map((x) => ({ tS: Math.round((x.t - startedAt) / 1000), elapsedMs: x.elapsedMs, cpuPct: x.cpuPct, p99: x.p99, max: x.max })) });
  const clientLag = {}; for (const c of clients) clientLag[`client${c.i}`] = lagSummary(events.lag.client.filter((x) => x.name === `client${c.i}` || x.name === `client${c.i}b`));
  const hostMedian = pct(hostBusy, 50); const hostMax = hostBusy.length ? Math.max(...hostBusy) : null;
  const harnessLag = { p99: +(hist.percentile(99) / 1e6).toFixed(0), max: +(hist.max / 1e6).toFixed(0) };

  // fan-out
  const px = proxyDump; const metaStatusPosts = metaDump ? Object.values(metaDump.statusQueued).reduce((a, b) => a + b, 0) + metaDump.statusDup : null;
  const fanOut = px ? { statusCallsToClients: px.totals.status, statusWebhooksFromMeta: metaStatusPosts, statusFanOutFactor: metaStatusPosts ? +(px.totals.status / metaStatusPosts).toFixed(1) : null,
    inboundMessagesPosted: postStats.ok, pendingRouteCalls: px.totals.pending, pendingPerInbound: postStats.ok ? +(px.totals.pending / postStats.ok).toFixed(1) : null, routesCalls: px.totals.routes, clearPendingCalls: px.totals.clear, forwardedInbound: px.totals.inbound,
    gatewayToClientCallsTotal: Object.values(px.totals).reduce((a, b) => a + b, 0), statusShareOfAllCallsPct: Math.round(100 * px.totals.status / Math.max(1, Object.values(px.totals).reduce((a, b) => a + b, 0))) } : null;
  const pgTraceSummary = (() => {
    const by = {};
    for (const e of pgTrace) {
      const k = `${e.proc || '?'}:${e.via || '?'}:${e.op || '?'}`;
      const b = by[k] || (by[k] = []);
      b.push(e.ms);
    }
    return { enabled: O.pgTrace, events: pgTrace.length, dropped: pgTraceDropped, rawFile: pgTraceFile, samplePolicy: `first ${pgTraceLimit} events are retained, later events counted as dropped`, byOperation: Object.fromEntries(Object.entries(by).sort((a, b) => b[1].length - a[1].length).slice(0, 40).map(([k, arr]) => [k, stat(arr)])) };
  })();
  const responseLatencySlo7s = summarizeResponseLatencies(strict, 7000);

  // ---- verdict
  const S = O.slo; const v = [];
  const chk = (name, value, limit, unit = 'ms', category = 'validity') => v.push({ name, value, limit, ok: value !== null && value !== undefined && value <= limit, unit, category });
  chk('first response p99 (trigger -> first message)', overall.firstResponseMs.p99, S.first, 'ms', 'slo');
  chk('first response p99 during the peak', byPhase.peak.firstResponseMs.p99, S.first, 'ms', 'slo');
  chk('response to an answer p99', overall.firstResponseToAnswerMs.p99, S.reply, 'ms', 'slo');
  chk('gap between text messages p99', overall.gapAfterTextMs.p99, S.gapText, 'ms', 'slo');
  chk('gap after an image p99 (includes the wait for the delivered status)', overall.gapAfterImageMs.p99, S.gapImage, 'ms', 'slo');
  chk('whole flow, trigger -> last message p99', overall.completionMs.p99, S.complete, 'ms', 'slo');
  chk('lost messages (strict participants)', lost, 0, ''); chk('duplicate messages (strict participants)', dup, 0, ''); chk('participants with reordered messages', reordered, 0, '');
  chk('triggers that never got any response', overall.triggersWithNoResponse, 0, '');
  chk('cross-campaign messages (a message that names another campaign than the participant is in)', crossCampaignMessages, 0, '');
  chk('messages of the OLD flow still sent >10s after the participant switched campaign', staleAfterSwitch, 0, '');
  chk('strict participants that stopped for no planned reason', completion.unexplainedStop, 0, '');
  chk('strict messages without a campaign marker (fallback / invalid-reply texts; contact cards carry no text and are counted separately)', unmarkedStrict, 0, '');
  chk('accepted by Meta but no terminal status acknowledged by the gateway', deliveryAccounting.metaAcceptedWithoutTerminal, 0, '');
  chk('terminal statuses Meta posted that no client recorded in its outbox', deliveryAccounting.terminalPostedButNotRecordedByClient, 0, '');
  chk('failed statuses NOT recorded as failed in the outbox', failedHandling.statusesPosted - failedHandling.recordedAsDeliveryFailed, 0, '');
  chk('status journal entries still pending after the drain wait', journal.stillPending ?? null, 0, '');
  chk('image: next message sent before Meta posted the delivered status and not by the 20s timeout', mediaOrder.image.VIOLATION_nextSentBeforeTerminalStatusAndNotByTimeout, 0, '');
  chk('audio: next message sent before Meta posted the delivered status and not by the 20s timeout', mediaOrder.audio.VIOLATION_nextSentBeforeTerminalStatusAndNotByTimeout, 0, '');
  chk('audio clips sent as anything other than audio', audioChecks.sentAsDocumentOrOther, 0, '');
  chk('quiz question sent BEFORE the audio clip', audioChecks.questionSentBeforeAudio, 0, '');
  v.push({ name: 'independent expected-delivery and ownership audit passes; mutations fail; ownership coverage complete', value: harnessExpectedAuditCheck.ok, limit: true, ok: harnessExpectedAuditCheck.ok, unit: '', category: 'validity' });
  const resultsOk = results.every((r) => r.distinctResults >= participants.filter((p) => p.camp.key === r.campaign && !p.isNoisy).length); v.push({ name: 'every strict participant has a campaign result', value: resultsOk, limit: true, ok: resultsOk, unit: '' });
  const validity = { hostCpuBusyMedianPct: hostMedian, hostCpuBusyMaxPct: hostMax, harnessEventLoopLagMs: harnessLag, saturatedHost: hostMedian !== null && hostMedian > 85, cpuSampling: 'cpuPct = process CPU time / REAL elapsed wall time between samples; elapsedMs is reported per sample', arrival: { maxTriggersIn1s: maxIn1s, maxTriggersIn10s: maxIn10s, plannedVsActualDelayMs: arrivalDelayMs }, instrumentation: { pgTrace: O.pgTrace ? 'enabled via preload wrappers' : 'off', gatewayPoolMax: O.gatewayPoolMax || 'product default', replyModel: O.replyAfterDelivered ? 'participant waits for simulated delivered delay before thinking/replying' : 'legacy: participant replies after send request is observed' }, notMeasured: ['CPU of the fake-Meta / proxy / client processes beyond the event-loop samples', 'real Meta behaviour (latency, status timing, biz_opaque_callback_data acceptance)', 'exact delivered-to-human display time; --reply-after-delivered is still a simulator policy', 'tail compressed: not an 18h run'], note: 'All processes share one machine; where hostCpuBusy is high the measured latencies are local-load-biased, not production proof.' };

  const manifest = {
    createdAt: new Date().toISOString(),
    repo: pre.code,
    inputs: {
      argv: process.argv.slice(2),
      argvSha256: sha256(JSON.stringify(process.argv.slice(2))),
      optionsSha256: sha256(JSON.stringify(O)),
      campaignsSha256: sha256(JSON.stringify(CAMPS.map((c) => ({ key: c.key, idx: c.idx, n: c.n, peak: c.peak, spec: c.spec })))),
    },
    files: Object.fromEntries([
      'scripts/measure-peak-3campaigns.js',
      'scripts/lib/fake-meta-server.js',
      'scripts/lib/load-preload.js',
      'scripts/lib/peak-harness-analysis.js',
      'scripts/lib/analyze-gateway-trace.js',
      'scripts/inbox-test-db.js',
      'scripts/measure-preflight.js',
      path.relative(path.resolve(__dirname, '..'), path.join(dist, 'index.js')).replace(/\\/g, '/'),
    ].map((rel) => [rel, fileSha256(path.resolve(__dirname, '..', rel))])),
  };
  const summary = { label, preset: presetName, options: O, scale: SCALE, manifest, preflight: pre, validity,
    compressedRun: { triggers: totalTriggers, driveSeconds: +((driveEndedAt - driveStart) / 1000).toFixed(0), note: 'the real 18h tail is compressed into tailSeconds: the tail here is much denser than production' },
    fleet: { clients: O.clients, campaigns: CAMPS.map((c) => ({ key: c.key, participants: c.n, peak: c.peak, outbound: c.total, images: c.images, spec: c.spec })) },
    participants: { total: totalTriggers, strict: strict.length, noisy: noisy.length, abandon: participants.filter((p) => p.abandon).length, drop2: participants.filter((p) => p.drop2).length, crossover: participants.filter((p) => p.noisy.crossover).length, impatient: participants.filter((p) => p.noisy.impatient).length, doubleClick: participants.filter((p) => p.noisy.doubleClick).length, sameClient: participants.filter((p) => p.noisy.sameClient).length, dupWebhooksPosted: postStats.dupPosted },
    webhookDelivery: postStats, latency: { overall, byCampaign: byCamp, byPhase, gapByPrevious: overall.gapByPrevious, slo7s: responseLatencySlo7s, noisyHandoverToOtherCampaignMs: stat(handover), noisyOnly: analyze(noisy) },
    campaignIdentity: { crossCampaignMessages, crossStrict, foreignNoisy, staleOldFlowAfterSwitch: staleAfterSwitch, staleOldFlowAfterSwitchByKind: staleByKind, unmarkedStrictMessages: unmarkedStrict, unmarkedByType, markerlessContactCards, examples: crossExamples, switched: switchedSummary, switchedDetailed },
    completion, deliveryAccounting,
    messagesPerParticipant, mediaOrder, audioChecks, deliveryWaitTimeouts, downgradedQuestions: downgraded, filePollMs: O.filePollMs || 'default(300)',
    runShape, clientMaxSenders: O.clientMaxSenders || 'default(50)', gatewayPoolMax: O.gatewayPoolMax || 'default(10)', statusBatch: O.statusBatch, statusBatchMax: O.statusBatchMax || 'default(20)', journalWrites: lastJW, clientFlush: lastFL, pgTrace: pgTraceSummary,
    firstResponseBreakdown, slotHoldByCampaign, clientQueue, clientQueueSeriesColumns: ['tS', 'sqlProcessing', 'sqlQueued', 'sqlOldestWaitingMs', 'healthProcessing(<=5s stale)', 'healthInboxOldestDueMs'], healthSamples: healthSeries.length,
    duplicateDetail, reorderDetail, injectedFaults: { fromMeta: metaDump && metaDump.injected ? metaDump.injected.counts : null, retriedMessages: metaDump ? metaDump.retriedMessages : null, messagesWithAttempts: metaDump ? metaDump.messagesWithAttempts : null, lostResponseOutcomes: lostSummary, faultOutcomes, rejected5xxAnd429: metaFaults.length, fullLists: metaDump && metaDump.injected ? { lostResp: metaDump.injected.lostResp, err5xx: metaDump.injected.err5xx, failedStatus: metaDump.injected.failedStatus, slowTail: metaDump.injected.slowTail, dupStatus: metaDump.injected.dupStatus } : null },
    integrity: { lostMessages: lost, duplicateMessages: dup, participantsWithReorderedMessages: reordered, participantsShort: shortParticipants, examples, campaignResults: results, expectedDeliveryAudit: harnessExpectedAuditCheck },
    fanOut, proxy: px, fakeMeta: metaDump, statusJournal: journal, gatewayRouteMs: stat(routeMs),
    eventLoop: { gateway: lagSummary(events.lag.gateway), clients: clientLag }, logs: events.logs, systemAlerts: events.alerts, inbox: inboxCounts,
    faults: faultLog, timeline, verdict: v, host: { cpu: os.cpus()[0].model, threads: os.cpus().length, ramGB: Math.round(os.totalmem() / 1e9), node: process.version }, durationS: +((endedAt - startedAt) / 1000).toFixed(0) };
  const dateTag = new Date().toISOString().slice(0, 10);
  if (O.gatewayTrace) {
    fs.writeFileSync(resultsPath(`peak-${label}-gt.jsonl`), gtEvents.map((e) => JSON.stringify(e)).join('\n'));
    fs.writeFileSync(resultsPath(`peak-${label}-msgs.json`), JSON.stringify({ startedAt, endedAt, strictParticipants: strict.length, totalParticipants: participants.length, inbound: Object.fromEntries([...msgInfo].map(([id, v]) => [id, { ...v, ackArrival: ackAt.get(id), routedLogArrival: routedAt.get(id), pickupLogArrival: pickupAt.get(id) }])) }));
    summary.gatewayTrace = { events: gtEvents.length, file: `peak-${label}-gt.jsonl` };
  }
  const jsonFile = resultsPath(`peak-${label}-${dateTag}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(summary, null, 1));
  if (events.gwLines.length) fs.writeFileSync(resultsPath(`peak-${label}-${dateTag}-errors.log`), events.gwLines.join('\n'));

  // ---- human summary
  const f = (s) => (s ? `${s.p50}/${s.p95}/${s.p99}/${s.max} (n=${s.n})` : '-');
  const L = [];
  L.push(`\n================ PEAK RESULT  ${label}  preset=${presetName}  scale=${SCALE} ================`);
  L.push(`participants ${totalTriggers} (strict ${strict.length}, noisy ${noisy.length}) | fleet ${O.clients} clients on one number | run ${summary.durationS}s | host cpu median/max ${hostMedian}%/${hostMax}%${validity.saturatedHost ? '  ** HOST SATURATED: results pessimistic **' : ''}`);
  L.push(`columns: p50/p95/p99/max in ms`);
  L.push(`first response (trigger -> 1st message)   ${f(overall.firstResponseMs)}`);
  L.push(`   during the peak                         ${f(byPhase.peak.firstResponseMs)}`);
  L.push(`   during the tail                         ${f(byPhase.tail.firstResponseMs)}`);
  for (const c of CAMPS) L.push(`   campaign ${c.key}                            ${f(byCamp[c.key].firstResponseMs)}`);
  L.push(`first message after an ANSWER             ${f(overall.firstResponseToAnswerMs)}`);
  L.push(`gap between text messages                 ${f(overall.gapAfterTextMs)}`);
  L.push(`gap text -> media                         ${f(overall.gapByPrevious.textToMediaMs)}`);
  L.push(`gap after audio                           ${f(overall.gapByPrevious.audioToNextMs)} (informational)`);
  L.push(`gap after an image (waits for delivered)  ${f(overall.gapAfterImageMs)}`);
  L.push(`whole flow (trigger -> last message)      ${f(overall.completionMs)}`);
  L.push(`per message index, ms since its cause (p50/p99):  ` + Object.entries(overall.byMessageIndex).map(([k, x]) => `#${k}:${x.sinceCause.p50}/${x.sinceCause.p99}`).join('  '));
  if (handover.length) L.push(`crossover handover (other trigger -> first msg)  ${f(stat(handover))}`);
  if (fanOut) L.push(`fan-out: ${fanOut.statusWebhooksFromMeta} status webhooks -> ${fanOut.statusCallsToClients} calls to clients (x${fanOut.statusFanOutFactor}); ${fanOut.pendingRouteCalls} pending-route calls for ${fanOut.inboundMessagesPosted} inbound (x${fanOut.pendingPerInbound}); status = ${fanOut.statusShareOfAllCallsPct}% of all gateway->client calls`);
  if (px) L.push(`status lag at the owning client (Meta posted -> client received): delivered ${f(px.statusLagMs.delivered)}  read ${f(px.statusLagMs.read)}`);
  if (metaDump) L.push(`fake Meta: accepted ${metaDump.accepted} (text ${metaDump.text}, image ${metaDump.image}, buttons ${metaDump.interactive}); 429s ${metaDump.r429}; 5xx ${metaDump.r5xx}; response-lost ${metaDump.lost}; gateway answered status webhooks p50/p99/max ${metaDump.gatewayAckMs.p50}/${metaDump.gatewayAckMs.p99}/${metaDump.gatewayAckMs.max}ms; gave up ${metaDump.statusGaveUp}`);
  L.push(`gateway event loop p99 worst ${summary.eventLoop.gateway.worstP99}ms max ${summary.eventLoop.gateway.max}ms cpu median/max ${summary.eventLoop.gateway.cpuPctMedian}/${summary.eventLoop.gateway.cpuPctMax}%  | route_ms ${f(summary.gatewayRouteMs)}`);
  L.push(`integrity: lost ${lost}, duplicate ${dup}, reordered participants ${reordered}, short participants ${shortParticipants}; results ${results.map((r) => `${r.campaign} ${r.distinctResults}/${r.triggers}`).join(', ')}`);
  const fseg = (x) => (x ? `${x.p50}/${x.p95}/${x.p99} (n=${x.n})` : '-');
  L.push(`run shape: triggers done ${runShape.triggersDoneAtS}s | flows finished ${runShape.flowsFinishedAtS}s | status forwarding finished ${runShape.statusForwardingDoneAtS}s (${runShape.finalStatusCalls} calls, avg ${runShape.avgStatusCallsPerSecond}/s) | PostgreSQL connections max ${runShape.pgConnections.max} of ${runShape.pgConnections.serverLimit} | client cap ${O.clientMaxSenders || 'default 50'} | gateway pool ${O.gatewayPoolMax || 'default 10'}`);
  L.push(`arrival generator delay planned->actual ms: ${f(runShape.arrivalDelayMs)} | reply model: ${O.replyAfterDelivered ? 'after simulated delivered' : 'legacy send-observed'}`);
  L.push(`pg trace: ${pgTraceSummary.enabled ? `${pgTraceSummary.events} events, dropped ${pgTraceSummary.dropped}, raw ${pgTraceSummary.rawFile}` : 'off'}; top ops ${JSON.stringify(Object.fromEntries(Object.entries(pgTraceSummary.byOperation || {}).slice(0, 5).map(([k, v]) => [k, `${v.p50}/${v.p95}/${v.p99} n=${v.n}`])))}`);
  L.push(`status transport (META_STATUS_BATCH=${O.statusBatch}): ${px ? px.statusRequestsTotal : '-'} HTTP requests carrying ${px ? px.statusItemsTotal : '-'} statuses; statuses per request p50/p95/max ${px && px.statusBatchSize ? `${px.statusBatchSize.p50}/${px.statusBatchSize.p95}/${px.statusBatchSize.max}` : '-'}; requests with >1 status ${px ? px.statusBatchSizeOver1 : '-'}`);
  L.push(`gateway status-journal writes (exact, measured inside the process): ${lastJW ? `${lastJW.appends} appends / ${lastJW.appendedLines} lines / ${Math.round(lastJW.appendedBytes / 1024)}KB, ${lastJW.appendMs}ms blocked in appendFileSync; ${lastJW.rewrites} compaction rewrites, ${lastJW.rewriteMs}ms` : 'n/a'}`);
  { const k = Object.keys(lastFL).sort(); const tot = k.reduce((o, c) => { for (const x of ['calls', 'ms', 'epCalls', 'epMs', 'epRequests']) o[x] = (o[x] || 0) + lastFL[c][x]; return o; }, {});
    L.push(`client Storage.flush() calls: ${tot.calls} total (waited ${Math.round((tot.ms || 0) / 1000)}s in aggregate); made while serving the gateway status endpoint: ${tot.epCalls} flushes for ${tot.epRequests} requests (waited ${Math.round((tot.epMs || 0) / 1000)}s); client0: ${lastFL.client0 ? lastFL.client0.calls + ' flushes, ' + lastFL.client0.epCalls + ' on ' + lastFL.client0.epRequests + ' endpoint requests' : '-'}`); }
  { const a = messagesPerParticipant.allParticipants, st2 = messagesPerParticipant.strictParticipants;
    L.push(`KPI outbound messages per participant: ${a.messagesPerParticipant} (all ${a.participants}; Meta accepted ${messagesPerParticipant.metaAcceptedPerParticipant}), strict ${st2.messagesPerParticipant}; text ${a.perParticipantByKind.text} / media ${a.perParticipantByKind.media} / question ${a.perParticipantByKind.question}; extra copies ${a.extraCopiesPerParticipant} per participant (${a.extraCopies})`);
    for (const [k, v] of Object.entries(messagesPerParticipant.byCampaign)) L.push(`   ${k}: planned ${v.plannedFullFlow} (text ${v.planned.text}, media ${v.planned.media}, question ${v.planned.question}) | actual per participant ${v.all.messagesPerParticipant} (text ${v.all.perParticipantByKind.text}, media ${v.all.perParticipantByKind.media}, question ${v.all.perParticipantByKind.question}, extra copies ${v.all.extraCopiesPerParticipant}) | completed-flow participants ${v.completedFullFlowOnly.messagesPerParticipant}`); }
  L.push(`media order (next message vs Meta's delivered): image ${JSON.stringify({ sends: mediaOrder.image.sends, afterDelivered: mediaOrder.image.nextWasSentAfterTerminalStatus, byTimeout: mediaOrder.image.nextWasSentByTimeout, VIOLATIONS: mediaOrder.image.VIOLATION_nextSentBeforeTerminalStatusAndNotByTimeout })} | audio ${JSON.stringify({ sends: mediaOrder.audio.sends, afterDelivered: mediaOrder.audio.nextWasSentAfterTerminalStatus, byTimeout: mediaOrder.audio.nextWasSentByTimeout, VIOLATIONS: mediaOrder.audio.VIOLATION_nextSentBeforeTerminalStatusAndNotByTimeout })}`);
  L.push(`audio quiz: ${JSON.stringify(audioChecks)}`);
  L.push(`wait-for-delivered timeouts (${deliveryWaitTimeouts.total} of ${deliveryWaitTimeouts.ofMediaSendsWithANextStep} media sends): by reason ${JSON.stringify(deliveryWaitTimeouts.byReason)}; by type ${JSON.stringify(deliveryWaitTimeouts.byType)}; by campaign ${JSON.stringify(deliveryWaitTimeouts.byCampaign)}; by phase ${JSON.stringify(deliveryWaitTimeouts.byPhase)}`);
  L.push(`questions downgraded to text: ${JSON.stringify(downgraded)} (summary field downgradedQuestions)`);
  L.push(`client storage lookups by the file-delivery wait (getOutboxMessage): ${Object.values(lastFL).reduce((a, x) => a + (x.outboxLookups || 0), 0)} total, poll interval ${O.filePollMs || 'default 300'}ms`);
  L.push('--- first response split (p50/p95/p99 ms): post->gateway ack | ack->forwarded (gateway) | forwarded log->client inbound log (proxy for slot/start delay, not direct cap wait) | client inbound log->first message | total ---');
  for (const [k, v] of Object.entries(firstResponseBreakdown)) { if (k === 'peakWindowOnly') continue; L.push(`  ${k}: ${fseg(v.postToGatewayAck)} | ${fseg(v.gatewayAckToForwarded)} | ${fseg(v.forwardedToClientPickup_waitForSlot)} | ${fseg(v.pickupToFirstMessage_work)} | ${fseg(v.total)}`); }
  for (const [k, v] of Object.entries(slotHoldByCampaign)) L.push(`  trigger-round proxy (client inbound log -> first question out) ${k}: ${fseg(v.round0_holdMs)}; includes observed gaps after images: ${fseg(v.round0_timeSpentWaitingAfterImagesMs)}`);
  for (const k of ['client0', 'client1', 'client2', 'client3']) { const q = clientQueue[k]; if (q) L.push(`  ${k} inbox (SQL exact): max processing ${q.sql.maxProcessing}, >=50 for ${q.sql.secondsAt50OrMore}s, >40 for ${q.sql.secondsAbove40}s, max queued ${q.sql.maxQueued}, oldest waiting ${q.sql.maxOldestWaitingMs}ms | /health: max processing ${q.health.maxProcessing}, oldestDue ${q.health.maxInboxOldestDueMs}ms, flow inboundQueued ${q.health.maxFlowInboundQueued}, activeSenderQueues ${q.health.maxActiveSenderQueues}, pending conversations ${q.health.maxPendingConversations}`); }
  for (const k of ['client0', 'client1', 'client2']) { const q = clientQueue[k]; if (q) L.push(`  ${k} processing/queued over time (SQL, every ~10s, t:proc/queued): ` + q.series.filter((_, i) => i % Math.max(1, Math.round(10 / q.sampleEveryS)) === 0).map((r) => `${Math.round(r[0])}:${r[1]}/${r[2]}`).join(' ')); }
  L.push(`injected faults (identity-keyed): ${JSON.stringify(metaDump && metaDump.injected ? metaDump.injected.counts : null)}; messages that needed a retry ${metaDump ? metaDump.retriedMessages : null} of ${metaDump ? metaDump.messagesWithAttempts : null}; response-lost -> duplicate ${lostSummary.becameDuplicate} of ${lostSummary.injected} (not resent: ${lostSummary.notResent})`);
  L.push(`duplicates explained: ${JSON.stringify(duplicateDetail.reduce((a, d) => { a[d.reason] = (a[d.reason] || 0) + 1; return a; }, {}))}; reorders: ${reorderDetail.length} (retry involved in ${reorderDetail.filter((r) => r.anyRetryInvolved).length})`);
  L.push(`expected delivery/ownership audit: ${harnessExpectedAuditCheck.ok ? 'PASS' : 'FAIL'}; coverage=${JSON.stringify(harnessExpectedAuditCheck.coverage)}; mutation failed=${harnessExpectedAuditCheck.mutationFailedAsExpected}; owner mutation failed=${harnessExpectedAuditCheck.ownerMutationFailedAsExpected}; failures=${JSON.stringify(harnessExpectedAuditCheck.failures.slice(0, 5))}`);
  L.push(`campaign identity: crossCampaignMessages=${crossCampaignMessages} (strict ${crossStrict}, noisy foreign ${foreignNoisy}); old-flow messages >10s after a switch=${staleAfterSwitch}; strict messages without a marker=${unmarkedStrict} ${JSON.stringify(unmarkedByType)} (+${markerlessContactCards} contact cards, which can never carry one)`);
  for (const w of switchedSummary) L.push(`   switch ${w.kind}: ${w.participants} participants, ${w.gotTargetFirstMessage} got the target's first message, ${w.completedTargetFlow} completed the target flow; handover->first message ${f(w.handoverToFirstMessageMs)}`);
  L.push(`completion (strict ${strict.length}): full flow ${completion.fullFlow} | planned abandon after Q1 ${completion.plannedAbandonAfterQ1}, after Q2 ${completion.plannedAbandonAfterQ2} | STOPPED WITHOUT A PLANNED REASON ${completion.unexplainedStop}`);
  L.push(`delivery: Meta accepted ${deliveryAccounting.metaAccepted}, terminal status acked by gateway ${deliveryAccounting.metaTerminalAcked} (failed ${deliveryAccounting.metaFailedPosted}), without terminal ${deliveryAccounting.metaAcceptedWithoutTerminal}; clients recorded terminal ${deliveryAccounting.clientTerminalRecorded} of ${deliveryAccounting.outboxRowsWithProviderId} outbox rows ${JSON.stringify(outboxByDelivery)}; posted-but-unrecorded ${deliveryAccounting.terminalPostedButNotRecordedByClient}`);
  L.push(`failed statuses: posted ${failedHandling.statusesPosted}, found in outbox ${failedHandling.foundInOutbox}, recorded as failed ${failedHandling.recordedAsDeliveryFailed}, outbox status ${JSON.stringify(failedHandling.outboxStatusOfThose)}, recipients that stopped unexplained ${failedHandling.recipientsThatStoppedUnexplained}, system alerts ${failedHandling.systemAlertsMetaDeliveryFailed}`);
  L.push(`status journal after drain wait (${drainWaitedS}s): ${JSON.stringify(journal)}`);
  L.push(`gateway cpu samples: max elapsed between samples ${summary.eventLoop.gateway.maxElapsedMs}ms, samples >4s ${summary.eventLoop.gateway.stalledSamples_over4s}, top stalls ${JSON.stringify(summary.eventLoop.gateway.topStalls)}`);
  L.push(`arrival: max triggers in 1s ${maxIn1s}, in 10s ${maxIn10s}`);
  L.push(`inbox: gateway ${JSON.stringify(inboxCounts.gateway)} clients ${JSON.stringify(inboxCounts.clients)} client failed reasons ${JSON.stringify(inboxCounts.clientFailedReasons)}`);
  L.push(`logs: ${JSON.stringify(events.logs)}`);
  L.push(`alerts: ${JSON.stringify(events.alerts)}`);
  L.push(`faults: ${faultLog.map((x) => `${x.spec}@${x.realAtS}s${x.error ? ' ERROR ' + x.error : ''}`).join(' ; ') || 'none'}`);
  L.push(`--- verdict ---`);
  for (const x of v) L.push(`${x.ok ? 'PASS' : 'FAIL'}  [${x.category || 'validity'}] ${x.name}: ${x.value}${x.unit} (limit ${x.limit}${x.unit})`);
  L.push(`full data: ${jsonFile}`);
  const text = L.join('\n'); console.log(text);
  fs.writeFileSync(resultsPath(`peak-${label}-${dateTag}.txt`), text);

  // ---- teardown
  for (const p of [...procs].reverse()) await stopProc(p, 'SIGTERM', 12000);
  await gp.query('delete from inbox_items where namespace = $1', [RUN]).catch(() => {}); await gp.query('delete from inbox_senders where namespace = $1', [RUN]).catch(() => {}); await gp.end().catch(() => {});
  for (const c of clients) await admin.query(`drop schema if exists ${c.schema} cascade`);
  await admin.end(); agent.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(v.filter((x) => (x.category || 'validity') !== 'slo').every((x) => x.ok) ? 0 : 1);
})().catch(async (e) => { console.error('HARNESS FAILED:', e); for (const p of procs) { try { p.child.kill('SIGKILL'); } catch { /* gone */ } } process.exit(2); });
