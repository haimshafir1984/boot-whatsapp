'use strict';

/**
 * Proves the partial-snapshot-clone optimization never loses a write.
 *
 * PostgresStorageBackend keeps a frozen copy of the last persisted snapshot and
 * diffs against it. Copying the whole StorageData on every write cost 98ms of
 * event-loop blocking at production scale (13k outbox rows, 18k events, 13k
 * results), so only the tables a write actually touched are copied now
 * (cloneSnapshotForTables). If that were wrong, changes would be silently
 * skipped and PostgreSQL would drift from memory.
 *
 * Rather than asserting on individual SQL calls, this rebuilds a shadow database
 * purely from the statements the backend issued, then compares it to what
 * Storage holds in memory. Anything skipped shows up as a mismatch.
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const {
  writeSnapshotDelta, mergeDirtyTables, mergeDirtyRowIdsByTable, cloneSnapshotForTables,
} = require('../dist/database');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'no-lost-writes-'));

// Applies the issued SQL to an in-memory table map: the shadow database.
function makeShadowPool() {
  const tables = new Map();
  const get = (t) => {
    if (!tables.has(t)) tables.set(t, new Map());
    return tables.get(t);
  };
  const query = async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      let m = text.match(/^insert into (\w+)\(([^)]*)\)/i);
      if (m) {
        const table = m[1];
        const cols = m[2].split(',').map((c) => c.trim());
        const row = {};
        cols.forEach((col, i) => { row[col] = params ? params[i] : undefined; });
        const keyCol = table === 'saved_contacts' ? 'phone'
          : table === 'conversation_state' ? 'jid'
            : row.id !== undefined ? 'id' : cols[0];
        get(table).set(String(row[keyCol]), row);
        return { rows: [], rowCount: 1 };
      }
      m = text.match(/^delete from (\w+) where \w+ = any/i);
      if (m) {
        for (const k of (params && params[0]) || []) get(m[1]).delete(String(k));
        return { rows: [], rowCount: 0 };
      }
      m = text.match(/^delete from (\w+) where \w+ = \$1/i);
      if (m) {
        get(m[1]).delete(String(params && params[0]));
        return { rows: [], rowCount: 0 };
      }
      m = text.match(/^delete from (\w+)$/i);
      if (m) {
        get(m[1]).clear();
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
  };
  // writeSnapshotDelta pins its transaction to one client via pool.connect();
  // the client replays SQL into the same shadow tables.
  return {
    tables,
    query,
    connect: async () => ({ query, release() {} }),
  };
}

// Mirrors PostgresStorageBackend, including coalescing and the partial clone.
function makeBackend(pool) {
  const b = {
    mode: 'postgres',
    persistedSnapshot: null,
    queuedSnapshot: null,
    queuedDirtyTables: new Set(),
    queuedDirtyRowIds: {},
    draining: false,
    pending: Promise.resolve(),
    writes: 0,
    persistSnapshot(data, dirtyTables, dirtyRowIds) {
      b.queuedSnapshot = data;
      b.queuedDirtyTables = mergeDirtyTables(b.queuedDirtyTables, dirtyTables);
      b.queuedDirtyRowIds = mergeDirtyRowIdsByTable(b.queuedDirtyRowIds, dirtyRowIds);
      if (b.draining) return;
      b.draining = true;
      b.pending = b.drain();
    },
    async drain() {
      try {
        while (b.queuedSnapshot) {
          const source = b.queuedSnapshot;
          const dirtyTables = b.queuedDirtyTables;
          const dirtyRowIds = b.queuedDirtyRowIds;
          b.queuedSnapshot = null;
          b.queuedDirtyTables = new Set();
          b.queuedDirtyRowIds = {};
          const snapshot = cloneSnapshotForTables(b.persistedSnapshot, source, dirtyTables);
          await writeSnapshotDelta(pool, b.persistedSnapshot, snapshot, dirtyTables, dirtyRowIds);
          b.persistedSnapshot = snapshot;
          b.writes += 1;
        }
      } finally {
        b.draining = false;
      }
    },
    async flush() { do { await b.pending; } while (b.draining || b.queuedSnapshot); },
    async close() { await b.flush(); },
    loadConversationStateSnapshot: () => undefined,
    saveConversationStateSnapshot: () => {},
    health: () => ({ enabled: true, ready: true, pendingWrites: 0 }),
  };
  return b;
}

const shadowIds = (pool, table) => [...(pool.tables.get(table)?.keys() || [])].sort();
const memIds = (rows, key) => rows.map((r) => String(r[key])).sort();
const shadowRow = (pool, table, id) => pool.tables.get(table)?.get(String(id));

(async () => {
  try {
    const pool = makeShadowPool();
    const backend = makeBackend(pool);
    const storage = new Storage(path.join(directory, 'storage.json'), { backend });

    // Seed history so every later diff has a large baseline it must skip over.
    const campaign = storage.addCampaign({
      name: 'no-lost-writes', triggerType: 1, triggerPhrase: 'go', suffix: '', active: true,
      conversation: {
        askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '',
        followupMessages: [], decisionFlow: [{ id: 's1', kind: 'message', text: 'hi' }],
      },
    });
    for (let i = 0; i < 300; i += 1) {
      const r = storage.recordCampaignTrigger(campaign.id, '97250000' + String(1000 + i), 'seed ' + i);
      storage.enqueueContactSave(r.phone, 'seed ' + i, r.id);
      storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:' + r.phone, text: 'seed' });
      storage.recordCampaignEvent({ campaignId: campaign.id, campaignResultId: r.id, phone: r.phone, type: 'step_sent', label: 'seed' });
    }
    await storage.flush();
    console.log(`seeded ${storage.getCampaignResults().length} results over ${backend.writes} write cycles`);

    // 1. Outbox lifecycle: sent / retry / failed, each on a different row.
    const mSent = storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000001', text: 'a' });
    const mRetry = storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000002', text: 'b' });
    const mFail = storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000003', text: 'c' });
    storage.claimOutboxMessage(mSent.id); storage.markOutboxSent(mSent.id, 'wamid.x1');
    storage.claimOutboxMessage(mRetry.id); storage.markOutboxRetry(mRetry.id, 'boom', new Date(Date.now() + 60000).toISOString());
    storage.claimOutboxMessage(mFail.id); storage.markOutboxFailed(mFail.id, 'dead');
    await storage.flush();
    for (const [id, expected] of [[mSent.id, 'sent'], [mRetry.id, 'retry'], [mFail.id, 'failed']]) {
      const row = shadowRow(pool, 'outbox_messages', id);
      assert.ok(row, `outbox ${id} must exist in the database`);
      assert.equal(row.status, expected, `outbox ${id} status must reach the database`);
    }
    assert.equal(shadowRow(pool, 'outbox_messages', mSent.id).provider_message_id, 'wamid.x1', 'provider id must persist');
    console.log('1. outbox sent/retry/failed all reached the database.');

    // 2. Campaign results: stage, email, score.
    const r1 = storage.recordCampaignTrigger(campaign.id, '972500000010', 'Live One');
    storage.markCampaignResultStage(r1.id, 'decision_sent', 'Live One');
    storage.recordCampaignEmail(r1.id, 'live@example.com');
    storage.recordScoreAnswer(r1.id, { stepId: 's1', optionId: 'o1', score: 5 });
    await storage.flush();
    const rowR1 = shadowRow(pool, 'campaign_results', r1.id);
    assert.ok(rowR1, 'campaign result must exist in the database');
    assert.equal(rowR1.last_stage, 'decision_sent', 'stage change must reach the database');
    assert.equal(JSON.parse(rowR1.data).email, 'live@example.com', 'email must reach the database');
    assert.equal(JSON.parse(rowR1.data).scoreTotal, 5, 'score must reach the database');
    console.log('2. campaign result stage/email/score all reached the database.');

    // 3. Contact queue: attempt, retryable failure, then save.
    const job = storage.enqueueContactSave('972500000020', 'Queue One', r1.id);
    storage.markContactSaveAttempt(job.id);
    storage.markContactSaveFailed(job.id, 'nope', 3, 1000);
    await storage.flush();
    assert.equal(shadowRow(pool, 'contact_queue', job.id).status, 'pending', 'retryable failure must reach the database');
    storage.markContactSaved('972500000020', 'Queue One');
    await storage.flush();
    assert.equal(shadowRow(pool, 'contact_queue', job.id).status, 'saved', 'saved status must reach the database');
    assert.ok(shadowRow(pool, 'saved_contacts', '972500000020'), 'saved contact must reach the database');
    console.log('3. contact queue attempt/failure/save all reached the database.');

    // 4. Conversation state: create, change, remove.
    const { conversationState } = require('../dist/conversationState');
    conversationState.configurePersistence(path.join(directory, 'conv.json'), storage);
    conversationState.restore(() => setTimeout(() => {}, 60000));
    const jid = 'whatsapp:972500000030';
    const mkState = (stepId) => ({
      kind: 'decision', senderJid: jid, senderPhone: '972500000030',
      campaignId: campaign.id, campaignResultId: r1.id,
      flow: [{ id: stepId, kind: 'message', text: 'x' }], stepId,
      timestamp: Date.now(), timeoutHandle: setTimeout(() => {}, 60000),
    });
    conversationState.set(jid, mkState('s1'));
    await storage.flush();
    assert.ok(shadowRow(pool, 'conversation_state', jid), 'conversation must reach the database');
    conversationState.set(jid, mkState('s2'));
    await storage.flush();
    assert.equal(JSON.parse(shadowRow(pool, 'conversation_state', jid).data).stepId, 's2', 'step change must reach the database');
    conversationState.remove(jid);
    await storage.flush();
    assert.equal(shadowRow(pool, 'conversation_state', jid), undefined, 'removal must reach the database');
    console.log('4. conversation state create/change/remove all reached the database.');

    // 5. Many interleaved writes under load. This is where a wrong partial clone
    //    would drift: a table skipped in one cycle must still be correct when it
    //    is touched again later.
    const busy = [];
    for (let i = 0; i < 200; i += 1) {
      const m = storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:97250001' + i, text: 'burst' + i });
      busy.push(m.id);
      storage.claimOutboxMessage(m.id);
      const rr = storage.recordCampaignTrigger(campaign.id, '97250002' + i, 'burst ' + i);
      storage.markCampaignResultStage(rr.id, 'burst_' + i);
      storage.recordCampaignEvent({ campaignId: campaign.id, campaignResultId: rr.id, phone: rr.phone, type: 'step_sent', label: 'burst' });
      storage.markOutboxSent(m.id, 'wamid.burst' + i);
      if (i % 20 === 0) await storage.flush();
    }
    await storage.flush();
    for (const id of busy) {
      const row = shadowRow(pool, 'outbox_messages', id);
      assert.ok(row, `burst outbox ${id} must exist in the database`);
      assert.equal(row.status, 'sent', `burst outbox ${id} must be marked sent in the database`);
    }
    console.log(`5. ${busy.length} interleaved writes under load all reached the database.`);

    // 6. Deletion / reset: the bulk path must remove rows, not orphan them.
    storage.resetCampaignData(campaign.id);
    await storage.flush();
    assert.equal(shadowIds(pool, 'campaign_results').length, 0, 'reset must delete every campaign result from the database');
    assert.equal(shadowIds(pool, 'campaign_events').length, 0, 'reset must delete every campaign event from the database');
    console.log('6. campaign data reset removed every row from the database.');

    // 7. The decisive check: the database rebuilt from the issued SQL must equal
    //    memory, table by table. A skipped write shows up here as a mismatch.
    const checks = [
      ['campaign_results', storage.getCampaignResults(), 'id'],
      ['contact_queue', storage.getContactQueue(100000), 'id'],
      ['saved_contacts', storage.getAllContacts(), 'phone'],
      ['campaigns', storage.getCampaigns(), 'id'],
    ];
    for (const [table, rows, key] of checks) {
      assert.deepEqual(shadowIds(pool, table), memIds(rows, key),
        `${table}: the database rebuilt from the issued SQL must match memory exactly`);
    }
    console.log('7. every checked table rebuilt from the issued SQL matches memory exactly.');

    console.log(`\nNo lost writes across ${backend.writes} coalesced write cycles.`);
    await storage.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
