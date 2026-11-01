'use strict';
/**
 * Restored timers that are due now (or within the window) are spread over a random window instead of all firing in the same instant;
 * timers far from due are untouched; 0 turns it off; the default is 30 seconds outside tests.
 */
const assert = require('node:assert/strict');
const { restoreJitterMs } = require('../dist/messageFlow');

const results = [];
function scenario(name, fn) {
  try { fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}

scenario('a timer that is due now or soon is delayed by 0..window, spread over the whole window', () => {
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const values = Array.from({ length: 2000 }, () => restoreJitterMs(0, 30_000, rnd));
  assert.ok(values.every((v) => Number.isInteger(v) && v >= 0 && v < 30_000));
  assert.ok(Math.min(...values) < 1500 && Math.max(...values) > 28_500, 'covers the window');
  const buckets = new Set(values.map((v) => Math.floor(v / 1000)));
  assert.ok(buckets.size >= 28, `spread over ${buckets.size} one-second buckets, not clumped`);
  assert.equal(restoreJitterMs(29_999, 30_000, () => 0.5), 15_000, 'due within the window: jittered');
  assert.equal(restoreJitterMs(30_000, 30_000, () => 0.5), 15_000, 'exactly at the window edge: jittered');
});

scenario('a timer far from due is left alone, and 0 / invalid windows turn it off', () => {
  assert.equal(restoreJitterMs(30_001, 30_000, () => 0.9), 0);
  assert.equal(restoreJitterMs(20 * 60_000, 30_000, () => 0.9), 0);
  assert.equal(restoreJitterMs(0, 0, () => 0.9), 0);
  assert.equal(restoreJitterMs(0, -5, () => 0.9), 0);
  assert.equal(restoreJitterMs(0, Number.NaN, () => 0.9), 0);
});

scenario('under NODE_ENV=test the default is off (existing timer tests stay immediate); an explicit setting is honoured', () => {
  const saved = { env: process.env.NODE_ENV, jitter: process.env.FLOW_RESTORE_JITTER_MS };
  try {
    process.env.NODE_ENV = 'test'; delete process.env.FLOW_RESTORE_JITTER_MS;
    assert.equal(restoreJitterMs(0, undefined, () => 0.99), 0);
    process.env.FLOW_RESTORE_JITTER_MS = '10000';
    assert.equal(restoreJitterMs(0, undefined, () => 0.5), 5000);
    process.env.NODE_ENV = 'production'; delete process.env.FLOW_RESTORE_JITTER_MS;
    assert.equal(restoreJitterMs(0, undefined, () => 0.5), 15_000, 'production default: 30 seconds');
  } finally {
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
    if (saved.jitter === undefined) delete process.env.FLOW_RESTORE_JITTER_MS; else process.env.FLOW_RESTORE_JITTER_MS = saved.jitter;
  }
});

let failed = 0;
for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nRestore jitter tests passed (${results.length} scenarios).`);
process.exit(failed ? 1 : 0);
