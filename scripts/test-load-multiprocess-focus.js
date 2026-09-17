'use strict';

/**
 * Orchestrator for the multi-process peak-load test. Spawns several
 * separate `node` OS processes (test-load-worker-focus.js), each handling
 * its own slice of the 100-participant peak with its own concurrency share,
 * so no single JS thread has to interleave all 100 flows' synchronous work
 * at once - unlike test-load-single-peak-100-focus.js, which measured that
 * single-process CPU contention, not anything real about the campaign or
 * Meta. Not part of the regression suite; run on request.
 *
 * TOTAL_PARTICIPANTS and TOTAL_CAP are split evenly across WORKER_COUNT
 * processes. Each worker prints one RESULT_JSON: line; this script waits for
 * all of them, parses those lines, and reports combined percentiles/checks -
 * same metrics shape as the single-process tests, for direct comparison.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const TOTAL_PARTICIPANTS = 100;
const TOTAL_CAP = 100; // matches META_MAX_CONCURRENT_SENDERS in adminServer.ts
const WORKER_COUNT = 5;

function percentile(sortedArray, p) {
  if (!sortedArray.length) return 0;
  const index = Math.min(sortedArray.length - 1, Math.floor((p / 100) * sortedArray.length));
  return sortedArray[index];
}

function runWorker(workerId, count, cap) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, 'test-load-worker-focus.js'),
      `--count=${count}`, `--cap=${cap}`, `--workerId=${workerId}`,
    ], { stdio: ['ignore', 'pipe', 'inherit'] });

    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT_JSON:'));
      if (!line) {
        reject(new Error(`worker ${workerId} exited ${code} without a RESULT_JSON line`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice('RESULT_JSON:'.length)));
      } catch (err) {
        reject(new Error(`worker ${workerId} produced unparseable RESULT_JSON: ${err.message}`));
      }
    });
  });
}

(async () => {
  const base = Math.floor(TOTAL_PARTICIPANTS / WORKER_COUNT);
  const remainder = TOTAL_PARTICIPANTS % WORKER_COUNT;
  const capBase = Math.floor(TOTAL_CAP / WORKER_COUNT);
  const capRemainder = TOTAL_CAP % WORKER_COUNT;

  const plan = Array.from({ length: WORKER_COUNT }, (_, i) => ({
    workerId: i + 1,
    count: base + (i < remainder ? 1 : 0),
    cap: capBase + (i < capRemainder ? 1 : 0),
  }));

  console.log(`Multi-process peak test: ${TOTAL_PARTICIPANTS} participants across ${WORKER_COUNT} separate OS processes, combined cap=${TOTAL_CAP}.`);
  for (const p of plan) console.log(`  worker ${p.workerId}: ${p.count} participants, cap=${p.cap}`);
  console.log('');

  const wallStart = Date.now();
  const summaries = await Promise.all(plan.map((p) => runWorker(p.workerId, p.count, p.cap)));
  const wallElapsedMs = Date.now() - wallStart;

  const allLatencies = summaries.flatMap((s) => s.latencies).sort((a, b) => a - b);
  const allDbWrites = summaries.flatMap((s) => s.dbWriteDurationsMs).sort((a, b) => a - b);
  const totalSucceeded = summaries.reduce((sum, s) => sum + s.succeeded, 0);
  const totalFailed = summaries.reduce((sum, s) => sum + s.failed, 0);
  const totalSendCount = summaries.reduce((sum, s) => sum + s.sendCount, 0);
  const totalFileSendCount = summaries.reduce((sum, s) => sum + s.fileSendCount, 0);
  const totalTransportFailures = summaries.reduce((sum, s) => sum + s.transportFailures, 0);
  const totalDbWriteCount = summaries.reduce((sum, s) => sum + s.dbWriteCount, 0);
  const totalDbQueryCount = summaries.reduce((sum, s) => sum + s.dbQueryCount, 0);
  const allIntegrityOk = summaries.every((s) => s.integrityOk);
  const maxPeakActive = Math.max(...summaries.map((s) => s.peakActive));

  console.log(`Orchestrator wall time (all ${WORKER_COUNT} worker processes, run in parallel): ${(wallElapsedMs / 1000).toFixed(1)}s`);
  console.log(`Per-worker peak concurrent (within its own share): ${summaries.map((s) => s.peakActive).join(', ')} (each worker's own cap was its share of ${TOTAL_CAP})`);
  console.log(`Succeeded: ${totalSucceeded}/${TOTAL_PARTICIPANTS}, Failed (unrecovered after retries): ${totalFailed}/${TOTAL_PARTICIPANTS}`);
  console.log(`Per-participant latency (trigger to welcome-image+contact-card+first-question sent), combined across all workers: p50=${percentile(allLatencies, 50)}ms p95=${percentile(allLatencies, 95)}ms max=${allLatencies[allLatencies.length - 1] ?? 0}ms`);
  console.log(`Transport: ${totalSendCount} text/button/card sends, ${totalFileSendCount} file sends, ${totalTransportFailures} simulated transient failures`);
  console.log(`Postgres backend (combined): ${totalDbWriteCount} coalesced write cycles, ${totalDbQueryCount} SQL queries, write durations: p50=${percentile(allDbWrites, 50)}ms max=${Math.max(0, ...allDbWrites)}ms`);
  console.log(`Data integrity: ${allIntegrityOk ? 'PASSED for every worker (no drops, no duplicates)' : 'FAILED in at least one worker'}`);

  if (!allIntegrityOk || totalFailed > 0) process.exitCode = 1;

  console.log('\nDone.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
