#!/usr/bin/env node
/**
 * Sequential load runner: 1 warm-up, then measured runs until N CLEAN runs are
 * collected (max M attempts). Every run is a fresh node process, never parallel.
 * A run is CONTAMINATED when the gateway logged [META_GATEWAY_CLIENT_SKIPPED]
 * (routes cache unavailable -> a client was treated as unavailable). Contaminated
 * runs are kept and reported, but excluded from the clean set. That rule is fixed
 * before measuring.
 *   node scripts/run-load-baseline.js <out.json> [clean=5] [scenario=mixed] [maxAttempts=12]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const out = process.argv[2];
const wantClean = Number(process.argv[3] || 5);
const scenarios = (process.argv[4] || 'single,mixed').split(',');
const maxAttempts = Number(process.argv[5] || 12);
if (!out) { console.error('usage: run-load-baseline.js <out.json> [clean] [scenarios] [maxAttempts]'); process.exit(2); }
const script = path.join(__dirname, 'test-load-shared-campaign-isolation.js');
const report = { startedAt: new Date().toISOString(), head: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), wantClean, results: {} };
const count = (text, re) => (text.match(re) || []).length;
for (const scenario of scenarios) {
  report.results[scenario] = [];
  let clean = 0;
  for (let i = 0; i <= maxAttempts && clean < wantClean; i++) {
    const label = i === 0 ? 'warmup' : `run${i}`;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [script], { env: { ...process.env, LOAD_SCENARIO: scenario }, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 << 20 });
    const text = (r.stdout || '') + (r.stderr || '');
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON:'));
    const skipped = count(text, /\[META_GATEWAY_CLIENT_SKIPPED\]/g);
    const skippedClients = [...new Set([...text.matchAll(/\[META_GATEWAY_CLIENT_SKIPPED\]\s+(\S+)/g)].map((m) => m[1]))];
    const entry = { label, exit: r.status, wallMs: Date.now() - t0, skippedEvents: skipped, skippedClients, contaminated: skipped > 0, groups: line ? JSON.parse(line.slice(12)).groups : null };
    if (r.status !== 0) entry.exitReason = (text.match(/AssertionError[^\n]*/) || [(text.split('\n').filter((l) => /Error/.test(l))[0] || 'unknown')])[0].slice(0, 200);
    report.results[scenario].push(entry);
    if (i > 0 && entry.groups && !entry.contaminated) clean++;
    console.log(scenario, label, 'exit', r.status, 'skipped', skipped, entry.contaminated ? 'CONTAMINATED' : '', JSON.stringify(entry.groups));
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
  }
}
report.finishedAt = new Date().toISOString();
fs.writeFileSync(out, JSON.stringify(report, null, 2));
