'use strict';
/**
 * Experiment: does the cost of a write batch (and the first response) grow with the number of FINISHED rows already in a client's outbox?
 * (docs/accumulating-slowdown-big-launch-2026-11-08-for-codex.md, section 8; method: docs/outbox-growth-experiment-2026-11-08.md)
 *
 * Same flow, same seed, same rate; only the number of finished outbox rows put into every client before it starts changes (--sizes).
 * The runs are SEQUENTIAL (one scenario per run, nothing else on the machine). Local only: the real gateway and client processes,
 * a local PostgreSQL (TEST_DATABASE_URL), a fake Meta. Nothing here touches production.
 *
 * Measurement without changing product code: the driver copies dist/ to ./.tmp-dist-exp and patches ONLY the copy
 * (src/database.ts is untouched). Per write batch, in the client process, it records:
 *   snapshotMs  cloneSnapshotForTables (synchronous, on the event loop)
 *   commitMs    writeSnapshotDelta as a whole (what POSTGRES_BATCH_SLOW calls commit_ms)
 *   scanMs      the synchronous full-table passes INSIDE writeSnapshotDelta, before any row is written (syncRowsDeltaTracked)
 *   sqlMs       commitMs - scanMs (the SQL, the COMMIT and everything else in writeSnapshotDelta)
 * Event-loop lag, flush waits and first response come from the harness's own measurements.
 *
 * Usage: node scripts/experiment-outbox-growth.js [--sizes 1000,20000] [--scale 0.25] [--clients 5] [--tag exp1]
 * Needs TEST_DATABASE_URL (the local test PostgreSQL, never production) and `npm run build` first.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const sizes = String(arg('sizes', '1000,20000')).split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0);
const scale = arg('scale', '0.25');
const clients = arg('clients', '5');
const tag = arg('tag', 'exp');
const expDist = path.join(repo, '.tmp-dist-exp');

if (!process.env.TEST_DATABASE_URL) { console.error('TEST_DATABASE_URL is not set (the local test PostgreSQL).'); process.exit(2); }
if (!fs.existsSync(path.join(repo, 'dist', 'index.js'))) { console.error('run `npm run build` first'); process.exit(2); }

// ---- instrumented copy of dist (the copy only) ---------------------------------------------------------------------------------------
function buildInstrumentedDist() {
  fs.rmSync(expDist, { recursive: true, force: true });
  fs.cpSync(path.join(repo, 'dist'), expDist, { recursive: true });
  const file = path.join(expDist, 'database.js');
  let code = fs.readFileSync(file, 'utf8');
  const once = (from, to) => {
    const at = code.indexOf(from);
    if (at < 0 || code.indexOf(from, at + 1) >= 0) throw new Error('instrumentation anchor not found exactly once: ' + from.slice(0, 70));
    code = code.replace(from, () => to);
  };
  once('"use strict";', '"use strict";\nconst __expFs = require(\'node:fs\'); globalThis.__exp = { scan: 0 };');
  once("    if (touchedIds === 'all')\n        return fullSync();\n",
       "    if (touchedIds === 'all')\n        return fullSync();\n    const __t0 = process.hrtime.bigint();\n");
  once("    const nextByKey = new Map(nextRows.map((row) => [keyOf(row), row]));\n    const keyColumn",
       "    const nextByKey = new Map(nextRows.map((row) => [keyOf(row), row]));\n    globalThis.__exp.scan += Number(process.hrtime.bigint() - __t0) / 1e6;\n    const keyColumn");
  once("                    const snapshotStartedAt = Date.now();\n", "                    globalThis.__exp.scan = 0;\n                    const snapshotStartedAt = Date.now();\n");
  once("                    if (snapshotMs + commitMs >= 250)\n",
       "                    try { __expFs.appendFileSync(process.env.EXP_TRACE_FILE, JSON.stringify({ t: Date.now(), who: process.env.CLIENT_NAME || String(process.pid), snapshotMs, commitMs, scanMs: Math.round(globalThis.__exp.scan * 10) / 10, tables: dirtyTables === 'all' ? 'all' : [...dirtyTables], outbox: (snapshot.outboxMessages || []).length }) + '\\n'); } catch (e) { /* trace only */ }\n                    if (snapshotMs + commitMs >= 250)\n");
  fs.writeFileSync(file, code);
}

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p / 100 * a.length))] : null);
const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null);

function summarize(size, label, traceFile) {
  const lines = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  // batches that wrote the outbox of a CAMPAIGN client (the idle ones barely write); size = rows in the snapshot at that moment
  const ob = lines.filter((b) => b.tables === 'all' ? false : b.tables.includes('outboxMessages'));
  const col = (k) => ob.map((b) => b[k]);
  const sql = ob.map((b) => Math.max(0, b.commitMs - b.scanMs));
  const resultFile = fs.readdirSync(path.join(repo, 'docs', 'results-data')).filter((f) => f.startsWith(`peak-${label}-`) && f.endsWith('.json')).sort().pop();
  const result = resultFile ? JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'results-data', resultFile), 'utf8')) : null;
  const ev = result?.eventLoop?.clients ?? {};
  const evBig = Object.entries(ev).filter(([k]) => /^client[0-3]$/.test(k)).map(([, v]) => v);
  const fr = result?.firstResponseBreakdown ?? {};
  const frA = fr['A(client0)'] ?? Object.values(fr)[0];
  return {
    size, label, resultFile,
    batches: ob.length, outboxRowsAtBatch: { min: Math.min(...col('outbox')), max: Math.max(...col('outbox')) },
    snapshotMs: { mean: mean(col('snapshotMs')), p50: pct(col('snapshotMs'), 50), p90: pct(col('snapshotMs'), 90), max: pct(col('snapshotMs'), 100) },
    scanMs: { mean: mean(col('scanMs')), p50: pct(col('scanMs'), 50), p90: pct(col('scanMs'), 90), max: pct(col('scanMs'), 100) },
    sqlMs: { mean: mean(sql), p50: pct(sql, 50), p90: pct(sql, 90), max: pct(sql, 100) },
    commitMs: { mean: mean(col('commitMs')), p50: pct(col('commitMs'), 50), p90: pct(col('commitMs'), 90), max: pct(col('commitMs'), 100) },
    syncBlockPerBatchMs: mean(ob.map((b) => b.snapshotMs + b.scanMs)),
    eventLoopCampaignClients: evBig.map((e) => ({ p99Median: e.p99Median, worstP99: e.worstP99, max: e.max, cpuPctMedian: e.cpuPctMedian, cpuPctMax: e.cpuPctMax })),
    firstResponseClientA: frA ? { total: frA.total, work: frA.pickupToFirstMessage_work, gatewayAckToForwarded: frA.gatewayAckToForwarded, wait: frA.forwardedToClientPickup_waitForSlot } : null,
    latency: result?.latency?.overall ?? null,
    verdictFails: (result?.verdict ?? []).filter((v) => !v.ok).map((v) => v.name),
  };
}

(function main() {
  console.log(`experiment ${tag}: sizes=${sizes.join(',')} scale=${scale} clients=${clients}`);
  buildInstrumentedDist();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-exp-'));
  const summaries = [];
  for (const size of sizes) {
    const label = `${tag}-outbox${size}`;
    const traceFile = path.join(outDir, `trace-${size}.jsonl`);
    const started = Date.now();
    console.log(`\n=== run: ${size} finished outbox rows per client (label ${label}) ===`);
    const run = spawnSync(process.execPath, [path.join(repo, 'scripts', 'measure-peak-3campaigns.js'), '--dist', expDist, '--label', label,
      '--profile', 'focus-real', '--signed-buttons', '--clients', clients, '--scale', scale, '--client-outbox-history', String(size)],
    { cwd: repo, env: { ...process.env, EXP_TRACE_FILE: traceFile }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    fs.writeFileSync(path.join(outDir, `run-${size}.log`), String(run.stdout) + '\n' + String(run.stderr));
    console.log(`finished in ${Math.round((Date.now() - started) / 1000)}s (exit ${run.status}; exit 1 only means a verdict failed, not a crash)`);
    summaries.push(summarize(size, label, traceFile));
  }
  fs.rmSync(expDist, { recursive: true, force: true });
  const out = path.join(repo, 'docs', 'results-data', `outbox-growth-experiment-${tag}.json`);
  fs.writeFileSync(out, JSON.stringify({ tag, scale, clients, at: new Date().toISOString(), summaries }, null, 2));
  console.log('\n=== summary ===');
  console.log(JSON.stringify(summaries.map((s) => ({ size: s.size, batches: s.batches, rowsAtBatch: s.outboxRowsAtBatch, snapshotMs: s.snapshotMs, scanMs: s.scanMs, sqlMs: s.sqlMs, syncBlockPerBatchMs: s.syncBlockPerBatchMs, firstResponseClientA: s.firstResponseClientA })), null, 1));
  console.log('\nwritten:', out, '\nlogs:', outDir);
})();
