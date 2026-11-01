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

scenario('OFF unless FLOW_RESTORE_JITTER_MS is set - in tests and in production alike; an explicit value is honoured', () => {
  const saved = { env: process.env.NODE_ENV, jitter: process.env.FLOW_RESTORE_JITTER_MS };
  try {
    for (const env of ['test', 'production', undefined]) {
      if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
      delete process.env.FLOW_RESTORE_JITTER_MS;
      assert.equal(restoreJitterMs(0, undefined, () => 0.99), 0, `default is off (NODE_ENV=${env})`);
    }
    process.env.FLOW_RESTORE_JITTER_MS = '10000';
    assert.equal(restoreJitterMs(0, undefined, () => 0.5), 5000);
  } finally {
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
    if (saved.jitter === undefined) delete process.env.FLOW_RESTORE_JITTER_MS; else process.env.FLOW_RESTORE_JITTER_MS = saved.jitter;
  }
});

scenario('every restored timer kind (name, pre-name, contact card, decision, wait-reply, expired decision): off = exact remaining time; on = spread only when due soon', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-jitter-'));
  process.env.STORAGE_PATH = path.join(dir, 'storage.json'); process.env.SESSION_PATH = path.join(dir, 'session');
  const { Storage } = require('../dist/storage');
  const { scheduleRestoredConversationTimeout } = require('../dist/messageFlow');
  const storage = new Storage(process.env.STORAGE_PATH);
  const flow = [{ id: 's1', kind: 'question', text: 'q', presentation: 'buttons', timeoutMinutes: 30, options: [{ id: 'o1', text: 'a' }] }];
  const base = { senderJid: 'whatsapp:972501234567', senderPhone: '972501234567', campaignId: 'c1', campaignResultId: 'r1' };
  const states = {
    name: { ...base, kind: 'name', nameTimeoutMinutes: 5 },
    'pre-name-prompt': { ...base, kind: 'pre-name-prompt', preNamePromptTimeoutMinutes: 1 },
    'contact-card-confirmation': { ...base, kind: 'contact-card-confirmation', contactCardConfirmationTimeoutMinutes: 30, followupMessages: [], decisionFlow: [] },
    decision: { ...base, kind: 'decision', flow, stepId: 's1' },
    'wait-reply': { ...base, kind: 'wait-reply', flow, stepId: 's1' },
    'expired-decision': { ...base, kind: 'expired-decision', flow, stepId: 's1' },
  };
  const realSetTimeout = global.setTimeout; const realRandom = Math.random; const saved = process.env.FLOW_RESTORE_JITTER_MS;
  const delayFor = (state, timestamp, jitterEnv, random) => {
    const delays = [];
    global.setTimeout = (fn, ms) => { delays.push(ms); return { unref() {}, ref() {} }; };
    Math.random = () => random;
    if (jitterEnv === undefined) delete process.env.FLOW_RESTORE_JITTER_MS; else process.env.FLOW_RESTORE_JITTER_MS = jitterEnv;
    try { scheduleRestoredConversationTimeout(storage, () => null, state.senderJid, { ...state, timestamp }); }
    finally { global.setTimeout = realSetTimeout; Math.random = realRandom; if (saved === undefined) delete process.env.FLOW_RESTORE_JITTER_MS; else process.env.FLOW_RESTORE_JITTER_MS = saved; }
    return delays[0];
  };
  try {
    for (const [kind, state] of Object.entries(states)) {
      const ttl = delayFor(state, Date.now(), undefined, 0.5);                     // fresh timer, jitter off: the full time to live
      assert.ok(ttl > 0, `${kind}: ttl ${ttl}`);
      const dueSoon = Date.now() - (ttl - 3000);                                   // 3 seconds left
      const overdue = Date.now() - ttl - 600_000;                                  // expired while the process was down
      const far = Date.now() - 1000;                                               // just started: far from due
      for (const [label, ts] of [['due soon', dueSoon], ['overdue', overdue], ['far from due', far]]) {
        const off = delayFor(state, ts, undefined, 0.5);
        const offZero = delayFor(state, ts, '0', 0.5);
        const on = delayFor(state, ts, '10000', 0.5);
        const near = (a, b, why) => assert.ok(Math.abs(a - b) <= 50, `${why}: ${a} vs ${b}`);   // the clock moves a millisecond or two between the calls
        near(off, offZero, `${kind} ${label}: default and 0 are the same`);
        if (label === 'far from due') near(on, off, `${kind} ${label}: left alone`);
        else near(on, off + 5000, `${kind} ${label}: spread by random*window (0.5*10000) on top of the remaining ${off}`);
      }
      assert.equal(delayFor(state, overdue, undefined, 0.5), 0, `${kind}: an overdue timer fires immediately when the feature is off, exactly as before`);
    }
  } finally { global.setTimeout = realSetTimeout; Math.random = realRandom; fs.rmSync(dir, { recursive: true, force: true }); }
});

let failed = 0;
for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nRestore jitter tests passed (${results.length} scenarios).`);
process.exit(failed ? 1 : 0);
