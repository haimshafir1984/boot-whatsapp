'use strict';
// Fuzz test for the OUTBOX_SNAPSHOT_FAST path (src/database.ts): the fast clone + positional sync must produce exactly the
// same snapshot and the same database rows as the original full pass, including after failed batches, reorders and replacements.
process.env.OUTBOX_SNAPSHOT_FAST = '1';
process.env.OUTBOX_SNAPSHOT_SHADOW_EVERY = '1'; // compare against the full copy on every batch
const assert = require('node:assert/strict');
const db = require('../dist/database');
const { emptyStorageData } = require('../dist/storage');

function makeRng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Mock pg pool that models the outbox_messages table (id -> item JSON) with real transaction semantics.
function makePool(state) {
  return {
    async connect() {
      let staged = null;
      return {
        async query(sql, params) {
          const text = String(sql).trim();
          if (text === 'begin') { staged = new Map(state.table); return { rows: [] }; }
          if (text === 'commit') {
            if (state.failNextCommit) { state.failNextCommit = false; throw new Error('simulated commit failure'); }
            state.table = staged; staged = null; return { rows: [] };
          }
          if (text === 'rollback') { staged = null; return { rows: [] }; }
          if (/^insert into outbox_messages/.test(text)) {
            const item = params[params.length - 1];
            staged.set(params[0], typeof item === 'string' ? JSON.parse(item) : JSON.parse(JSON.stringify(item)));
            return { rows: [] };
          }
          if (/^delete from outbox_messages/.test(text)) { for (const id of (Array.isArray(params[0]) ? params[0] : [params[0]])) staged.delete(id); return { rows: [] }; }
          return { rows: [] }; // other tables untouched in these scenarios
        },
        release() {},
      };
    },
  };
}

let counter = 0;
const newRow = () => ({ id: `ob-${++counter}`, kind: 'text', to: '972500000000', status: 'queued', attempts: 0, createdAt: new Date(1700000000000 + counter).toISOString(), updatedAt: new Date(1700000000000 + counter).toISOString(), nested: { n: counter, log: [] } });

class Harness {
  constructor() {
    this.live = [];
    this.data = emptyStorageData();
    this.data.outboxMessages = this.live;
    this.state = { table: new Map(), failNextCommit: false };
    this.pool = makePool(this.state);
    this.previous = null;
    this.pending = new Set();
  }
  async init(n) {
    for (let i = 0; i < n; i += 1) this.live.push(newRow());
    await this.flush('all');
  }
  async flush(dirty) {
    const tracked = dirty === 'all' ? 'all' : new Set(this.pending);
    const tables = dirty === 'all' ? 'all' : new Set(['outboxMessages']);
    const planned = db.cloneSnapshotForTablesPlanned(this.previous, this.data, tables, tracked === 'all' ? {} : { outboxMessages: tracked });
    try {
      await db.writeSnapshotDelta(this.pool, this.previous, planned.snapshot, tables, tracked === 'all' ? {} : { outboxMessages: tracked }, planned.outboxPositions);
    } catch (err) {
      return { ok: false, err };
    }
    this.previous = planned.snapshot;
    this.pending.clear();
    return { ok: true, planned };
  }
  verify(label) {
    const expected = JSON.parse(JSON.stringify(this.live));
    assert.deepEqual(JSON.parse(JSON.stringify(this.previous.outboxMessages)), expected, `${label}: snapshot must equal live data`);
    assert.equal(this.state.table.size, expected.length, `${label}: db row count`);
    for (const row of expected) assert.deepEqual(this.state.table.get(row.id), row, `${label}: db row ${row.id}`);
  }
}

(async () => {
  // 1. Random append/mutate sequences, with batches merged and failed commits retried.
  for (let seed = 1; seed <= 25; seed += 1) {
    db.resetOutboxFastStateForTests();
    const rng = makeRng(seed);
    const h = new Harness();
    await h.init(20 + Math.floor(rng() * 30));
    for (let step = 0; step < 120; step += 1) {
      const ops = 1 + Math.floor(rng() * 4);
      for (let k = 0; k < ops; k += 1) {
        if (rng() < 0.4 || h.live.length === 0) { const r = newRow(); h.live.push(r); h.pending.add(r.id); }
        else { const r = h.live[Math.floor(rng() * h.live.length)]; r.status = ['sent', 'failed', 'retry'][Math.floor(rng() * 3)]; r.attempts += 1; r.nested.log.push(step); h.pending.add(r.id); }
      }
      if (rng() < 0.15) h.state.failNextCommit = true;
      const res = await h.flush('rows');
      if (!res.ok) { // a failed batch keeps its ids pending; more rows may arrive; next flush must catch up exactly
        const r = newRow(); h.live.push(r); h.pending.add(r.id);
        const retry = await h.flush('rows');
        assert.equal(retry.ok, true);
      }
      h.verify(`seed ${seed} step ${step}`);
    }
    assert.equal(db.isOutboxFastDisabledForTests(), false, `seed ${seed}: legitimate sequences must never trigger the mismatch guard`);
  }
  console.log('PASS random append/mutate/failed-batch sequences (25 seeds)');

  // 2. Fast path really is used (positions handed to the writer) for a normal single-row update.
  {
    db.resetOutboxFastStateForTests();
    const h = new Harness(); await h.init(50);
    h.live[10].status = 'sent'; h.pending.add(h.live[10].id);
    const res = await h.flush('rows');
    assert.ok(res.planned.outboxPositions && res.planned.outboxPositions.get(h.live[10].id) === 10, 'positions expected on the fast path');
    h.verify('single update');
    console.log('PASS fast path used for a single-row update');
  }

  // 3. New rows marked in a different order than they were added: must be placed by live position.
  {
    db.resetOutboxFastStateForTests();
    const h = new Harness(); await h.init(10);
    const a = newRow(), b = newRow(), c = newRow();
    h.live.push(a, b, c);
    h.pending.add(c.id); h.pending.add(a.id); h.pending.add(b.id);
    const res = await h.flush('rows');
    assert.equal(res.ok, true);
    assert.deepEqual(h.previous.outboxMessages.slice(-3).map((r) => r.id), [a.id, b.id, c.id]);
    h.verify('marking order');
    console.log('PASS touched order differs from append order');
  }

  // 4. A new row that was not marked: fast path must refuse (falls back), result still equals the full pass.
  {
    db.resetOutboxFastStateForTests();
    const h = new Harness(); await h.init(10);
    const a = newRow(), b = newRow();
    h.live.push(a, b); h.pending.add(a.id); // b unmarked
    const planned = db.cloneSnapshotForTablesPlanned(h.previous, h.data, new Set(['outboxMessages']), { outboxMessages: new Set(h.pending) });
    assert.equal(planned.outboxPositions, undefined, 'unmarked new row must disable the fast path for that batch');
    console.log('PASS unmarked appended row falls back to the full pass');
  }

  // 5. Same-length internal reorder of UNTOUCHED rows, with the DEFAULT shadow interval (50): the exact id check must detect it on the
  // very first batch (not rely on the shadow compare or on sampling), fall back to the full pass and write the correct order.
  {
    process.env.OUTBOX_SNAPSHOT_SHADOW_EVERY = '50';
    for (const [a, b] of [[5, 6], [0, 39], [38, 39], [17, 31]]) {
      db.resetOutboxFastStateForTests();
      const h = new Harness(); await h.init(40);
      const live = h.live;
      [live[a], live[b]] = [live[b], live[a]]; // untracked swap
      const changed = live[20]; changed.status = 'sent'; h.pending.add(changed.id);
      const planned = db.cloneSnapshotForTablesPlanned(h.previous, h.data, new Set(['outboxMessages']), { outboxMessages: new Set(h.pending) });
      assert.equal(planned.outboxPositions, undefined, `swap ${a}/${b}: reorder must make the fast path refuse`);
      const res = await h.flush('rows');
      assert.equal(res.ok, true);
      h.verify(`reorder ${a}/${b}`);
      assert.equal(db.isOutboxFastDisabledForTests(), false, 'detected before the shadow compare, so no mismatch');
    }
    process.env.OUTBOX_SNAPSHOT_SHADOW_EVERY = '1';
    console.log('PASS internal reorder detected exactly with the default shadow interval');
  }

  // 6. Replacement of a row by a different row at the same position and same array length.
  {
    db.resetOutboxFastStateForTests();
    const h = new Harness(); await h.init(30);
    const repl = newRow();
    h.live[7] = repl; h.pending.add(repl.id); // old id at pos 7 is not marked, new id is
    const res = await h.flush('rows');
    assert.equal(res.ok, true);
    h.verify('replace same length');
    console.log('PASS same-length replacement ends up correct');
  }

  // 7. A marked id that no longer exists in the live array (deletion): fall back, result correct.
  {
    db.resetOutboxFastStateForTests();
    const h = new Harness(); await h.init(30);
    const gone = h.live.splice(12, 1)[0]; h.pending.add(gone.id);
    const res = await h.flush('rows');
    assert.equal(res.ok, true);
    h.verify('deleted row');
    console.log('PASS deleted row handled');
  }

  // 8. Targeted COMMIT failure then restart: DB equals state before the failed batch; the next batch writes every row exactly once.
  {
    db.resetOutboxFastStateForTests();
    const h = new Harness(); await h.init(25);
    const before = new Map(h.state.table);
    const added = [newRow(), newRow()];
    h.live.push(...added); added.forEach((r) => h.pending.add(r.id));
    h.live[3].status = 'failed'; h.pending.add(h.live[3].id);
    h.state.failNextCommit = true;
    const failed = await h.flush('rows');
    assert.equal(failed.ok, false);
    assert.deepEqual([...h.state.table.keys()].sort(), [...before.keys()].sort(), 'rolled back: db unchanged');
    // "restart": a fresh process loads the DB rows as its live array and baseline snapshot
    const restarted = new Harness();
    restarted.state.table = new Map(h.state.table);
    restarted.live.push(...[...restarted.state.table.values()].map((r) => JSON.parse(JSON.stringify(r))));
    restarted.previous = JSON.parse(JSON.stringify(restarted.data));
    restarted.previous.outboxMessages = JSON.parse(JSON.stringify(restarted.live));
    const again = newRow(); restarted.live.push(again); restarted.pending.add(again.id);
    assert.equal((await restarted.flush('rows')).ok, true);
    restarted.verify('after restart');
    // same process retry of the failed batch also converges
    assert.equal((await h.flush('rows')).ok, true);
    h.verify('retry after commit failure');
    console.log('PASS commit failure + restart + retry');
  }

  // 9. Flag off: behaves like before (no positions).
  {
    process.env.OUTBOX_SNAPSHOT_FAST = '0';
    db.resetOutboxFastStateForTests();
    const h = new Harness(); await h.init(20);
    h.live[2].status = 'sent'; h.pending.add(h.live[2].id);
    const res = await h.flush('rows');
    assert.equal(res.planned.outboxPositions, undefined);
    h.verify('flag off');
    process.env.OUTBOX_SNAPSHOT_FAST = '1';
    console.log('PASS flag off keeps the original path');
  }

  console.log('ALL OK');
})().catch((err) => { console.error(err); process.exit(1); });
