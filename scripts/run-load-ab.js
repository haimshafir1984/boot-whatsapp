#!/usr/bin/env node
/**
 * Interleaved A/B load runner: alternates a reference tree (A, e.g. a copy of HEAD's dist) and the
 * working tree (B) so machine drift hits both equally. Every run is a fresh node process, strictly
 * sequential. A run is CONTAMINATED when the gateway logged [META_GATEWAY_CLIENT_SKIPPED]; such
 * runs are kept and reported but excluded from the clean set (rule fixed before measuring).
 *   node scripts/run-load-ab.js <out.json> <refTreeDir> [scenario=mixed] [clean=5] [maxAttempts=12]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const [out, refDir, scenario = 'mixed', cleanArg = '5', maxArg = '12'] = process.argv.slice(2);
if (!out || !refDir) { console.error('usage: run-load-ab.js <out.json> <refTreeDir> [scenario] [clean] [maxAttempts]'); process.exit(2); }
const wantClean = Number(cleanArg); const maxAttempts = Number(maxArg);
const trees = { A: path.resolve(refDir), B: path.resolve(__dirname, '..') };
const runs = { A: [], B: [] }; const clean = { A: 0, B: 0 };
const report = { startedAt: new Date().toISOString(), scenario, wantClean, trees: { A: trees.A, B: trees.B }, runs };

function one(label, tree, tag) {
  const script = path.join(tree, 'scripts', 'test-load-shared-campaign-isolation.js');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script], { cwd: tree, env: { ...process.env, LOAD_SCENARIO: scenario }, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 << 20 });
  const text = (r.stdout || '') + (r.stderr || '');
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON:'));
  const skipped = (text.match(/\[META_GATEWAY_CLIENT_SKIPPED\]/g) || []).length;
  const entry = { label, tag, exit: r.status, wallMs: Date.now() - t0, skippedEvents: skipped, contaminated: skipped > 0, groups: line ? JSON.parse(line.slice(12)).groups : null };
  if (r.status !== 0) entry.exitReason = (text.match(/AssertionError[^\n]*/) || [(text.split('\n').filter((l) => /Error/.test(l))[0] || 'unknown')])[0].slice(0, 160);
  return entry;
}
function show(side, e) {
  console.log(side, e.label, 'exit', e.exit, 'skipped', e.skippedEvents, e.contaminated ? 'CONTAMINATED' : '', e.groups ? Object.entries(e.groups).map(([k, g]) => `${k} ${g.median}/${g.p95}/${g.p99}/${g.max}`).join('  ') : 'NO RESULT');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
}
// warm-up for each side (discarded), then alternate A,B,A,B... until both have enough clean runs
for (const side of ['A', 'B']) { const e = one('warmup', trees[side], side); runs[side].push(e); show(side, e); }
for (let i = 1; i <= maxAttempts && (clean.A < wantClean || clean.B < wantClean); i++) {
  for (const side of ['A', 'B']) {
    if (clean[side] >= wantClean) continue;
    const e = one(`run${i}`, trees[side], side);
    runs[side].push(e);
    if (e.groups && !e.contaminated) clean[side]++;
    show(side, e);
  }
}
report.finishedAt = new Date().toISOString();
fs.writeFileSync(out, JSON.stringify(report, null, 2));
