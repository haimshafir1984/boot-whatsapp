#!/usr/bin/env node
/**
 * Stage E / C1 - does the inbox cost of ONE operation grow with the retained history and the active backlog?
 * Measures (per operation) wall time, bytes written to disk, bytes serialized and array elements scanned, against a fixed
 * base SHA. Criteria are declared in docs/stage-e-design-2026-09-21.md section 8.2 and CODED BELOW before any run; they are
 * never changed after seeing a result.
 *
 *   node scripts/measure-inbox-accumulation.js --dist <dir>/dist --out <file.json> [--cells all|H:B[,H:B...]] [--ops 40]
 *   (child mode, used internally:)  --child --cell <json> --dist ... --out ...
 *
 * The class under test is MetaGatewayInbox (src/metaGatewayInbox.ts). One node process per cell; cells run sequentially.
 * Three passes per cell, in this order, so instrumentation never taints timing:
 *   1. TIMING    - wall time per operation (no counters on the hot path except the cheap fs byte counters)
 *   2. COUNTERS  - the same operations again with element-scan / serialization counters
 *   3. LAG       - a 150-message burst with event-loop-delay sampling (gateway-shaped: enqueue + claim + complete)
 * ACTUAL item counts (by status) are recorded after seeding, after the first enqueue (the inbox prunes `completed`), and at
 * the end. The number reported as "history" is the ACTUAL one, never the seeded one.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { preflight, resultsPath } = require('./measure-preflight');

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes('--' + name);

// ------------------------------------------------------------------------------------------------------------------
// Criteria (fixed before running; mirrors design doc section 8.2)
// ------------------------------------------------------------------------------------------------------------------
const CRITERIA = {
  // evaluated on the single-item update operation `markRetry`, cell (H=50000,B=5000) vs (H=300,B=0)
  bytesWrittenRatioMin: 50,
  scannedAtLeastFractionOfItems: 0.9,     // scanned >= 0.9 * (actual total items at the time)
  p95TimeRatioMin: 10,
  // feedback loop: cost of ONE markRetry as a function of B at H=300
  backlogSlopeRatioMin: 5,                // (B=5000) / (B=0)
};
const H_LIST = [300, 5000, 50000];
const B_LIST = [0, 500, 5000];
const EXTRA_SCENARIOS = ['blocked-one', 'blocked-many'];

const payloadFor = (id, from, phoneNumberId = '1207335449126872') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1000000000000', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '972529771002', phone_number_id: phoneNumberId },
    contacts: [{ profile: { name: 'Participant ' + from.slice(-4) }, wa_id: from }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'option-mrnlvats-20fv', title: 'Yes please' } } }],
  } }] }],
});
const senderOf = (i, pool = 1000) => '9725' + String(10_000_000 + (i % pool));
const senderKey = (item) => {
  const v = item.payload?.entry?.[0]?.changes?.[0]?.value;
  return `${v?.metadata?.phone_number_id || ''}:${v?.messages?.[0]?.from || ''}`;
};

const percentile = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const stats = (arr) => ({ n: arr.length, p50: +percentile(arr, 50).toFixed(3), p95: +percentile(arr, 95).toFixed(3), max: +Math.max(...arr, 0).toFixed(3), mean: +(arr.reduce((a, b) => a + b, 0) / (arr.length || 1)).toFixed(3) });

// ------------------------------------------------------------------------------------------------------------------
// CHILD: one cell
// ------------------------------------------------------------------------------------------------------------------
function seedFile(file, cell) {
  const now = new Date();
  const items = [];
  const iso = (ms) => new Date(now.getTime() + ms).toISOString();
  let n = 0;
  const add = (status, sender, extra = {}) => {
    n += 1;
    const id = `wamid.SEED${String(n).padStart(8, '0')}`;
    items.push({ id, payload: payloadFor(id, sender), status, attempts: 0, createdAt: iso(-3_600_000 + n), updatedAt: iso(-3_000_000 + n), ...extra });
  };
  // history that the inbox never prunes: failed + held (half each). `completed` is seeded ONLY in the prune-verification cell.
  for (let i = 0; i < cell.H; i++) add(i % 2 ? 'held' : 'failed', senderOf(i, 2000), { lastError: 'seeded history', attempts: 60 });
  if (cell.completed) for (let i = 0; i < cell.completed; i++) add('completed', senderOf(i, 2000), { updatedAt: iso(-60_000 - i) });
  // active backlog: retries that are NOT due yet (each on its own sender - so each is a blocked head)
  for (let i = 0; i < cell.B; i++) add('retry', '9726' + String(10_000_000 + i), { attempts: 3, nextAttemptAt: iso(3_600_000), lastError: 'routing incomplete' });
  if (cell.scenario === 'blocked-one') {
    const s = '97270000001';
    add('retry', s, { attempts: 5, nextAttemptAt: iso(3_600_000) });
    for (let i = 0; i < 200; i++) add('queued', s);
  }
  if (cell.scenario === 'blocked-many') {
    for (let i = 0; i < 500; i++) { const s = '9727' + String(1_000_000 + i); add('retry', s, { attempts: 5, nextAttemptAt: iso(3_600_000) }); for (let k = 0; k < 3; k++) add('queued', s); }
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, items }), 'utf8');
  return items.length;
}

function installByteCounters() {
  const c = { written: 0, copied: 0, renames: 0, writes: 0, stringified: 0, on: false };
  const w = fs.writeFileSync, cp = fs.copyFileSync, rn = fs.renameSync, js = JSON.stringify;
  fs.writeFileSync = function (f, data, ...r) { if (c.on) { c.written += typeof data === 'string' ? data.length : (data.length || 0); c.writes += 1; } return w.call(fs, f, data, ...r); };
  fs.copyFileSync = function (a, b, ...r) { if (c.on) { try { c.copied += fs.statSync(a).size; } catch { /* ignore */ } } return cp.call(fs, a, b, ...r); };
  fs.renameSync = function (a, b) { if (c.on) c.renames += 1; return rn.call(fs, a, b); };
  JSON.stringify = function (...a) { const out = js.apply(JSON, a); if (c.on && typeof out === 'string') c.stringified += out.length; return out; };
  return c;
}

function installScanCounters() {
  const s = { on: false, elements: 0 };
  const AP = Array.prototype;
  const MIN = 100;                                   // only large arrays: the items collection, not tiny helper arrays
  for (const m of ['find', 'findIndex', 'some', 'every', 'filter', 'map', 'forEach', 'reduce', 'flatMap']) {
    const orig = AP[m];
    Object.defineProperty(AP, m, { configurable: true, writable: true, value: function (cb, ...rest) {
      if (!s.on || this.length < MIN || typeof cb !== 'function') return orig.call(this, cb, ...rest);
      const wrapped = m === 'reduce' ? function (acc, ...x) { s.elements += 1; return cb.call(this, acc, ...x); } : function (...x) { s.elements += 1; return cb.apply(this, x); };
      return orig.call(this, wrapped, ...rest);
    } });
  }
  for (const m of ['sort', 'slice', 'indexOf', 'includes', 'concat']) {
    const orig = AP[m];
    Object.defineProperty(AP, m, { configurable: true, writable: true, value: function (...a) { if (s.on && this.length >= MIN) s.elements += this.length; return orig.apply(this, a); } });
  }
  const iter = AP[Symbol.iterator];
  Object.defineProperty(AP, Symbol.iterator, { configurable: true, writable: true, value: function () {
    const it = iter.call(this); const count = s.on && this.length >= MIN;
    if (!count) return it;
    return { next() { const r = it.next(); if (!r.done) s.elements += 1; return r; }, [Symbol.iterator]() { return this; } };
  } });
  return s;
}

async function runChild() {
  const cell = JSON.parse(arg('cell'));
  const dist = path.resolve(arg('dist'));
  const { MetaGatewayInbox } = require(path.join(dist, 'metaGatewayInbox'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-c1-'));
  const file = path.join(dir, 'inbox.json');
  const seeded = seedFile(file, cell);
  const fileBytesSeeded = fs.statSync(file).size;
  const OPS = Number(arg('ops', '40'));
  const bytes = installByteCounters();
  const scan = installScanCounters();
  const inbox = new MetaGatewayInbox(file);
  const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);
  const countsSeeded = inbox.counts();
  const record = { cell, seeded, fileBytesSeeded, counts: { afterSeed: { ...countsSeeded, total: total(countsSeeded) } } };

  let idCounter = 0;
  const newId = () => `wamid.OP${cell.pass || 'x'}${String(++idCounter).padStart(8, '0')}`;
  const opsRun = (label) => {
    // returns per-op sample lists for: enqueue, claim, retry, complete, idle
    const out = { enqueue: [], claim: [], retry: [], complete: [], idle: [] };
    const ids = [];
    const measure = (bucket, fn) => { const t0 = process.hrtime.bigint(); const r = fn(); out[bucket].push(Number(process.hrtime.bigint() - t0) / 1e6); return r; };
    const perOpCounters = { enqueue: [], claim: [], retry: [], complete: [], idle: [] };
    const wrap = (bucket, fn) => {
      const b0 = { w: bytes.written, c: bytes.copied, s: bytes.stringified }, e0 = scan.elements;
      const r = measure(bucket, fn);
      perOpCounters[bucket].push({ written: bytes.written - b0.w, copied: bytes.copied - b0.c, stringified: bytes.stringified - b0.s, scanned: scan.elements - e0 });
      return r;
    };
    for (let i = 0; i < OPS * 2; i++) { const id = newId(); ids.push(id); wrap('enqueue', () => inbox.enqueue(id, payloadFor(id, '9728' + String(1_000_000 + idCounter)))); }
    if (label === 'first') record.counts.afterFirstEnqueues = { ...inbox.counts(), total: total(inbox.counts()) };
    const claimed = [];
    for (let i = 0; i < OPS * 2; i++) { const got = wrap('claim', () => inbox.claimBatch(1, senderKey)); if (got[0]) claimed.push(got[0]); }
    // Claiming with limit 1 walks the whole collection each time; that is exactly the cost being measured.
    for (let i = 0; i < Math.min(OPS, claimed.length); i++) wrap('retry', () => inbox.markRetry(claimed[i].id, new Error('routing incomplete'), new Date(Date.now() + 3_600_000)));
    for (let i = OPS; i < Math.min(OPS * 2, claimed.length); i++) wrap('complete', () => inbox.markCompleted(claimed[i].id));
    for (let i = 0; i < OPS; i++) wrap('idle', () => inbox.claimBatch(20, senderKey));   // nothing is due: an idle poll tick
    return { out, perOpCounters };
  };

  bytes.on = true;
  const timing = opsRun('first');
  bytes.on = false;
  record.timingMs = Object.fromEntries(Object.entries(timing.out).map(([k, v]) => [k, stats(v)]));
  record.bytesPerOpTimingPass = Object.fromEntries(Object.entries(timing.perOpCounters).map(([k, v]) => [k, { written: Math.round(v.reduce((a, x) => a + x.written, 0) / (v.length || 1)), copied: Math.round(v.reduce((a, x) => a + x.copied, 0) / (v.length || 1)) }]));

  cell.pass = 'c';
  bytes.on = true; scan.on = true;
  const counted = opsRun('second');
  bytes.on = false; scan.on = false;
  const avg = (arr, k) => Math.round(arr.reduce((a, x) => a + x[k], 0) / (arr.length || 1));
  record.perOp = Object.fromEntries(Object.entries(counted.perOpCounters).map(([k, v]) => [k, { scanned: avg(v, 'scanned'), stringified: avg(v, 'stringified'), written: avg(v, 'written'), copied: avg(v, 'copied'), n: v.length }]));
  record.counts.afterOps = { ...inbox.counts(), total: total(inbox.counts()) };

  // LAG pass: gateway-shaped burst of 150 (enqueue, then claim/complete cycles) yielding to the loop between calls.
  const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
  const tickLags = []; let last = process.hrtime.bigint();
  const heartbeat = setInterval(() => { const now = process.hrtime.bigint(); tickLags.push(Number(now - last) / 1e6 - 10); last = now; }, 10);
  await new Promise((r) => setTimeout(r, 30));
  const burstStart = Date.now();
  for (let i = 0; i < 150; i++) { const id = newId(); inbox.enqueue(id, payloadFor(id, '9729' + String(1_000_000 + i))); await new Promise((r) => setImmediate(r)); }
  for (let i = 0; i < 150; i += 20) { const got = inbox.claimBatch(20, senderKey); for (const g of got) inbox.markCompleted(g.id); await new Promise((r) => setImmediate(r)); }
  const burstMs = Date.now() - burstStart;
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(heartbeat); h.disable();
  record.lag = { burstMs, eventLoopDelayMs: { p99: +(h.percentile(99) / 1e6).toFixed(2), max: +(h.max / 1e6).toFixed(2) }, heartbeatLagMs: { p99: +percentile(tickLags, 99).toFixed(2), max: +Math.max(...tickLags, 0).toFixed(2) } };
  record.counts.end = { ...inbox.counts(), total: total(inbox.counts()) };
  record.fileBytesEnd = fs.statSync(file).size;
  fs.writeFileSync(arg('out'), JSON.stringify(record));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------------------------------------
// PARENT: matrix + evaluation
// ------------------------------------------------------------------------------------------------------------------
function cellsToRun() {
  const spec = arg('cells', 'all');
  if (spec !== 'all') return spec.split(',').map((s) => { const [H, B, scenario] = s.split(':'); return { H: Number(H), B: Number(B || 0), scenario: scenario || 'base' }; });
  const cells = [];
  for (const H of H_LIST) for (const B of B_LIST) cells.push({ H, B, scenario: 'base' });
  for (const H of H_LIST) for (const scenario of EXTRA_SCENARIOS) cells.push({ H, B: 0, scenario });
  cells.push({ H: 0, B: 0, completed: 50000, scenario: 'prune-verification' });
  return cells;
}

function evaluate(results) {
  const find = (H, B, scenario = 'base') => results.find((r) => r.cell.H === H && r.cell.B === B && (r.cell.scenario || 'base') === scenario);
  const lo = find(300, 0), hi = find(50000, 5000), b0 = find(300, 0), b5 = find(300, 5000);
  if (!lo || !hi) return { evaluated: false, reason: 'cells (300,0) and (50000,5000) were not both run' };
  const totalItemsHi = hi.counts.afterOps.total;
  const ratio = (a, b) => (b > 0 ? +(a / b).toFixed(2) : Infinity);
  const r = {
    evaluated: true,
    op: 'markRetry',
    bytesWrittenPerOp: { lo: lo.perOp.retry.written + lo.perOp.retry.copied, hi: hi.perOp.retry.written + hi.perOp.retry.copied },
    scannedPerOp: { lo: lo.perOp.retry.scanned, hi: hi.perOp.retry.scanned, actualTotalItemsAtHi: totalItemsHi },
    p95Ms: { lo: lo.timingMs.retry.p95, hi: hi.timingMs.retry.p95 },
  };
  r.c1_bytesRatio = ratio(r.bytesWrittenPerOp.hi, r.bytesWrittenPerOp.lo);
  r.c1_pass = r.c1_bytesRatio >= CRITERIA.bytesWrittenRatioMin;
  r.c2_scannedFraction = +(hi.perOp.retry.scanned / Math.max(1, totalItemsHi)).toFixed(3);
  r.c2_pass = r.c2_scannedFraction >= CRITERIA.scannedAtLeastFractionOfItems;
  r.c3_p95Ratio = ratio(r.p95Ms.hi, r.p95Ms.lo);
  r.c3_pass = r.c3_p95Ratio >= CRITERIA.p95TimeRatioMin;
  if (b0 && b5) {
    r.slope = { b0P50: b0.timingMs.retry.p50, b5000P50: b5.timingMs.retry.p50, ratio: ratio(b5.timingMs.retry.p50, b0.timingMs.retry.p50), bytesRatio: ratio(b5.perOp.retry.written + b5.perOp.retry.copied, b0.perOp.retry.written + b0.perOp.retry.copied) };
    r.slope_pass = r.slope.ratio >= CRITERIA.backlogSlopeRatioMin;
  }
  r.mechanismProven = r.c1_pass && r.c2_pass;
  r.timeReproduced = r.c3_pass;
  r.verdict = r.mechanismProven && r.timeReproduced ? 'DEGRADATION REPRODUCED (mechanism + time)'
    : r.mechanismProven ? 'MECHANISM PROVEN (bytes + scan), time criterion NOT met on this hardware'
    : 'NOT REPRODUCED - stop and report what is proven and what is missing';
  return r;
}

function main() {
  const dist = path.resolve(arg('dist'));
  const outFile = arg('out', resultsPath('e-c1-baseline-' + new Date().toISOString().slice(0, 10) + '.json'));
  const pre = preflight();
  if (!dist || !outFile) { console.error('usage: --dist <dir>/dist --out <file.json>'); process.exit(2); }
  const criteriaSha = crypto.createHash('sha256').update(JSON.stringify({ CRITERIA, H_LIST, B_LIST, EXTRA_SCENARIOS })).digest('hex').slice(0, 16);
  const scriptSha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 16);
  console.log(`criteria sha=${criteriaSha} script sha=${scriptSha} dist=${dist}`);
  const results = [];
  const cells = cellsToRun();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-c1-out-'));
  for (const cell of cells) {
    const cellOut = path.join(tmp, `cell-${cell.H}-${cell.B}-${cell.scenario}.json`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--max-old-space-size=4096', __filename, '--child', '--cell', JSON.stringify(cell), '--dist', dist, '--out', cellOut, '--ops', arg('ops', '40')], { encoding: 'utf8', timeout: 1_800_000, maxBuffer: 64 << 20 });
    if (r.status !== 0) { console.log(`CELL ${JSON.stringify(cell)} FAILED exit=${r.status} ${(r.stderr || '').slice(0, 300)}`); results.push({ cell, error: (r.stderr || 'failed').slice(0, 500) }); continue; }
    const rec = JSON.parse(fs.readFileSync(cellOut, 'utf8'));
    results.push(rec);
    console.log(`CELL H=${cell.H} B=${cell.B} ${cell.scenario}: seeded=${rec.seeded} actualAfterSeed=${rec.counts.afterSeed.total} afterFirstEnqueues=${rec.counts.afterFirstEnqueues.total} end=${rec.counts.end.total} | retry p95=${rec.timingMs.retry.p95}ms scanned=${rec.perOp.retry.scanned} bytesW=${rec.perOp.retry.written}+copy ${rec.perOp.retry.copied} | idle p95=${rec.timingMs.idle.p95}ms | lag p99=${rec.lag.eventLoopDelayMs.p99}ms max=${rec.lag.eventLoopDelayMs.max}ms (${Math.round((Date.now() - t0) / 1000)}s)`);
    fs.writeFileSync(outFile, JSON.stringify({ preflight: pre, criteria: CRITERIA, criteriaSha, scriptSha, dist, host: { cpu: os.cpus()[0].model, threads: os.cpus().length, ramGB: Math.round(os.totalmem() / 1e9), node: process.version }, results }, null, 1));
  }
  const verdict = evaluate(results.filter((r) => !r.error));
  console.log('VERDICT ' + JSON.stringify(verdict));
  fs.writeFileSync(outFile, JSON.stringify({ preflight: pre, criteria: CRITERIA, criteriaSha, scriptSha, dist, host: { cpu: os.cpus()[0].model, threads: os.cpus().length, ramGB: Math.round(os.totalmem() / 1e9), node: process.version }, verdict, results }, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (flag('child')) runChild().catch((e) => { console.error(e); process.exit(1); });
else main();
