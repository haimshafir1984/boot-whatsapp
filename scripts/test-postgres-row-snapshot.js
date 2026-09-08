'use strict';
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { cloneSnapshotForTables } = require('../dist/database');
const { emptyStorageData, Storage } = require('../dist/storage');
const source = emptyStorageData();
source.outboxMessages = Array.from({length: 20000}, (_, i) => ({ id: `row-${i}`, text: 'x'.repeat(500), status: 'sent', nested: { value: i } }));
const previous = cloneSnapshotForTables(null, source, 'all');
source.outboxMessages[12].status = 'failed';
const startFull = performance.now();
const full = cloneSnapshotForTables(previous, source, new Set(['outboxMessages']));
const fullMs = performance.now() - startFull;
const startRows = performance.now();
const next = cloneSnapshotForTables(previous, source, new Set(['outboxMessages']), {outboxMessages: new Set(['row-12'])});
const rowsMs = performance.now() - startRows;
assert.deepEqual(next, full, 'row-scoped clone must match the full durable snapshot');
assert.equal(next.outboxMessages[13], previous.outboxMessages[13], 'reuse only frozen previous rows');
assert.notEqual(next.outboxMessages[12], source.outboxMessages[12]);
source.outboxMessages[12].nested.value = 999;
source.outboxMessages[13].nested.value = 888;
assert.equal(next.outboxMessages[12].nested.value, 12, 'changed rows are detached before await');
assert.equal(next.outboxMessages[13].nested.value, 13, 'unchanged rows never alias live memory');
assert.equal(previous.outboxMessages[12].status, 'sent');
source.outboxMessages.splice(12, 1);
const deleted = cloneSnapshotForTables(next, source, new Set(['outboxMessages']), {outboxMessages: new Set(['row-12', 'row-13'])});
assert.equal(deleted.outboxMessages.some(x=>x.id === 'row-12'), false);
assert.equal(deleted.outboxMessages.find(x=>x.id === 'row-13').nested.value, 888);

const eventSource = emptyStorageData();
eventSource.campaignEvents = Array.from({length: 20000}, (_, i) => ({
  id: `event-${i}`,
  campaignId: 'campaign-1',
  type: 'step_sent',
  createdAt: new Date(1700000000000 + i).toISOString(),
  nested: { value: i, payload: 'x'.repeat(250) },
}));
const eventPrevious = cloneSnapshotForTables(null, eventSource, 'all');
const appendedEvent = {
  id: 'event-20000',
  campaignId: 'campaign-1',
  type: 'step_sent',
  createdAt: new Date(1700000020000).toISOString(),
  nested: { value: 20000, payload: 'new' },
};
eventSource.campaignEvents.push(appendedEvent);
const eventFullStart = performance.now();
const eventFull = cloneSnapshotForTables(eventPrevious, eventSource, new Set(['campaignEvents']));
const eventFullMs = performance.now() - eventFullStart;
const eventAppendStart = performance.now();
const eventNext = cloneSnapshotForTables(
  eventPrevious,
  eventSource,
  new Set(['campaignEvents']),
  {campaignEvents: new Set([appendedEvent.id])},
);
const eventAppendMs = performance.now() - eventAppendStart;
assert.deepEqual(eventNext, eventFull, 'append-only event clone must match the full durable snapshot');
assert.equal(eventNext.campaignEvents[1234], eventPrevious.campaignEvents[1234], 'detached event history must be reused');
assert.notEqual(eventNext.campaignEvents[20000], appendedEvent, 'new event must be detached from live memory');
appendedEvent.nested.value = 99999;
assert.equal(eventNext.campaignEvents[20000].nested.value, 20000, 'new event must be cloned before an async write');

eventSource.campaignEvents = eventSource.campaignEvents.slice(10000);
const eventReset = cloneSnapshotForTables(
  eventNext,
  eventSource,
  new Set(['campaignEvents']),
  {campaignEvents: 'all'},
);
assert.deepEqual(eventReset.campaignEvents, eventSource.campaignEvents, 'reset fallback must retain the current event data');
assert.notEqual(eventReset.campaignEvents[0], eventSource.campaignEvents[0], 'reset fallback must take a detached full copy');

const inconsistentSource = {...eventNext, campaignEvents: [...eventNext.campaignEvents, {...appendedEvent, id: 'event-untracked'}]};
const inconsistent = cloneSnapshotForTables(
  eventNext,
  inconsistentSource,
  new Set(['campaignEvents']),
  {campaignEvents: new Set(['different-id'])},
);
assert.deepEqual(inconsistent.campaignEvents, inconsistentSource.campaignEvents, 'inconsistent append markers must fall back without losing data');
assert.notEqual(inconsistent.campaignEvents[0], inconsistentSource.campaignEvents[0], 'inconsistent marker fallback must fully detach the snapshot');

let capturedPersist;
const storage = new Storage('unused-row-snapshot-test.json', {
  initialData: emptyStorageData(),
  backend: {
    mode: 'postgres',
    persistSnapshot(data, dirtyTables, dirtyRowIds) {
      capturedPersist = {data, dirtyTables, dirtyRowIds};
    },
    async flush() {},
    async close() {},
    health() { return {enabled: true, ready: true, pendingWrites: 0}; },
  },
});
const recorded = storage.recordCampaignEvent({campaignId: 'campaign-1', type: 'step_sent'});
assert.ok(capturedPersist.dirtyTables.has('campaignEvents'), 'recordCampaignEvent must mark the event table dirty');
assert.deepEqual([...capturedPersist.dirtyRowIds.campaignEvents], [recorded.id], 'recordCampaignEvent must identify the appended row');

console.log(JSON.stringify({
  passed: true,
  rows: 20000,
  rowSnapshot: { fullMs: Math.round(fullMs), scopedMs: Math.round(rowsMs), speedup: +(fullMs/rowsMs).toFixed(1) },
  eventSnapshot: { fullMs: Math.round(eventFullMs), appendMs: +eventAppendMs.toFixed(3), speedup: +(eventFullMs/eventAppendMs).toFixed(1) },
}));
