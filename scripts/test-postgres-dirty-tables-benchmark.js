'use strict';

/**
 * Benchmark, not a correctness test: reproduces the exact scale measured on a real
 * client (client-yhvdyt-pytns-meta-3fe79d6d: 12,869 outbox messages, 18,641 campaign
 * events, and a comparably large campaign_results history) and times a single
 * persist() cycle before vs after the dirty-table + row-level skip - i.e. the
 * original full sameJson scan of every table vs every call site correctly tagged
 * with the exact row id(s) it touched (outboxMessages and campaignResults both).
 * No real PostgreSQL needed - only the in-process clone + diff cost is measured,
 * via a mocked pool that returns instantly.
 */

const { writeSnapshotDelta } = require('../dist/database');
const { emptyStorageData } = require('../dist/storage');

// Reproduces the exact pre-optimization comparison this replaces: a full
// canonicalize-and-JSON.stringify sameJson() call against EVERY row of EVERY
// table, every single persist() - no table-level skip, no campaign_events
// append-only fast path. This is what actually ran in production before.
function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}
function sameJsonOld(left, right) {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}
async function originalFullDiff(pool, previous, data) {
  await pool.query('begin');
  for (const [table, key] of [['outboxMessages', 'id'], ['campaignEvents', 'id'], ['campaignResults', 'id'], ['contactQueue', 'id'], ['contactsList', 'phone']]) {
    const prevRows = previous ? previous[table] : [];
    const nextRows = data[table];
    const prevMap = new Map(prevRows.map((r) => [r[key], r]));
    const nextMap = new Map(nextRows.map((r) => [r[key], r]));
    for (const k of prevMap.keys()) if (!nextMap.has(k)) await pool.query('delete from ' + table + ' where id = $1', [k]);
    for (const [k, row] of nextMap) {
      if (prevMap.has(k) && sameJsonOld(prevMap.get(k), row)) continue;
      await pool.query('insert into ' + table + ' values ($1)', [row]);
    }
  }
  await pool.query('commit');
}

function makeMockPool() {
  return { query: () => Promise.resolve({ rows: [], rowCount: 0 }) };
}

function buildLargeSnapshot(outboxCount, eventCount, resultCount) {
  const now = new Date().toISOString();
  const outboxMessages = [];
  for (let i = 0; i < outboxCount; i += 1) {
    outboxMessages.push({
      id: 'm' + i, kind: 'text', to: 'whatsapp:97250000' + (i % 1000), status: 'sent',
      attempts: 1, createdAt: now, updatedAt: now, providerMessageId: 'wamid.' + i,
    });
  }
  const campaignEvents = [];
  for (let i = 0; i < eventCount; i += 1) {
    campaignEvents.push({
      id: 'e' + i, campaignId: 'c1', campaignResultId: 'r' + (i % 500), type: 'step_sent', createdAt: now,
    });
  }
  const campaignResults = [];
  for (let i = 0; i < resultCount; i += 1) {
    campaignResults.push({
      id: 'r' + i, campaignId: 'c1', phone: 'whatsapp:97250000' + (i % 1000), status: 'pending',
      lastStage: 'decision_sent', triggeredAt: now, updatedAt: now,
    });
  }
  return { ...emptyStorageData(), outboxMessages, campaignEvents, campaignResults };
}

// cloneSnapshot() is what PostgresStorageBackend does before calling writeSnapshotDelta;
// reproduce that same JSON round-trip cost here so the benchmark matches real runtime.
function cloneLike(data) {
  return JSON.parse(JSON.stringify(data));
}

async function timeOne(previous, next, dirty, dirtyRowIds, label) {
  const pool = makeMockPool();
  const t0 = Date.now();
  const clonedNext = cloneLike(next); // mirror PostgresStorageBackend's cloneSnapshot cost
  await writeSnapshotDelta(pool, previous, clonedNext, dirty, dirtyRowIds);
  const ms = Date.now() - t0;
  console.log(`${label}: ${ms}ms`);
  return ms;
}

(async () => {
  const OUTBOX_COUNT = 12_869;
  const EVENT_COUNT = 18_641;
  const RESULT_COUNT = 12_869; // same order of magnitude as outbox history for this client
  console.log(`Scale: ${OUTBOX_COUNT} outbox messages, ${EVENT_COUNT} campaign events, ${RESULT_COUNT} campaign results (matches the live client that was slow).\n`);

  const previous = buildLargeSnapshot(OUTBOX_COUNT, EVENT_COUNT, RESULT_COUNT);
  // Simulate exactly one real mutation: markOutboxSent on a single existing message,
  // plus the campaignResult it's tied to moving forward a stage (recordCampaignEvent).
  const next = cloneLike(previous);
  next.outboxMessages[0].status = 'sent';
  next.outboxMessages[0].updatedAt = new Date().toISOString();
  next.campaignResults[0].lastStage = 'decision_answered';
  next.campaignResults[0].updatedAt = new Date().toISOString();

  const beforePool = makeMockPool();
  const t0 = Date.now();
  await originalFullDiff(beforePool, previous, cloneLike(next));
  const beforeMs = Date.now() - t0;
  console.log(`BEFORE (original: full sameJson scan of every table, every persist()): ${beforeMs}ms`);

  const afterMs = await timeOne(
    previous, next, new Set(['outboxMessages', 'campaignResults']),
    { outboxMessages: new Set(['m0']), campaignResults: new Set(['r0']) },
    'AFTER  (dirty={outboxMessages,campaignResults}, rows m0/r0 tagged)',
  );

  console.log(`\nSpeedup for one combined touch: ${(beforeMs / Math.max(afterMs, 1)).toFixed(1)}x`);

  // ── Realistic scenario: sending ONE decision-question message end to end, exactly
  // as messageFlow.ts does it - enqueueOutboxMessage, claimOutboxMessage,
  // markOutboxSent (all dirty=outboxMessages), then recordCampaignEvent
  // (dirty=campaignEvents+campaignResults). Four separate persist() calls, summed.
  console.log('\n--- Realistic scenario: one full message-send cycle (4 persist() calls) ---');
  const persistCallDirtyTags = [
    ['outboxMessages'],           // enqueueOutboxMessage
    ['outboxMessages'],           // claimOutboxMessage
    ['outboxMessages'],           // markOutboxSent
    ['campaignEvents', 'campaignResults'], // recordCampaignEvent
  ];

  let beforeTotalMs = 0;
  for (let i = 0; i < persistCallDirtyTags.length; i += 1) {
    const pool = makeMockPool();
    const t = Date.now();
    await originalFullDiff(pool, previous, cloneLike(next));
    beforeTotalMs += Date.now() - t;
  }
  console.log(`BEFORE total for 4 calls: ${beforeTotalMs}ms`);

  let afterTotalMs = 0;
  for (const tags of persistCallDirtyTags) {
    const pool = makeMockPool();
    const t = Date.now();
    const clonedNext = cloneLike(next);
    const dirtyRowIds = {};
    if (tags.includes('outboxMessages')) dirtyRowIds.outboxMessages = new Set(['m0']);
    if (tags.includes('campaignResults')) dirtyRowIds.campaignResults = new Set(['r0']);
    await writeSnapshotDelta(pool, previous, clonedNext, new Set(tags), dirtyRowIds);
    afterTotalMs += Date.now() - t;
  }
  console.log(`AFTER  total for 4 calls: ${afterTotalMs}ms`);
  console.log(`Speedup for the realistic cycle: ${(beforeTotalMs / Math.max(afterTotalMs, 1)).toFixed(1)}x`);

  if (afterTotalMs > beforeTotalMs) {
    console.error('\nFAIL: the optimized path was not faster than the baseline for the realistic cycle.');
    process.exitCode = 1;
  } else {
    console.log('\nBenchmark completed - see numbers above.');
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
