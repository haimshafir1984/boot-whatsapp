'use strict';

/**
 * Scale test for the decision-recovery hot path (docs/decision-recovery-scale-fix-plan-2026-09-03.md, part A).
 *
 * Two O(n) scans used to sit on every inbound message once `expired-decision`
 * conversations accumulated over the 24h recovery window:
 *
 *   A.1  rememberTimedOutDecision() swept the whole timedOutDecisions Map on
 *        every call before inserting - src/messageFlow.ts.
 *   A.2  conversationState.findByPhone() scanned every pending conversation on
 *        every inbound message when the jid lookup missed - src/conversationState.ts.
 *
 * A.1 is now an amortized-O(1) front trim (insertion order === expiry order,
 * with a delete-before-set so a refreshed entry keeps that invariant).
 * A.2 is now an O(1) phoneIndex lookup (Map<normalizedPhone, Set<jid>>), kept
 * in sync by every map mutator including restore().
 *
 * Tests here:
 *   1. Repeat of the C-1 probe: timing must stay ~flat (< 3x), not linear, from
 *      0 -> 4000 accumulated records, for BOTH functions.
 *   2. Refreshed-entry trim: updating an existing sender must move it to the end
 *      of insertion order so the front trim cannot drop it early (the A.1 bug).
 *   3. phoneIndex consistency vs. the pre-index full scan as an ORACLE, after
 *      every kind of mutation.
 *   3a. "first, not last": two jids sharing one normalized phone -> findByPhone
 *      returns the first inserted, exactly like the old scan.
 *   4. restore() builds the index with no fresh message touching the states.
 *   5. Mutation guard: the OLD scan implementations, run over the same seeded
 *      data, DO grow linearly - proving test 1 actually discriminates.
 *   6. Index leak check: no empty Sets, no stale jids after churn.
 */

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { conversationState } = require('../dist/conversationState');
const { __recoveryScaleTestHooks: hooks } = require('../dist/messageFlow');

// ---------------------------------------------------------------------------
// Oracles: exact copies of the pre-optimization logic.
// ---------------------------------------------------------------------------

function normalizePhone(phone) {
  return String(phone ?? '').replace(/\D/g, '');
}

/** Pre-index conversationState.findByPhone() - the O(n) scan we replaced. */
function scanFindByPhone(entries, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return undefined;
  for (const entry of entries) {
    if (normalizePhone(entry.senderPhone) === normalized) return entry.jid;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decisionState(jid, phone) {
  return {
    kind: 'expired-decision',
    senderJid: jid,
    senderPhone: phone,
    campaignId: 'campaign-scale',
    campaignResultId: 'result-' + jid.slice(-6),
    flow: [{ id: 'q', kind: 'question', text: 'q', options: [{ id: 'yes', text: 'Yes' }] }],
    stepId: 'q',
    timestamp: Date.now(),
    timeoutHandle: undefined,
  };
}

function seedConversations(count, startAt = 0) {
  const jids = [];
  for (let i = startAt; i < startAt + count; i += 1) {
    const phone = `97250${String(1000000 + i).padStart(7, '0')}`;
    const jid = `whatsapp:${phone}`;
    jids.push(jid);
    conversationState.set(jid, decisionState(jid, phone));
  }
  return jids;
}

function clearAllConversations() {
  for (const { jid } of conversationState.__debugEntriesForTest()) {
    conversationState.remove(jid);
  }
}

function timeRemember(iterations, tag) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    hooks.rememberTimedOutDecision({
      senderJid: `whatsapp:9725900${String(100000 + i).padStart(6, '0')}`,
      senderPhone: `9725900${String(100000 + i).padStart(6, '0')}`,
      campaignId: 'c',
      campaignResultId: 'r',
      flow: [],
      stepId: 's',
      humanHandoff: {},
    });
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return ms;
}

function timeFindByPhone(iterations) {
  // Worst case for the old scan: a phone that is not present -> full sweep.
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    conversationState.findByPhone('9720000000000');
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function timeScanFindByPhone(iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    scanFindByPhone(conversationState.__debugEntriesForTest(), '9720000000000');
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/**
 * Oracle for the pre-fix rememberTimedOutDecision(): it swept EVERY entry on
 * every call before inserting. Reproduced here over the live seeded map so we
 * can prove that sweep grows linearly - the A.1 mutation guard.
 */
function timeOldRememberSweep(iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    const now = Date.now();
    for (const key of hooks.timedOutDecisionKeysInOrder()) {
      const item = hooks.peekTimedOutDecision(key);
      if (item && item.expiresAt <= now) { /* would delete */ }
    }
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

// ---------------------------------------------------------------------------
// Test 1 - timing stays ~flat, not linear
// ---------------------------------------------------------------------------

function testTimingFlat() {
  const sizes = [0, 1000, 3000, 4000];
  const rememberMs = {};
  const findMs = {};
  const scanMs = {};
  const sweepMs = {};

  for (const size of sizes) {
    clearAllConversations();
    hooks.clearAllTimedOutDecisions();

    if (size > 0) seedConversations(size);
    // Seed the same number of remembered timed-out decisions.
    for (let i = 0; i < size; i += 1) {
      hooks.rememberTimedOutDecision({
        senderJid: `whatsapp:97258${String(1000000 + i).padStart(7, '0')}`,
        senderPhone: `97258${String(1000000 + i).padStart(7, '0')}`,
        campaignId: 'c', campaignResultId: 'r', flow: [], stepId: 's', humanHandoff: {},
      });
    }

    // Read-only measurements first, while the seeded map size is still exactly
    // `size` (timeRemember below would otherwise add 20k entries and swamp the
    // linear signal in the sweep/scan oracles).
    timeFindByPhone(2000); // warm up
    findMs[size] = timeFindByPhone(20000);
    scanMs[size] = timeScanFindByPhone(2000);
    sweepMs[size] = timeOldRememberSweep(2000);

    // Mutating measurement last.
    timeRemember(2000); // warm up
    rememberMs[size] = timeRemember(20000);
  }

  console.log('  rememberTimedOutDecision (20k calls):');
  for (const size of sizes) console.log(`    ${String(size).padStart(4)} seeded: ${rememberMs[size].toFixed(1)} ms`);
  console.log('  findByPhone new / O(1) index (20k calls):');
  for (const size of sizes) console.log(`    ${String(size).padStart(4)} seeded: ${findMs[size].toFixed(1)} ms`);
  console.log('  findByPhone OLD / scan oracle (2k calls):');
  for (const size of sizes) console.log(`    ${String(size).padStart(4)} seeded: ${scanMs[size].toFixed(1)} ms`);
  console.log('  rememberTimedOutDecision OLD / full-sweep oracle (2k calls):');
  for (const size of sizes) console.log(`    ${String(size).padStart(4)} seeded: ${sweepMs[size].toFixed(1)} ms`);

  // The new paths must not blow up with accumulated records. Allow a generous
  // constant-factor band (GC / cache noise on CI), but nothing near linear.
  const rememberRatio = rememberMs[4000] / Math.max(rememberMs[0], 0.05);
  const findRatio = findMs[4000] / Math.max(findMs[0], 0.05);
  assert.ok(
    rememberRatio < 4,
    `rememberTimedOutDecision must stay ~flat: 0->4000 grew ${rememberRatio.toFixed(1)}x (${rememberMs[0].toFixed(1)} -> ${rememberMs[4000].toFixed(1)} ms)`,
  );
  assert.ok(
    findRatio < 4,
    `findByPhone must stay ~flat: 0->4000 grew ${findRatio.toFixed(1)}x (${findMs[0].toFixed(1)} -> ${findMs[4000].toFixed(1)} ms)`,
  );

  // Test 5 (mutation guard): the OLD scan MUST grow ~linearly over the same
  // data, or test 1 would pass even against a broken implementation.
  const scanRatio = scanMs[4000] / Math.max(scanMs[1000], 0.05);
  assert.ok(
    scanRatio > 2.5,
    `mutation guard (A.2): the old scan oracle should grow ~linearly 1000->4000, only saw ${scanRatio.toFixed(1)}x - the benchmark may not discriminate`,
  );
  const sweepRatio = sweepMs[4000] / Math.max(sweepMs[1000], 0.05);
  assert.ok(
    sweepRatio > 2.5,
    `mutation guard (A.1): the old full-sweep oracle should grow ~linearly 1000->4000, only saw ${sweepRatio.toFixed(1)}x`,
  );
  console.log(`  mutation guard: old findByPhone scan grew ${scanRatio.toFixed(1)}x, old remember sweep grew ${sweepRatio.toFixed(1)}x from 1000->4000 (linear, as expected)`);

  clearAllConversations();
  hooks.clearAllTimedOutDecisions();
  console.log('1. timing stays ~flat for both hot-path functions; old scan is confirmed linear.');
}

// ---------------------------------------------------------------------------
// Test 2 - a refreshed entry moves to the end of insertion order
// ---------------------------------------------------------------------------

function testRefreshedEntryTrim() {
  hooks.clearAllTimedOutDecisions();

  const mk = (phone) => ({
    senderJid: `whatsapp:${phone}`, senderPhone: phone,
    campaignId: 'c', campaignResultId: 'r', flow: [], stepId: 's', humanHandoff: {},
  });

  hooks.rememberTimedOutDecision(mk('972510000001'));
  hooks.rememberTimedOutDecision(mk('972510000002'));
  hooks.rememberTimedOutDecision(mk('972510000003'));

  let order = hooks.timedOutDecisionKeysInOrder();
  assert.deepEqual(order, ['972510000001', '972510000002', '972510000003'], 'baseline insertion order');

  // Update the first sender. It must jump to the END of insertion order, so the
  // front trim (which stops at the first non-expired entry) can never drop it
  // by its stale position.
  hooks.rememberTimedOutDecision(mk('972510000001'));
  order = hooks.timedOutDecisionKeysInOrder();
  assert.deepEqual(
    order, ['972510000002', '972510000003', '972510000001'],
    'a refreshed entry must be re-inserted at the end (delete-before-set), not left at its old position',
  );

  // Functional consequence: mark the two entries now at the front as expired,
  // then a new remember() call must trim BOTH of them - which only works
  // because entry 1 was repositioned to the back and no longer blocks the trim.
  hooks.peekTimedOutDecision('972510000002').expiresAt = Date.now() - 10_000;
  hooks.peekTimedOutDecision('972510000003').expiresAt = Date.now() - 5_000;
  hooks.rememberTimedOutDecision(mk('972510000009'));

  assert.equal(hooks.hasTimedOutDecision('972510000002'), false, 'expired front entry must be trimmed');
  assert.equal(hooks.hasTimedOutDecision('972510000003'), false, 'expired front entry must be trimmed');
  assert.equal(hooks.hasTimedOutDecision('972510000001'), true, 'the refreshed (still-valid) entry must survive the trim');
  assert.equal(hooks.hasTimedOutDecision('972510000009'), true, 'the newly remembered entry must be present');
  assert.equal(hooks.timedOutDecisionsSize(), 2, 'only the two valid entries remain');

  hooks.clearAllTimedOutDecisions();
  console.log('2. a refreshed entry is repositioned so the front trim cannot drop it early.');
}

// ---------------------------------------------------------------------------
// Test 3 - phoneIndex consistency vs. the scan oracle, after every mutation
// ---------------------------------------------------------------------------

function assertIndexMatchesOracle(context) {
  const entries = conversationState.__debugEntriesForTest();
  const phones = new Set(entries.map((e) => normalizePhone(e.senderPhone)));
  phones.add('9729999999999'); // a phone that is never present
  for (const phone of phones) {
    const viaIndex = conversationState.findByPhone(phone);
    const viaScan = scanFindByPhone(entries, phone);
    assert.equal(
      viaIndex ? viaIndex.senderJid : undefined,
      viaScan,
      `${context}: findByPhone(${phone}) disagreed with the full-scan oracle`,
    );
  }
}

function testIndexConsistency() {
  clearAllConversations();

  // set()
  conversationState.set('whatsapp:972520000001', decisionState('whatsapp:972520000001', '972520000001'));
  conversationState.set('whatsapp:972520000002', decisionState('whatsapp:972520000002', '972520000002'));
  conversationState.set('whatsapp:972520000003', decisionState('whatsapp:972520000003', '972520000003'));
  assertIndexMatchesOracle('after set x3');

  // set() replacing an existing jid with a DIFFERENT phone - the old phone must
  // stop resolving to it.
  conversationState.set('whatsapp:972520000002', decisionState('whatsapp:972520000002', '972520000999'));
  assertIndexMatchesOracle('after set replacing phone on existing jid');
  assert.equal(conversationState.findByPhone('972520000002'), undefined, 'the replaced-away phone must no longer resolve');
  assert.ok(conversationState.findByPhone('972520000999'), 'the new phone must resolve');

  // pause()
  conversationState.pause('whatsapp:972520000001');
  assertIndexMatchesOracle('after pause');

  // remove()
  conversationState.remove('whatsapp:972520000003');
  assertIndexMatchesOracle('after remove');

  // removeByPhone()
  conversationState.set('whatsapp:972520000004', decisionState('whatsapp:972520000004', '972520000004'));
  conversationState.set('whatsapp:972520000005', decisionState('whatsapp:972520000005', '972520000004')); // same phone
  assertIndexMatchesOracle('after adding two jids on one phone');
  conversationState.removeByPhone('972520000004');
  assertIndexMatchesOracle('after removeByPhone');
  assert.equal(conversationState.findByPhone('972520000004'), undefined, 'removeByPhone must clear every jid for that phone');

  // removeByCampaign()
  conversationState.set('whatsapp:972520000006', { ...decisionState('whatsapp:972520000006', '972520000006'), campaignId: 'other' });
  conversationState.set('whatsapp:972520000007', { ...decisionState('whatsapp:972520000007', '972520000007'), campaignId: 'other' });
  assertIndexMatchesOracle('after adding two on campaign "other"');
  conversationState.removeByCampaign('other');
  assertIndexMatchesOracle('after removeByCampaign');
  assert.equal(conversationState.findByPhone('972520000006'), undefined, 'removeByCampaign must unindex its conversations');

  clearAllConversations();
  console.log('3. phoneIndex stays in sync with the full-scan oracle across set/pause/remove/removeByPhone/removeByCampaign.');
}

// ---------------------------------------------------------------------------
// Test 3a - "first, not last"
// ---------------------------------------------------------------------------

function testFirstNotLast() {
  clearAllConversations();
  const phone = '972530000001';
  const jidA = 'whatsapp:972530000001@c.us';   // inserted first
  const jidB = 'whatsapp:972530000001';         // inserted second, same normalized phone

  conversationState.set(jidA, decisionState(jidA, phone));
  conversationState.set(jidB, decisionState(jidB, phone));

  const found = conversationState.findByPhone(phone);
  assert.ok(found, 'a shared phone must still resolve');
  assert.equal(found.senderJid, jidA, 'findByPhone must return the FIRST inserted jid for a shared phone, matching the old scan');

  // Remove the first; the second must now be returned.
  conversationState.remove(jidA);
  assert.equal(conversationState.findByPhone(phone).senderJid, jidB, 'after removing the first, the second becomes the head');

  clearAllConversations();
  console.log('3a. findByPhone returns the first inserted jid for a shared phone, not the last.');
}

// ---------------------------------------------------------------------------
// Test 4 - restore() builds the index without any fresh message
// ---------------------------------------------------------------------------

function testRestoreBuildsIndex() {
  clearAllConversations();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-scale-restore-'));
  const filePath = path.join(directory, 'conversation-state.json');

  try {
    const sharedPhone = '972540000001';
    const jidA = `whatsapp:${sharedPhone}@c.us`;
    const jidB = `whatsapp:${sharedPhone}`;
    const jidC = 'whatsapp:972540000002';

    const conversations = {};
    for (const [jid, phone] of [[jidA, sharedPhone], [jidB, sharedPhone], [jidC, '972540000002']]) {
      const { timeoutHandle, ...persistable } = decisionState(jid, phone);
      conversations[jid] = persistable;
    }
    const snapshot = { version: 1, savedAt: new Date().toISOString(), conversations };

    const backend = {
      loadConversationStateSnapshot: () => JSON.parse(JSON.stringify(snapshot)),
      saveConversationStateSnapshot: () => {},
    };
    conversationState.configurePersistence(filePath, backend);
    const restored = conversationState.restore(
      (jid) => setTimeout(() => {}, 60_000),
      () => [{ id: 'q', kind: 'question', text: 'q', options: [{ id: 'yes', text: 'Yes' }] }],
    );
    assert.equal(restored, 3, 'all three conversations must be restored');

    // The critical assertion: findByPhone works IMMEDIATELY after restore, with
    // no inbound message having touched any conversation.
    const found = conversationState.findByPhone(sharedPhone);
    assert.ok(found, 'findByPhone must work right after restore() - the index must be built inside restore()');
    assert.equal(found.senderJid, jidA, 'restore() must preserve first-inserted order in the index');
    assert.ok(conversationState.findByPhone('972540000002'), 'the standalone conversation must also be indexed by restore()');

    // And it still matches the oracle.
    assertIndexMatchesOracle('immediately after restore()');

    clearAllConversations();
    conversationState.configurePersistence('', undefined);
    console.log('4. restore() builds the phoneIndex itself - findByPhone works with no fresh message.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 6 - index leak check
// ---------------------------------------------------------------------------

function testNoIndexLeak() {
  clearAllConversations();

  const jids = seedConversations(200);
  // Churn: remove half by phone, re-add, pause, replace phones.
  for (let i = 0; i < jids.length; i += 2) conversationState.remove(jids[i]);
  seedConversations(100, 5000);
  for (const { jid } of conversationState.__debugEntriesForTest().slice(0, 20)) conversationState.pause(jid);

  const liveJids = new Set(conversationState.__debugEntriesForTest().map((e) => e.jid));
  const index = conversationState.__debugPhoneIndexForTest();
  for (const { phone, jids: indexedJids } of index) {
    assert.ok(indexedJids.length > 0, `phoneIndex must not keep an empty Set for ${phone}`);
    for (const jid of indexedJids) {
      assert.ok(liveJids.has(jid), `phoneIndex for ${phone} points at stale jid ${jid}`);
    }
  }
  // Every live conversation must be findable.
  for (const { jid, senderPhone } of conversationState.__debugEntriesForTest()) {
    const found = conversationState.findByPhone(senderPhone);
    assert.ok(found, `live conversation ${jid} must be findable by its phone`);
  }

  clearAllConversations();
  assert.equal(conversationState.__debugPhoneIndexForTest().length, 0, 'the index must be empty once every conversation is removed');
  console.log('6. no empty Sets, no stale jids in phoneIndex after heavy churn.');
}

// ---------------------------------------------------------------------------

(async () => {
  testTimingFlat();
  testRefreshedEntryTrim();
  testIndexConsistency();
  testFirstNotLast();
  testRestoreBuildsIndex();
  testNoIndexLeak();
  console.log('\nDecision-recovery scale tests passed.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
