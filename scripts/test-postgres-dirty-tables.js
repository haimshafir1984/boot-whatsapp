'use strict';

/**
 * Verifies the dirty-table skip optimization in writeSnapshotDelta/mergeDirtyTables
 * without needing a real PostgreSQL instance: a mocked pg.Pool records exactly which
 * queries were issued, so we can assert that untouched tables are never queried at
 * all, that the campaign_events append-only fast path only touches new rows, and
 * that a non-append change (e.g. a campaign-data reset) safely falls back to the
 * full comparison.
 */

const assert = require('assert');
const { writeSnapshotDelta, syncCampaignEventsDelta, syncOutboxMessagesDelta, mergeDirtyTables, mergeDirtyOutboxRows } = require('../dist/database');
const { emptyStorageData } = require('../dist/storage');

function makeMockPool() {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql: String(sql).trim().split('\n')[0].trim(), params });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

function tablesTouched(calls) {
  const touched = new Set();
  for (const call of calls) {
    const sql = call.sql.toLowerCase();
    const m = sql.match(/(?:insert into|delete from|select .* from)\s+(\w+)/);
    if (m) touched.add(m[1]);
  }
  return touched;
}

function baseSnapshot() {
  return emptyStorageData();
}

function campaignEvent(id, overrides = {}) {
  return { id, campaignId: 'c1', type: 'step_sent', createdAt: new Date().toISOString(), ...overrides };
}

(async () => {
  // 1. Nothing dirty -> zero queries besides begin/commit.
  {
    const pool = makeMockPool();
    const snap = baseSnapshot();
    await writeSnapshotDelta(pool, snap, snap, new Set(), new Set());
    const nonTxn = pool.calls.filter((c) => !/^(begin|commit|rollback)$/i.test(c.sql));
    assert.strictEqual(nonTxn.length, 0, `expected no table queries when nothing is dirty, got: ${JSON.stringify(nonTxn)}`);
  }

  // 2. Only outboxMessages dirty -> only outbox_messages table is touched, nothing else.
  {
    const pool = makeMockPool();
    const previous = baseSnapshot();
    const next = { ...previous, outboxMessages: [{ id: 'm1', kind: 'text', to: 'x', status: 'sent', attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] };
    await writeSnapshotDelta(pool, previous, next, new Set(['outboxMessages']), new Set(['m1']));
    const touched = tablesTouched(pool.calls);
    assert.deepStrictEqual([...touched], ['outbox_messages'], `expected only outbox_messages touched, got: ${[...touched]}`);
    const inserts = pool.calls.filter((c) => /^insert into outbox_messages/i.test(c.sql));
    assert.strictEqual(inserts.length, 1, 'the one new, explicitly-tagged outbox row must be upserted');
  }

  // 3. previous === null (first write ever) -> every populated table is written
  //    regardless of the (empty/irrelevant) dirty set passed in.
  {
    const pool = makeMockPool();
    const next = {
      ...baseSnapshot(),
      campaigns: [{ id: 'c1', triggerPhrase: 'hi', active: true }],
      outboxMessages: [{ id: 'm1', kind: 'text', to: 'x', status: 'sent', attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    };
    await writeSnapshotDelta(pool, null, next, new Set(), new Set());
    const touched = tablesTouched(pool.calls);
    assert.ok(touched.has('campaigns'), 'first write must sync campaigns even though the dirty set is empty');
    assert.ok(touched.has('outbox_messages'), 'first write must sync outbox_messages even though the dirty set is empty');
    assert.ok(touched.has('admin_settings'), 'first write must sync the singleton tables too');
  }

  // 4. mergeDirtyTables: union of two sets; 'all' poisons the merge either direction.
  {
    const a = new Set(['campaigns']);
    const b = new Set(['outboxMessages']);
    const merged = mergeDirtyTables(a, b);
    assert.strictEqual(merged instanceof Set, true);
    assert.deepStrictEqual([...merged].sort(), ['campaigns', 'outboxMessages']);
    assert.strictEqual(mergeDirtyTables('all', b), 'all');
    assert.strictEqual(mergeDirtyTables(a, 'all'), 'all');
  }

  // 5. campaign_events append-only fast path: previous is a true prefix of next ->
  //    only the new tail rows are upserted, nothing from the old prefix is re-touched.
  {
    const pool = makeMockPool();
    const previous = [campaignEvent('e1'), campaignEvent('e2')];
    const next = [...previous, campaignEvent('e3'), campaignEvent('e4')];
    await syncCampaignEventsDelta(pool, previous, next);
    const inserts = pool.calls.filter((c) => /^insert into campaign_events/i.test(c.sql));
    assert.strictEqual(inserts.length, 2, `append-only path must upsert exactly the 2 new rows, got ${inserts.length}`);
    const deletes = pool.calls.filter((c) => /^delete from campaign_events/i.test(c.sql));
    assert.strictEqual(deletes.length, 0, 'append-only path must never issue a delete');
  }

  // 6. campaign_events reset (removal, not a pure append) -> falls back to full
  //    comparison and correctly detects the removed rows for deletion.
  {
    const pool = makeMockPool();
    const previous = [campaignEvent('e1'), campaignEvent('e2'), campaignEvent('e3')];
    const next = [campaignEvent('e2')]; // e1 and e3 removed (e.g. resetCampaignData)
    await syncCampaignEventsDelta(pool, previous, next);
    const deletes = pool.calls.filter((c) => /^delete from campaign_events/i.test(c.sql));
    assert.strictEqual(deletes.length, 1, 'a non-append change must fall back to full delta and detect removals');
    assert.deepStrictEqual(deletes[0].params[0].sort(), ['e1', 'e3']);
  }

  // 7. campaign_events reorder (same ids, different order) is NOT a safe append ->
  //    also falls back to the full comparison rather than silently mis-syncing.
  {
    const pool = makeMockPool();
    const previous = [campaignEvent('e1'), campaignEvent('e2')];
    const next = [campaignEvent('e2'), campaignEvent('e1')];
    await syncCampaignEventsDelta(pool, previous, next);
    // Fallback path re-evaluates every row via sameJson; with identical content per id,
    // no upserts should fire, and definitely no incorrect skip of a real reorder scenario.
    const inserts = pool.calls.filter((c) => /^insert into campaign_events/i.test(c.sql));
    assert.strictEqual(inserts.length, 0, 'identical content in a different order must not cause unnecessary writes once handled via fallback');
  }

  // 8. mergeDirtyOutboxRows: union of two id sets; 'all' poisons the merge either direction.
  {
    const merged = mergeDirtyOutboxRows(new Set(['m1']), new Set(['m2']));
    assert.deepStrictEqual([...merged].sort(), ['m1', 'm2']);
    assert.strictEqual(mergeDirtyOutboxRows('all', new Set(['m1'])), 'all');
    assert.strictEqual(mergeDirtyOutboxRows(new Set(['m1']), 'all'), 'all');
  }

  function outboxMessage(id, overrides = {}) {
    const now = new Date().toISOString();
    return { id, kind: 'text', to: 'x', status: 'sent', attempts: 1, createdAt: now, updatedAt: now, ...overrides };
  }

  // 9. outbox row-level fast path: only the explicitly touched id is compared/
  //    upserted, even though thousands of unrelated rows exist alongside it.
  {
    const pool = makeMockPool();
    const many = Array.from({ length: 5000 }, (_, i) => outboxMessage('other' + i));
    const previous = [...many, outboxMessage('m1', { status: 'processing' })];
    const next = previous.map((row) => (row.id === 'm1' ? { ...row, status: 'sent', updatedAt: new Date().toISOString() } : row));
    const t0 = Date.now();
    await syncOutboxMessagesDelta(pool, previous, next, new Set(['m1']));
    const ms = Date.now() - t0;
    const inserts = pool.calls.filter((c) => /^insert into outbox_messages/i.test(c.sql));
    assert.strictEqual(inserts.length, 1, `only the touched row should be upserted, got ${inserts.length}`);
    assert.strictEqual(inserts[0].params[0], 'm1', 'the upserted row must be the one actually tagged as touched');
    assert.ok(ms < 50, `row-level sync of 5000 rows with 1 touched id should be near-instant, took ${ms}ms`);
  }

  // 10. outbox row-level fast path: a brand-new row (present in next, absent from
  //     previous) with its id correctly tagged is upserted like any other change.
  {
    const pool = makeMockPool();
    const previous = [outboxMessage('m1')];
    const next = [...previous, outboxMessage('m2')];
    await syncOutboxMessagesDelta(pool, previous, next, new Set(['m2']));
    const inserts = pool.calls.filter((c) => /^insert into outbox_messages/i.test(c.sql));
    assert.strictEqual(inserts.length, 1);
    assert.strictEqual(inserts[0].params[0], 'm2');
  }

  // 11. Safety net: if the untouched portion of the table changed in a way the
  //     caller didn't report (here, simulating a future code path that removes a
  //     row without tagging it), the row-level shortcut must not be trusted - fall
  //     back to the full comparison so the removal is still correctly detected.
  {
    const pool = makeMockPool();
    const previous = [outboxMessage('m1'), outboxMessage('untracked-removed')];
    const next = [outboxMessage('m1', { status: 'sent' })]; // 'untracked-removed' vanished, but wasn't in touchedIds
    await syncOutboxMessagesDelta(pool, previous, next, new Set(['m1']));
    const deletes = pool.calls.filter((c) => /^delete from outbox_messages/i.test(c.sql));
    assert.strictEqual(deletes.length, 1, 'an untracked removal must still be caught by the fallback, not silently missed');
    assert.deepStrictEqual(deletes[0].params[0], ['untracked-removed']);
  }

  // 12. dirtyOutboxRows === 'all' (unknown/legacy caller) always falls back to the
  //     exact full comparison, matching pre-optimization behavior exactly.
  {
    const pool = makeMockPool();
    const previous = [outboxMessage('m1'), outboxMessage('m2')];
    const next = [outboxMessage('m1'), outboxMessage('m2', { status: 'failed' })];
    await syncOutboxMessagesDelta(pool, previous, next, 'all');
    const inserts = pool.calls.filter((c) => /^insert into outbox_messages/i.test(c.sql));
    assert.strictEqual(inserts.length, 1, "'all' must still correctly detect the one real change via full comparison");
    assert.strictEqual(inserts[0].params[0], 'm2');
  }

  console.log('PostgreSQL dirty-table skip logic tests passed.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
