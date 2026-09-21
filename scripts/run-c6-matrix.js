#!/usr/bin/env node
/**
 * Stage E / C6 - runs the system-load matrix SEQUENTIALLY, one clean process per scenario (base SHA vs working tree).
 *   node scripts/run-c6-matrix.js --base-dist <dir>/dist [--only label1,label2] [--skip-sustained]
 * Every result lands in docs/results-data/c6-<label>-<date>.json (written by measure-inbox-system.js). This file prints one
 * condensed line per run. Nothing here changes any threshold: the comparison rules are in docs/stage-e-c6-comparison-plan-*.md.
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const baseDist = path.resolve(arg('base-dist', ''));
const newDist = path.resolve(__dirname, '..', 'dist');
const only = arg('only') ? new Set(arg('only').split(',')) : null;
const skipSustained = args.includes('--skip-sustained');

const S = (side, label, opts) => ({ side, label: `${side}-${label}`, opts });
const MAIN = [
  // axis A - history that is never pruned (failed/held) is the same on both sides; burst of 100 (the launch peak)
  S('base', 'burst100-h300', { participants: 100, history: 300 }), S('new', 'burst100-h300', { participants: 100, history: 300 }),
  S('base', 'burst100-h50000', { participants: 100, history: 50000, timeout: 900 }), S('new', 'burst100-h50000', { participants: 100, history: 50000 }),
  // axis B - durable dedupe history exists on the new side only (the base prunes completed to 300): reported as such, no improvement claim
  S('new', 'burst100-h10000-c0', { participants: 100, history: 10000 }), S('new', 'burst100-h10000-c40000', { participants: 100, history: 10000, completed: 40000 }),
  // stress 150 with accumulated conversation state on every client
  S('base', 'stress150-h5000-conv2000', { participants: 150, history: 5000, 'seed-conversations': 2000, timeout: 900 }), S('new', 'stress150-h5000-conv2000', { participants: 150, history: 5000, 'seed-conversations': 2000 }),
  // faults on 150 in flight (client0 receives ~70%: more than the 50-sender concurrency cap)
  S('base', 'fault-kill-client', { participants: 150, history: 300, 'seed-conversations': 2000, fault: 'kill-client@4', timeout: 300 }), S('new', 'fault-kill-client', { participants: 150, history: 300, 'seed-conversations': 2000, fault: 'kill-client@4', timeout: 300 }),
  S('new', 'fault-term-client', { participants: 150, history: 300, 'seed-conversations': 2000, fault: 'term-client@4', timeout: 300 }),
  S('base', 'fault-kill-gateway', { participants: 150, history: 300, fault: 'kill-gateway@3', timeout: 300 }), S('new', 'fault-kill-gateway', { participants: 150, history: 300, fault: 'kill-gateway@3', timeout: 300 }),
  S('new', 'fault-db-outage-60', { participants: 150, history: 300, fault: 'db-outage@2:60', timeout: 400 }),
  S('new', 'fault-client-down-60', { participants: 150, history: 300, 'seed-conversations': 2000, fault: 'client-down@3:60', timeout: 400 }), S('new', 'fault-client-down-180', { participants: 150, history: 300, 'seed-conversations': 2000, fault: 'client-down@3:180', timeout: 500 }),
  // sustained: 1000 participants over 20 minutes (compressed), 35% abandonment, accumulated state
  ...(skipSustained ? [] : [S('base', 'sustained1000-h5000-conv2000', { scenario: 'sustained', participants: 1000, duration: 1200, history: 5000, 'seed-conversations': 2000, timeout: 1800 }), S('new', 'sustained1000-h5000-conv2000', { scenario: 'sustained', participants: 1000, duration: 1200, history: 5000, 'seed-conversations': 2000, timeout: 1800 })]),
];

// Faults re-run with the injection INSIDE the burst (0.7s: a burst of 150 is over in ~2s, so the first matrix injected after the work was
// done), webhook redelivery like Meta's, waiting for the fault to finish, and 3 repetitions of the restarts (D1: how many interrupted
// items does a restart produce?).
const F = (side, label, fault, extra = {}) => S(side, label, { participants: 150, history: 300, 'seed-conversations': 2000, fault, timeout: 600, ...extra });
const FAULTS = [
  ...[1, 2, 3].flatMap((r) => [F('base', `f2-kill-client-r${r}`, 'kill-client@0.7'), F('new', `f2-kill-client-r${r}`, 'kill-client@0.7'), F('new', `f2-term-client-r${r}`, 'term-client@0.7')]),
  F('base', 'f2-kill-gateway', 'kill-gateway@0.7'), F('new', 'f2-kill-gateway', 'kill-gateway@0.7'),
  F('new', 'f2-db-outage-60', 'db-outage@0.7:60', { observe: 200 }), F('new', 'f2-db-outage-180', 'db-outage@0.7:180', { timeout: 900, observe: 200 }),
  F('base', 'f2-client-down-60', 'client-down@0.7:60'), F('new', 'f2-client-down-60', 'client-down@0.7:60'), F('new', 'f2-client-down-180', 'client-down@0.7:180', { timeout: 900 }),
];
const runs = arg('set', 'main') === 'faults' ? FAULTS : MAIN;

for (const run of runs) {
  if (only && !only.has(run.label)) continue;
  const cli = ['scripts/measure-inbox-system.js', '--side', run.side, '--dist', run.side === 'base' ? baseDist : newDist, '--label', run.label];
  for (const [k, v] of Object.entries(run.opts)) cli.push('--' + k, String(v));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, cli, { cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 3 * 3600 * 1000, maxBuffer: 256 << 20 });
  const line = (r.stdout || '').split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) { console.log(`RUN ${run.label}: NO RESULT exit=${r.status} ${(r.stderr || '').slice(-300)}`); continue; }
  const s = JSON.parse(line);
  console.log(`RUN ${run.label} (${Math.round((Date.now() - t0) / 1000)}s): firstResp p50/p99/max=${s.firstResponseMs.p50}/${s.firstResponseMs.p99}/${s.firstResponseMs.max} missing=${s.firstResponseMs.missing} | recv->handler p99/max=${s.receiptToHandlerMs.p99}/${s.receiptToHandlerMs.max} neverStarted=${s.receiptToHandlerMs.neverStarted} ackedNeverStarted=${s.receiptToHandlerMs.acknowledgedButNeverStarted} redelivered=${s.receiptToHandlerMs.redeliveredWebhooks} | gwLoop worstP99/max=${s.gatewayEventLoopMs.worstP99}/${s.gatewayEventLoopMs.max} | lost=${s.lostResults} dup=${s.duplicateResults} | stale=${s.logs.stale} skipped=${s.logs.skipped} failed=${s.logs.inboxFailed} retry=${s.logs.retry} ambiguous=${s.logs.ambiguous} clientsReview=${s.inboxActualCounts.clientsReview} | gw counts=${JSON.stringify(s.inboxActualCounts.gateway)}`);
}
