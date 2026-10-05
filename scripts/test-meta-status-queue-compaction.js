'use strict';

// metaStatusQueue.ts: compaction must stay amortised, due() must stay oldest-first, and NEITHER
// may weaken the durability the queue exists for. The queue is written to disk so that a status
// survives a gateway crash: losing one no longer self-corrects once releasing an `uncertain`
// message depends on that specific status. So every performance assertion here is paired with a
// crash/replay assertion.
//
// Background: the trigger used to be measured against pending.size alone while a rewrite also
// writes recentDone, so a compacted journal stayed above its own trigger and every later
// complete() rewrote the whole file (907 rewrites / 2.2GB for one 23k drain), blocking the
// gateway's event loop. due() additionally sorted a copy of the whole map on every call, and the
// drain loop calls it until the queue empties.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MetaStatusQueue } = require('../dist/metaStatusQueue');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-queue-compaction-'));
const CLIENTS = Array.from({ length: 15 }, (_, i) => `client-${i}`);
const payload = (n) => ({ entry: [{ changes: [{ value: { statuses: [{ id: `wamid.${n}`, status: 'delivered', timestamp: '1', recipient_id: '972500000000' }] } }] }] });

function fresh(name) {
  const dir = fs.mkdtempSync(path.join(root, `${name}-`));
  return { dir, file: path.join(dir, 'status.jsonl') };
}

/** Counts full-journal rewrites by watching for the temp file compaction renames into place. */
function countingRewrites(fn) {
  let rewrites = 0;
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, ...rest) {
    if (String(file).endsWith('.tmp')) rewrites++;
    return realWrite.call(this, file, ...rest);
  };
  try { return { result: fn(), rewrites }; } finally { fs.writeFileSync = realWrite; }
}

function drain(queue, batchSize = 20) {
  let delivered = 0;
  for (;;) {
    const batch = queue.due(batchSize);
    if (!batch.length) break;
    for (const item of batch) { queue.begin(item.id); queue.complete(item.id); delivered++; }
  }
  return delivered;
}

try {
  // 1. Compaction is amortised: draining a realistic backlog must not rewrite the journal once per
  //    completion. With the old guard this was ~1 rewrite per 26 completions and never terminated
  //    inside the time budget; the bound here is deliberately loose so it asserts the ORDER of
  //    magnitude (no per-completion rewriting), not an exact count.
  {
    const { file } = fresh('amortised');
    const queue = new MetaStatusQueue(file);
    for (let i = 0; i < 2000; i++) queue.enqueue(`key-${i}`, payload(i), CLIENTS);
    const pending = queue.stats().pending;
    assert.equal(pending, 30000, 'fan-out to every client is what makes this queue big');

    const { result: delivered, rewrites } = countingRewrites(() => drain(queue));
    assert.equal(delivered, 30000, 'every entry must drain');
    assert.equal(queue.stats().pending, 0);
    assert.ok(rewrites <= 10, `draining ${delivered} entries must not rewrite the journal repeatedly, got ${rewrites} rewrites`);
  }

  // 2. The journal is still bounded - amortising must not mean "never compact". A long run with a
  //    short done-retention has to end with a journal proportional to what is actually live.
  {
    const { file } = fresh('bounded');
    let clock = Date.now();
    const queue = new MetaStatusQueue(file, { doneRetentionMs: 1000, now: () => clock });
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 100; i++) queue.enqueue(`r${round}-k${i}`, payload(i), CLIENTS);
      drain(queue);
      clock += 2000;            // every previous done id is now past its retention
      queue.expire();           // expire() prunes recentDone
    }
    const { journalLines, pending } = queue.stats();
    assert.equal(pending, 0);
    assert.ok(journalLines < 60000, `journal must not grow without bound across rounds, got ${journalLines} lines`);
  }

  // 3. due() returns oldest-first. This is the invariant that lets the sort go: the Map's insertion
  //    order must already be createdAt order.
  {
    const { file } = fresh('order');
    let clock = 1_000_000;
    const queue = new MetaStatusQueue(file, { now: () => clock });
    for (let i = 0; i < 50; i++) { queue.enqueue(`key-${i}`, payload(i), ['only-client']); clock += 1000; }
    const batch = queue.due(50);
    assert.equal(batch.length, 50);
    for (let i = 1; i < batch.length; i++) {
      assert.ok(batch[i - 1].createdAt <= batch[i].createdAt, `due() must stay oldest-first (broke at index ${i})`);
    }
    assert.equal(batch[0].id, 'key-0|only-client', 'the oldest entry must come first');
  }

  // 4. ...and it still holds after a restart, which rebuilds the Map from the journal rather than
  //    from enqueue() calls. If replay() ever reordered, the sort-free due() would silently become
  //    unordered - so this asserts the replay path specifically.
  {
    const { file } = fresh('order-replay');
    let clock = 1_000_000;
    const queue = new MetaStatusQueue(file, { now: () => clock });
    for (let i = 0; i < 30; i++) { queue.enqueue(`key-${i}`, payload(i), ['only-client']); clock += 1000; }
    // Complete a few out of order, so the journal is not a clean ascending run.
    for (const i of [7, 3, 19]) { const id = `key-${i}|only-client`; queue.begin(id); queue.complete(id); }

    const reloaded = new MetaStatusQueue(file, { now: () => clock });
    const batch = reloaded.due(100);
    assert.equal(batch.length, 27, 'completed entries must not come back');
    for (let i = 1; i < batch.length; i++) {
      assert.ok(batch[i - 1].createdAt <= batch[i].createdAt, `replayed order must stay oldest-first (broke at index ${i})`);
    }
  }

  // 4b. Order must also survive a SUCCESSFUL compaction: maybeCompact() rebuilds the journal from
  //     pending (as 'add') followed by recentDone (as 'done'), so a restart replays a file this
  //     process wrote rather than the original append stream. If that rewrite ever reordered,
  //     sort-free due() would silently stop being oldest-first - and nothing else would notice.
  {
    const { file } = fresh('order-after-compaction');
    let clock = 1_000_000;
    const queue = new MetaStatusQueue(file, { now: () => clock, doneRetentionMs: 1000 });
    // Enough traffic to push the journal well past the compaction threshold.
    for (let i = 0; i < 700; i++) { queue.enqueue(`done-${i}`, payload(i), CLIENTS); clock += 10; }
    drain(queue);                                            // all of the above become recentDone
    for (let i = 0; i < 40; i++) { queue.enqueue(`keep-${i}`, payload(i), ['only-client']); clock += 10; }
    // Age out the completed ids: now the journal holds thousands of lines for a live set of ~40,
    // which is exactly the state compaction exists to collapse.
    clock += 5000;
    queue.expire();
    const { rewrites } = countingRewrites(() => {
      // One more completion, to give maybeCompact() a chance to fire with entries still pending.
      const [item] = queue.due(1); queue.begin(item.id); queue.complete(item.id);
      return null;
    });
    assert.ok(rewrites >= 1, 'this case is only meaningful once a compaction actually ran');
    assert.ok(queue.stats().pending > 0, 'entries must still be pending at compaction time');

    const reloaded = new MetaStatusQueue(file, { now: () => clock });
    assert.equal(reloaded.stats().pending, queue.stats().pending, 'a compaction must not lose pending entries');
    const batch = reloaded.due(100000);
    for (let i = 1; i < batch.length; i++) {
      assert.ok(batch[i - 1].createdAt <= batch[i].createdAt, `order must survive a compaction + restart (broke at index ${i})`);
    }
    assert.ok(!batch.some((i) => i.id.startsWith('done-')), 'completed entries must not come back from a compacted journal');
  }

  // 4c. due() promises INSERTION order, which is createdAt order only while the clock moves
  //     forward. A backwards clock step (NTP) makes a later entry carry an earlier createdAt, and
  //     the sort-free scan will not reorder it. Asserted so the guarantee is explicit rather than
  //     assumed: delivery order is fairness, not correctness - expire() reads createdAt directly -
  //     but a future reader must not believe something stronger than this.
  {
    const { file } = fresh('clock-skew');
    let clock = 1_000_000;
    const queue = new MetaStatusQueue(file, { now: () => clock });
    queue.enqueue('first', payload(1), ['only-client']);
    clock -= 5_000;                                          // the clock jumps BACKWARDS
    queue.enqueue('second', payload(2), ['only-client']);
    const batch = queue.due(10);
    assert.deepEqual(batch.map((i) => i.id), ['first|only-client', 'second|only-client'], 'entries are served in insertion order');
    assert.ok(batch[0].createdAt > batch[1].createdAt, 'documented consequence: after a backwards clock step, insertion order is NOT createdAt order');
  }

  // 5. Durability, the reason this queue is on disk at all: a crash mid-run must not lose an
  //    undelivered status, and must not resurrect a delivered one.
  {
    const { file } = fresh('crash');
    const queue = new MetaStatusQueue(file);
    for (let i = 0; i < 400; i++) queue.enqueue(`key-${i}`, payload(i), CLIENTS);
    // Deliver part of it, then "crash" (drop the object without closing anything).
    let done = 0;
    for (const item of queue.due(1000)) { queue.begin(item.id); queue.complete(item.id); done++; }
    const stillPending = queue.stats().pending;

    const recovered = new MetaStatusQueue(file);
    assert.equal(recovered.stats().pending, stillPending, 'a crash must not lose undelivered statuses');
    const ids = new Set(recovered.due(100000).map((i) => i.id));
    assert.equal(ids.size, stillPending);
    for (let i = 0; i < done; i++) {
      // the first `done` entries were acknowledged; none may be redelivered
      const delivered = queue.counters.delivered;
      assert.ok(delivered >= done, 'delivered counter must reflect the acknowledged entries');
      break;
    }
    assert.ok(!ids.has('key-0|client-0'), 'an acknowledged status must not be redelivered after a restart');
  }

  // 6. A crash DURING a compaction must leave the previous journal intact: compaction writes a temp
  //    file and renames it, so a failure before the rename may not take the real journal with it.
  {
    const { file } = fresh('crash-compaction');
    const queue = new MetaStatusQueue(file);
    for (let i = 0; i < 2000; i++) queue.enqueue(`key-${i}`, payload(i), CLIENTS);
    const expected = queue.stats().pending;

    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function (f, ...rest) {
      if (String(f).endsWith('.tmp')) throw new Error('synthetic disk failure during compaction');
      return realWrite.call(this, f, ...rest);
    };
    let drained = 0;
    try { drained = drain(queue); } finally { fs.writeFileSync = realWrite; }
    assert.ok(drained > 0, 'a failing compaction must not stop delivery');

    const recovered = new MetaStatusQueue(file);
    assert.equal(recovered.stats().pending, queue.stats().pending, 'a failed compaction must leave a replayable journal');
    assert.ok(expected > 0);
  }

  // 7. A torn tail (crash mid-append) is still discarded, and a journal corrupt anywhere else is
  //    still refused rather than silently loaded as empty. Unchanged behaviour - asserted because
  //    this is the guarantee a performance change is most likely to break by accident.
  {
    const { file } = fresh('torn');
    const queue = new MetaStatusQueue(file);
    queue.enqueue('key-a', payload(1), ['c1']);
    queue.enqueue('key-b', payload(2), ['c1']);
    fs.appendFileSync(file, '{"t":"add","id":"key-c|c1","clientId":"c1","pay');   // no trailing newline
    const recovered = new MetaStatusQueue(file);
    assert.equal(recovered.stats().pending, 2, 'a torn last line must be discarded, not loaded');

    const { file: badFile } = fresh('corrupt');
    fs.writeFileSync(badFile, '{"t":"add","id":"x|c1","clientId":"c1","at":1}\nnot json at all\n');
    assert.throws(() => new MetaStatusQueue(badFile), /corrupt/, 'a corrupt journal must never load as empty');
  }

  console.log('Meta status queue compaction/order/durability tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
