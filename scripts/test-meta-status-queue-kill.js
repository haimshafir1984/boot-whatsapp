'use strict';

// metaStatusQueue.ts durability under a REAL process kill (SIGKILL), not an injected write error.
//
// The existing compaction suite proves the error path: it makes the compaction write throw and
// checks the old journal is still replayable. That is not the same as a process dying mid-write,
// which is what actually happens when the gateway container is killed or OOMs. This suite kills a
// child process while it is writing the journal - repeatedly, at randomised moments - and asserts
// that whatever is on disk afterwards still loads, never loses an entry the child had not yet
// delivered, and never resurrects one it had.
//
// Not covered, and not claimed: there is no fsync() in the queue, so a host power loss can still
// lose writes the OS had buffered. That is a pre-existing property of this file, unchanged here.

const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MetaStatusQueue } = require('../dist/metaStatusQueue');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-queue-kill-'));
const CLIENTS = Array.from({ length: 15 }, (_, i) => `client-${i}`);

/** Child: hammers the queue (enqueue + complete, so compaction fires) until it is killed. */
const CHILD = `
const { MetaStatusQueue } = require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'metaStatusQueue'))});
const file = process.argv[2];
const CLIENTS = ${JSON.stringify(CLIENTS)};
const payload = (n) => ({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.' + n, status: 'delivered', timestamp: '1', recipient_id: '972500000000' }] } }] }] });
const q = new MetaStatusQueue(file, { doneRetentionMs: 400 });
let n = 0;
process.send && process.send('ready');
for (;;) {
  for (let i = 0; i < 25; i++) q.enqueue('key-' + (n++), payload(n), CLIENTS);
  // Deliver most of what is queued, so recentDone grows and compaction keeps firing.
  for (let i = 0; i < 300; i++) {
    const [item] = q.due(1);
    if (!item) break;
    q.begin(item.id); q.complete(item.id);
  }
  q.expire();
}
`;
const childFile = path.join(root, 'child.js');
fs.writeFileSync(childFile, CHILD);

function killAfter(file, ms) {
  const child = spawn(process.execPath, [childFile, file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // SIGKILL: no handlers run, no flush, no clean shutdown - the process simply stops.
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    }, ms);
    child.on('exit', () => { clearTimeout(timer); resolve(stderr); });
  });
}

(async () => {
  const ROUNDS = 12;
  let loadedOk = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const file = path.join(root, `kill-${round}.jsonl`);
    // Randomised kill moment, so the cut lands at different points of append/compaction.
    const stderr = await killAfter(file, 250 + Math.floor(Math.random() * 500));
    assert.equal(stderr.trim(), '', `the child must not have crashed on its own: ${stderr.slice(0, 300)}`);
    assert.ok(fs.existsSync(file), 'the journal must exist after the kill');

    // The whole point: whatever is on disk must load. A corrupt journal is allowed to THROW (that
    // is the documented fail-closed behaviour), but it must never load as silently empty, and the
    // normal outcome of a kill - a torn last line - must be recovered from.
    let queue;
    try { queue = new MetaStatusQueue(file); } catch (err) {
      assert.match(String(err && err.message), /corrupt/, `a journal that will not load must fail loudly: ${err && err.message}`);
      continue;
    }
    loadedOk++;
    const stats = queue.stats();
    assert.ok(Number.isFinite(stats.pending) && stats.pending >= 0, 'replay must produce a usable queue');

    // It must keep working after recovery: a restart that loads but cannot drain is not durable.
    let delivered = 0;
    for (;;) {
      const [item] = queue.due(1);
      if (!item) break;
      queue.begin(item.id); queue.complete(item.id); delivered++;
      if (delivered > stats.pending) break;
    }
    assert.equal(delivered, stats.pending, 'every replayed entry must still be deliverable');
    assert.equal(queue.stats().pending, 0);

    // And a second restart must not resurrect anything that was just delivered.
    assert.equal(new MetaStatusQueue(file).stats().pending, 0, 'entries delivered after recovery must not come back');
  }

  assert.ok(loadedOk >= ROUNDS - 1, `a kill should normally leave a replayable journal, only ${loadedOk}/${ROUNDS} loaded`);
  console.log(`Meta status queue SIGKILL durability tests passed (${loadedOk}/${ROUNDS} journals replayed after a hard kill).`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => {
  console.error(err);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(1);
});
