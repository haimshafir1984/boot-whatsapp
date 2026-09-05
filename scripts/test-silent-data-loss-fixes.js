'use strict';

/**
 * Acceptance tests for the combined silent-data-loss fix (findings 01, 02,
 * 03, 11 from docs/shared-meta-flow-security-review-2026-09-05.md), built to
 * the binding decisions in docs/silent-data-loss-fix-plan-review-2026-09-05.md.
 *
 * Runs against the ACTUAL production code in dist/ (built by `npm run build`),
 * never a parallel reimplementation of the fixed logic - including the
 * mutation tests, which edit dist/*.js in place, run the real suite function
 * against the mutated file, then restore the original and re-verify.
 *
 * Postgres-backed sections (02) need a local test database. Same convention
 * as the rest of this test suite (test-postgres-*.js): set TEST_DATABASE_URL
 * to a local Postgres whose name contains "test", e.g.
 *   postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test
 * If it is not reachable, the 02 Postgres-backed checks are SKIPPED and
 * reported as skipped, not silently treated as passed.
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const results = [];
function record(name, fn) {
  return (async () => {
    try {
      await fn();
      results.push({ name, status: 'PASS' });
      console.log(`PASS - ${name}`);
    } catch (err) {
      results.push({ name, status: 'FAIL', error: err });
      console.error(`FAIL - ${name}`);
      console.error(err);
    }
  })();
}
function skip(name, reason) {
  results.push({ name, status: 'SKIP', reason });
  console.warn(`SKIP - ${name} (${reason})`);
}

function freshRequire(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(resolved);
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ===========================================================================
// SECTION 01 - messageFlow.ts: no silent swallow, in-flight dedup, needs_review
// blocking, restart persistence, other senders unaffected.
// ===========================================================================

function makeFakeTransport() {
  return {
    sent: [],
    failNext: 0,
    failAlways: false,
    async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); },
    async sendMessage(to, text) {
      if (this.failAlways || this.failNext > 0) {
        if (this.failNext > 0) this.failNext -= 1;
        throw new Error('planned transport failure');
      }
      this.sent.push({ to, text });
    },
  };
}

// A campaign whose first step's button transition ("endText") is sent via
// sendBotMessage AFTER conversationState.pause() and a campaign-event write
// have already happened - i.e. a real mid-flow business-mutation-adjacent
// send, the exact shape review doc 01 is about (not the initial auto-reply,
// which several resilient call sites already swallow send failures for by
// design by design elsewhere in the flow). Mirrors scripts/test-flow-concurrency.js.
function addDecisionCampaign(storage, name, trigger) {
  return storage.addCampaign({
    name,
    triggerType: 1,
    triggerPhrase: trigger,
    suffix: ' - Bot',
    active: true,
    conversation: {
      askNameEnabled: false,
      nameTimeoutMinutes: 5,
      askNameText: '',
      replyText: '',
      followupMessages: [],
      decisionFlow: [
        {
          id: 'step-one',
          kind: 'question',
          presentation: 'buttons',
          text: 'First question',
          timeoutMinutes: 30,
          options: [{ id: 'option-go', text: 'Continue', raffleEntry: true, endText: 'transition-message', nextStepId: 'step-two' }],
        },
        {
          id: 'step-two',
          kind: 'question',
          presentation: 'buttons',
          text: 'Second question',
          timeoutMinutes: 30,
          options: [{ id: 'option-finish', text: 'Finish' }],
        },
      ],
      decisionTimeoutMinutes: 30,
      decisionTimeoutText: '',
      decisionTimeoutMode: 'message',
      decisionTimeoutNextStepId: '',
      invalidReplyText: 'invalid',
      flowRecoveryText: 'restarting',
      humanHandoffEnabled: false,
      humanHandoffText: '',
      humanHandoffPhone: '',
    },
  });
}

let msgSeq = 0;
function makeIncoming(phone, body, overrides = {}) {
  msgSeq += 1;
  return {
    id: overrides.id || `sdlf-${msgSeq}`,
    from: `whatsapp:${phone}`,
    senderPhone: phone,
    body,
    isButtonReply: overrides.isButtonReply,
    hasUserSignal: Boolean(body),
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Test User'; },
    ...overrides,
  };
}

async function test01ParallelCallsShareRealOutcome() {
  const { Storage } = freshRequire('../dist/storage');
  const { handleIncomingWhatsAppMessage } = freshRequire('../dist/messageFlow');
  const dir = tmpDir('sdlf-01a-');
  const storage = new Storage(path.join(dir, 'storage.json'));
  addDecisionCampaign(storage, 'Parallel test', 'join-parallel');
  const transport = makeFakeTransport();
  const phone = '972500000201';
  const msg = makeIncoming(phone, 'join-parallel', { id: 'parallel-msg-1' });

  // Two concurrent calls for the SAME message id. Both must observe the same
  // real outcome (success), not a fake immediate success for the second one
  // while the first is still in flight.
  const [r1, r2] = await Promise.allSettled([
    handleIncomingWhatsAppMessage(msg, storage, transport, 'webhook'),
    handleIncomingWhatsAppMessage(msg, storage, transport, 'webhook'),
  ]);
  assert.equal(r1.status, 'fulfilled', 'first concurrent call must succeed');
  assert.equal(r2.status, 'fulfilled', 'second concurrent call must succeed (shares the first attempt, not a fake success)');
  assert.equal(transport.sent.filter((item) => item.text.includes('First question')).length, 1, 'the first question must be sent exactly once despite two concurrent identical-id calls');
}

async function test01DuplicateAfterSuccessIsNoop() {
  const { Storage } = freshRequire('../dist/storage');
  const { handleIncomingWhatsAppMessage } = freshRequire('../dist/messageFlow');
  const dir = tmpDir('sdlf-01b-');
  const storage = new Storage(path.join(dir, 'storage.json'));
  addDecisionCampaign(storage, 'Dedup test', 'join-dedup');
  const transport = makeFakeTransport();
  const phone = '972500000202';
  const msg = makeIncoming(phone, 'join-dedup', { id: 'dedup-msg-1' });

  await handleIncomingWhatsAppMessage(msg, storage, transport, 'webhook');
  await handleIncomingWhatsAppMessage(msg, storage, transport, 'webhook');
  assert.equal(transport.sent.filter((item) => item.text.includes('First question')).length, 1, 'a true duplicate (same id, after success) must not re-run the handler');
}

async function test01FailurePropagatesAndBlocksSender() {
  const { Storage } = freshRequire('../dist/storage');
  const { conversationState } = freshRequire('../dist/conversationState');
  const { handleIncomingWhatsAppMessage, SenderHeldForReviewError } = freshRequire('../dist/messageFlow');
  const dir = tmpDir('sdlf-01c-');
  const storage = new Storage(path.join(dir, 'storage.json'));
  addDecisionCampaign(storage, 'Blocked sender test', 'join-blocked');
  const transport = makeFakeTransport();
  const blockedPhone = '972500000203';
  const otherPhone = '972500000204';

  await handleIncomingWhatsAppMessage(makeIncoming(blockedPhone, 'join-blocked'), storage, transport, 'webhook');
  transport.failAlways = true;
  await assert.rejects(
    handleIncomingWhatsAppMessage(makeIncoming(blockedPhone, 'option-go', { isButtonReply: true }), storage, transport, 'webhook'),
    /planned transport failure/,
    'a processing failure must propagate to the caller, not be swallowed',
  );
  const blockedState = conversationState.get(`whatsapp:${blockedPhone}`);
  assert.equal(blockedState && blockedState.kind, 'needs_review', 'the failed sender must be held as needs_review');

  // R1: a second message from the SAME sender must stay blocked - and this is
  // no longer ordinary "success that did nothing" (the old plain `return`).
  // It must throw a dedicated, non-success error (SenderHeldForReviewError)
  // so any caller (an Inbox drainer, in particular) can tell "held" apart
  // from silent success and never call markCompleted() on it.
  transport.failAlways = false; // even though the transport would now succeed...
  await assert.rejects(
    handleIncomingWhatsAppMessage(makeIncoming(blockedPhone, 'option-go', { isButtonReply: true, id: 'held-msg-1' }), storage, transport, 'webhook'),
    (err) => err instanceof SenderHeldForReviewError,
    'a message for an already-blocked sender must reject with SenderHeldForReviewError, not resolve as if it were ordinary success',
  );
  assert.equal(transport.sent.filter((item) => item.text.includes('Second question')).length, 0, '...a still-blocked sender must not have advanced past the failed step');
  const afterHeld = conversationState.get(`whatsapp:${blockedPhone}`);
  assert.equal(afterHeld.kind, 'needs_review', 'the block must remain until explicitly resolved');
  // R1: the held message must be durably recorded, not just rejected and forgotten.
  assert.equal(afterHeld.heldMessages?.length, 1, 'the message that arrived while blocked must be recorded into heldMessages');
  assert.equal(afterHeld.heldMessages[0].messageId, 'held-msg-1');

  // A re-delivery of the SAME held message id must be a true no-op (same
  // dedup contract as a normal successfully-handled message, per
  // handleIncomingWhatsAppMessage's own rememberHandled(id) call for the
  // held case) - it resolves quietly rather than rejecting again, and must
  // not add a second heldMessages entry.
  await handleIncomingWhatsAppMessage(makeIncoming(blockedPhone, 'option-go', { isButtonReply: true, id: 'held-msg-1' }), storage, transport, 'webhook');
  assert.equal(conversationState.get(`whatsapp:${blockedPhone}`).heldMessages.length, 1, 'a re-delivery of the same held message id must not duplicate the heldMessages entry');

  // A genuinely NEW message while still blocked must be appended.
  await assert.rejects(
    handleIncomingWhatsAppMessage(makeIncoming(blockedPhone, 'still here?', { id: 'held-msg-2' }), storage, transport, 'webhook'),
    (err) => err instanceof SenderHeldForReviewError,
  );
  assert.equal(conversationState.get(`whatsapp:${blockedPhone}`).heldMessages.length, 2, 'a second, different message while blocked must be appended to heldMessages');

  // A DIFFERENT sender must be entirely unaffected.
  await handleIncomingWhatsAppMessage(makeIncoming(otherPhone, 'join-blocked'), storage, transport, 'webhook');
  assert.equal(transport.sent.filter((item) => item.to === `whatsapp:${otherPhone}` && item.text.includes('First question')).length, 1, 'a different sender on the same campaign must be processed normally');
  assert.equal(conversationState.get(`whatsapp:${otherPhone}`) && conversationState.get(`whatsapp:${otherPhone}`).kind, 'decision', 'a different sender must not be blocked');
}

async function test01RestartPersistsTheBlock() {
  const { Storage } = freshRequire('../dist/storage');
  const { conversationState } = freshRequire('../dist/conversationState');
  const { handleIncomingWhatsAppMessage, scheduleRestoredConversationTimeout } = freshRequire('../dist/messageFlow');
  const dir = tmpDir('sdlf-01e-');
  const storagePath = path.join(dir, 'storage.json');
  const convPath = path.join(dir, 'conversation-state.json');
  const storage = new Storage(storagePath);
  addDecisionCampaign(storage, 'Restart test', 'join-restart');
  conversationState.configurePersistence(convPath, storage);
  // Mirrors index.ts's startup sequence: restore() (even against a
  // not-yet-existing file, returning 0) marks hydration complete, which is
  // what actually turns persist() on - without this, persist() is a
  // deliberate no-op guarding against overwriting a snapshot before the
  // initial restore has happened.
  conversationState.restore(() => undefined);
  const transport = makeFakeTransport();
  const phone = '972500000206';
  const jid = `whatsapp:${phone}`;

  await handleIncomingWhatsAppMessage(makeIncoming(phone, 'join-restart'), storage, transport, 'webhook');
  transport.failAlways = true;
  await handleIncomingWhatsAppMessage(makeIncoming(phone, 'option-go', { isButtonReply: true }), storage, transport, 'webhook').catch(() => {});
  assert.equal(conversationState.get(jid).kind, 'needs_review');
  assert.ok(fs.existsSync(convPath), 'the block must have been persisted to the conversation-state file');

  // Simulate a restart: fresh in-process module state via a new require, and
  // restore() from the same file on disk.
  const { conversationState: freshConversationState } = freshRequire('../dist/conversationState');
  freshConversationState.configurePersistence(convPath, storage);
  const restoredCount = freshConversationState.restore(
    (restoreJid, state) => scheduleRestoredConversationTimeout(storage, () => transport, restoreJid, state),
  );
  assert.ok(restoredCount >= 1, 'restore() must bring back at least the needs_review conversation');
  const restoredState = freshConversationState.get(jid);
  assert.equal(restoredState && restoredState.kind, 'needs_review', 'the needs_review block must survive a restart, not just live in memory');
}

// ===========================================================================
// SECTION 01 (mutation): reintroducing the original catch-without-throw must
// break test01FailurePropagatesAndBlocksSender.
// ===========================================================================

async function test01Mutation() {
  const distPath = require.resolve('../dist/messageFlow');
  const original = fs.readFileSync(distPath, 'utf8');
  const from = 'await markSenderNeedsReview(message, source, err, storage, transport);\n                    throw err;';
  const to = 'await markSenderNeedsReview(message, source, err, storage, transport);\n                    // MUTATED: original silent swallow (no throw)';
  assert.ok(original.includes(from), 'mutation anchor not found in dist/messageFlow.js - has the compiled output changed shape?');
  fs.writeFileSync(distPath, original.replace(from, to), 'utf8');
  try {
    let mutationDetected = false;
    try {
      await test01FailurePropagatesAndBlocksSender();
    } catch {
      mutationDetected = true;
    }
    assert.ok(mutationDetected, 'reverting the throw must make test01FailurePropagatesAndBlocksSender fail, but it passed');
  } finally {
    fs.writeFileSync(distPath, original, 'utf8');
    delete require.cache[distPath];
  }
  // Re-verify the real (unmutated) behavior passes again.
  freshRequire('../dist/messageFlow');
  await test01FailurePropagatesAndBlocksSender();
}

// ===========================================================================
// R1 follow-up - found during independent verification (not in R1-R6): an
// OLDER 'held' item permanently occupied its sender's one group slot in
// claimBatch(), because 'held' was not excluded from firstOutstandingByGroup
// the way 'completed'/'failed' already were. isClaimable() correctly rejects
// 'held' outright, so the group then yielded NOTHING claimable - a genuinely
// NEW, later message from the same still-blocked sender sat as 'queued'
// forever: never claimed, never itself transitioned to 'held', never
// appended to conversationState's heldMessages, invisible to the admin
// resolve flow. Reproduced directly against MetaGatewayInbox before fixing.
// ===========================================================================

async function testR1SecondMessageForHeldSenderIsClaimable() {
  const { MetaGatewayInbox } = freshRequire('../dist/metaGatewayInbox');
  const dir = tmpDir('sdlf-r1-second-');
  const inbox = new MetaGatewayInbox(path.join(dir, 'inbox.json'));
  const senderKeyOf = (item) => item.payload.sender;

  inbox.enqueue('m1', { sender: 'A', body: 'first' });
  const firstClaim = inbox.claimBatch(10, senderKeyOf);
  assert.equal(firstClaim.length, 1, 'first message must be claimable');
  inbox.markHeld(firstClaim[0].id, 'blocked pending review');

  inbox.enqueue('m2', { sender: 'A', body: 'second, arrives while sender A is still held' });
  const secondClaim = inbox.claimBatch(10, senderKeyOf);
  assert.equal(secondClaim.length, 1, 'a second message from the SAME still-held sender must still be claimable - not masked by the older held item');
  assert.equal(secondClaim[0].id, 'm2');

  // An unrelated sender must be entirely unaffected.
  inbox.enqueue('n1', { sender: 'B', body: 'unrelated sender' });
  const otherClaim = inbox.claimBatch(10, senderKeyOf);
  assert.equal(otherClaim.length, 1);
  assert.equal(otherClaim[0].id, 'n1');
}

async function testR1SecondMessageMutation() {
  const distPath = require.resolve('../dist/metaGatewayInbox');
  const original = fs.readFileSync(distPath, 'utf8');
  const from = "item.status === 'completed' || item.status === 'failed' || item.status === 'held')";
  const to = "item.status === 'completed' || item.status === 'failed')";
  assert.ok(original.includes(from), 'mutation anchor not found in dist/metaGatewayInbox.js - has the compiled output changed shape?');
  fs.writeFileSync(distPath, original.replace(from, to), 'utf8');
  try {
    let mutationDetected = false;
    try {
      await testR1SecondMessageForHeldSenderIsClaimable();
    } catch {
      mutationDetected = true;
    }
    assert.ok(mutationDetected, 'reverting the held-exclusion must make testR1SecondMessageForHeldSenderIsClaimable fail, but it passed');
  } finally {
    fs.writeFileSync(distPath, original, 'utf8');
    delete require.cache[distPath];
  }
  freshRequire('../dist/metaGatewayInbox');
  await testR1SecondMessageForHeldSenderIsClaimable();
}

// ===========================================================================
// SECTION 03 - metaGatewayInbox.ts: commit-then-publish rollback at every
// write stage (enqueue/claim/update), restart preserves last committed state.
// ===========================================================================

function withPatchedFs(patches, fn) {
  const originals = {};
  for (const key of Object.keys(patches)) originals[key] = fs[key];
  Object.assign(fs, patches);
  return Promise.resolve(fn()).finally(() => Object.assign(fs, originals));
}

async function test03EnqueueRollsBackOnPersistFailure() {
  const { MetaGatewayInbox } = freshRequire('../dist/metaGatewayInbox');
  const dir = tmpDir('sdlf-03a-');
  const file = path.join(dir, 'inbox.json');
  const inbox = new MetaGatewayInbox(file);

  let calls = 0;
  await withPatchedFs({
    writeFileSync: (...args) => {
      calls += 1;
      throw new Error('simulated disk full on temp write');
    },
  }, () => {
    assert.throws(() => inbox.enqueue('item-1', { hello: 'world' }), /simulated disk full/);
  });
  assert.ok(calls >= 1, 'writeFileSync must actually have been attempted');

  // Retry with fs working again: must actually attempt the write again (not
  // silently return a half-committed `existing`), and it must succeed.
  const item = inbox.enqueue('item-1', { hello: 'world' });
  assert.equal(item.status, 'queued');
  assert.equal(inbox.counts().queued, 1, 'exactly one item after the retry - the failed attempt left no ghost entry');
  // Directly verify the retry actually reached disk - if the failed attempt
  // had left `item-1` in memory (rollback broken), this second enqueue() call
  // would short-circuit on the `existing` check and never call persistData()
  // again, so the file would stay exactly as it was after the failure
  // (nonexistent, since the very first attempt never got past writeFileSync).
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(onDisk.items.some((entry) => entry.id === 'item-1'), 'the retried enqueue must actually have persisted to disk, not matched a pre-existing in-memory item');
}

async function test03ClaimBatchRollsBackOnPersistFailure() {
  const { MetaGatewayInbox } = freshRequire('../dist/metaGatewayInbox');
  const dir = tmpDir('sdlf-03b-');
  const file = path.join(dir, 'inbox.json');
  const inbox = new MetaGatewayInbox(file);
  inbox.enqueue('claim-1', { a: 1 });

  await withPatchedFs({
    renameSync: () => { throw new Error('simulated rename failure during claim'); },
  }, () => {
    assert.throws(() => inbox.claimBatch(10), /simulated rename failure/);
  });

  // The item must still be claimable - it must NOT be stuck 'processing' in
  // memory while the durable copy still shows 'queued'.
  const claimed = inbox.claimBatch(10);
  assert.equal(claimed.length, 1, 'the item must still be claimable after the rolled-back attempt');
  assert.equal(claimed[0].status, 'processing');
}

async function test03UpdateRollsBackOnPersistFailure() {
  const { MetaGatewayInbox } = freshRequire('../dist/metaGatewayInbox');
  const dir = tmpDir('sdlf-03c-');
  const file = path.join(dir, 'inbox.json');
  const inbox = new MetaGatewayInbox(file);
  inbox.enqueue('update-1', { a: 1 });
  inbox.claimBatch(10);

  await withPatchedFs({
    copyFileSync: () => { throw new Error('simulated backup-copy failure during markCompleted'); },
  }, () => {
    assert.throws(() => inbox.markCompleted('update-1'), /simulated backup-copy failure/);
  });
  assert.equal(inbox.counts().completed, 0, 'a failed markCompleted() must not leave the item completed in memory');
  assert.equal(inbox.counts().processing, 1, 'the item must still show its pre-failure status');

  // Now let it succeed for real.
  inbox.markCompleted('update-1');
  assert.equal(inbox.counts().completed, 1);
}

async function test03PruneHistoryNotLostOnEnqueueFailure() {
  const { MetaGatewayInbox } = freshRequire('../dist/metaGatewayInbox');
  const dir = tmpDir('sdlf-03d-');
  const file = path.join(dir, 'inbox.json');
  const inbox = new MetaGatewayInbox(file);
  // Two completed items old enough that pruneCompleted's cutoff keeps them (default retention is 2h, well within "now").
  inbox.enqueue('old-1', { a: 1 });
  inbox.claimBatch(10);
  inbox.markCompleted('old-1');
  inbox.enqueue('old-2', { a: 1 });
  inbox.claimBatch(10);
  inbox.markCompleted('old-2');
  assert.equal(inbox.counts().completed, 2);

  await withPatchedFs({
    writeFileSync: () => { throw new Error('simulated failure right at prune+enqueue'); },
  }, () => {
    assert.throws(() => inbox.enqueue('new-1', { a: 1 }), /simulated failure/);
  });
  // The completed history that pruneCompleted() would have trimmed must still
  // be fully present - a mid-way failure must not silently apply the prune
  // half of the operation while dropping the new-item half.
  assert.equal(inbox.counts().completed, 2, 'completed history must be exactly what it was before the failed enqueue attempt');
  assert.equal(inbox.counts().queued, 0);
}

async function test03RestartPreservesLastCommittedState() {
  const { MetaGatewayInbox } = freshRequire('../dist/metaGatewayInbox');
  const dir = tmpDir('sdlf-03e-');
  const file = path.join(dir, 'inbox.json');
  const inbox = new MetaGatewayInbox(file);
  inbox.enqueue('r-1', { a: 1 });
  inbox.claimBatch(10);
  await withPatchedFs({
    renameSync: () => { throw new Error('simulated failure'); },
  }, () => {
    assert.throws(() => inbox.markCompleted('r-1'));
  });
  // "Restart": fresh instance reading the same file.
  const { MetaGatewayInbox: ReloadedInbox } = freshRequire('../dist/metaGatewayInbox');
  const reopened = new ReloadedInbox(file);
  assert.equal(reopened.counts().processing, 1, 'restart must see the last actually-committed state (processing), not the failed markCompleted');
  assert.equal(reopened.counts().completed, 0);
}

async function test03Mutation() {
  const distPath = require.resolve('../dist/metaGatewayInbox');
  const original = fs.readFileSync(distPath, 'utf8');
  const from = '        fs_1.default.renameSync(tempPath, this.filePath);\n        this.data = next;';
  const to = '        fs_1.default.renameSync(tempPath, this.filePath);\n        this.data = next;\n        // (rollback removed by mutation test - see below, this line intentionally left as-is; the real mutation replaces persistData below)';
  // The real mutation: make persistData assign this.data BEFORE the risky
  // write, i.e. remove the rollback guarantee entirely.
  const anchor = 'persistData(next) {\n        const directory = path_1.default.dirname(this.filePath);\n        fs_1.default.mkdirSync(directory, { recursive: true });\n        const tempPath = `${this.filePath}.tmp`;\n        const backupPath = `${this.filePath}.bak`;';
  assert.ok(original.includes(anchor), 'mutation anchor not found in dist/metaGatewayInbox.js');
  const mutated = original.replace(
    anchor,
    anchor + '\n        this.data = next; // MUTATED: publish BEFORE the durable write, defeating rollback',
  );
  fs.writeFileSync(distPath, mutated, 'utf8');
  try {
    let mutationDetected = false;
    try {
      await test03EnqueueRollsBackOnPersistFailure();
    } catch {
      mutationDetected = true;
    }
    assert.ok(mutationDetected, 'removing the rollback must make test03EnqueueRollsBackOnPersistFailure fail, but it passed');
  } finally {
    fs.writeFileSync(distPath, original, 'utf8');
    delete require.cache[distPath];
  }
  freshRequire('../dist/metaGatewayInbox');
  await test03EnqueueRollsBackOnPersistFailure();
}

// ===========================================================================
// SECTION 11 - ownerStorage.ts combinatorics + rollback + mutation.
// ===========================================================================

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), 'utf-8');
}

function validClient(id, overrides = {}) {
  return { id, name: 'Client ' + id, accessCode: 'code-' + id, createdAt: new Date().toISOString(), ownerAccessToken: 'secret-' + id, ...overrides };
}

async function test11FreshInstall() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-11a-');
  const store = new OwnerStorage(path.join(dir, 'clients.json'));
  assert.deepEqual(store.getClients(), [], 'no main, no .bak -> fresh install -> []');
}

async function test11MainMissingBackupValid() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-11b-');
  const main = path.join(dir, 'clients.json');
  writeJson(`${main}.bak`, [validClient('a')]);
  const store = new OwnerStorage(main);
  assert.equal(store.getClients().length, 1, 'main missing but .bak valid must recover from .bak, not report fresh install');
}

async function test11MainMissingBackupCorrupt() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-11c-');
  const main = path.join(dir, 'clients.json');
  fs.writeFileSync(`${main}.bak`, '{not json', 'utf-8');
  assert.throws(() => new OwnerStorage(main), /could not be parsed/, 'main missing + .bak corrupt must throw, not silently return []');
}

async function test11MainCorruptNoBackup() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-11d-');
  const main = path.join(dir, 'clients.json');
  fs.writeFileSync(main, '{not json', 'utf-8');
  assert.throws(() => new OwnerStorage(main), /could not be parsed/);
}

async function test11MainCorruptBackupValid() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-11e-');
  const main = path.join(dir, 'clients.json');
  fs.writeFileSync(main, '{not json', 'utf-8');
  writeJson(`${main}.bak`, [validClient('b')]);
  const store = new OwnerStorage(main);
  assert.equal(store.getClients().length, 1, 'main corrupt but .bak valid must recover from .bak');
  // The corrupt main file must be left on disk for diagnosis, not deleted.
  assert.ok(fs.existsSync(main), 'the corrupt main file must be kept on disk, not silently removed');
}

async function test11MainEmptyArrayIsLegitimate() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-11f-');
  const main = path.join(dir, 'clients.json');
  writeJson(main, []);
  writeJson(`${main}.bak`, [validClient('should-not-appear')]);
  const store = new OwnerStorage(main);
  assert.deepEqual(store.getClients(), [], 'a valid main file containing [] is legitimate and must NOT be replaced by an older .bak');
}

async function test11StructurallyValidButInvalidRecords() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-11g-');
  const main = path.join(dir, 'clients.json');
  writeJson(main, [null]);
  assert.throws(() => new OwnerStorage(main), /could not be parsed/, '[null] must not be treated as a valid (if empty-ish) registry');

  const dir2 = tmpDir('sdlf-11g2-');
  const main2 = path.join(dir2, 'clients.json');
  writeJson(main2, [{ name: 'no id' }]); // missing id
  assert.throws(() => new OwnerStorage(main2), /could not be parsed/, 'a record missing id must invalidate the whole registry');

  const dir3 = tmpDir('sdlf-11g3-');
  const main3 = path.join(dir3, 'clients.json');
  writeJson(main3, [validClient('dup'), validClient('dup')]); // duplicate ids
  assert.throws(() => new OwnerStorage(main3), /could not be parsed/, 'duplicate ids must invalidate the whole registry');
}

async function test11RenameFailureDuringRepairDoesNotTouchValidBackup() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-11h-');
  const main = path.join(dir, 'clients.json');
  writeJson(main, [validClient('existing')]);
  const store = new OwnerStorage(main);
  // The constructor deliberately does NOT auto-persist (finding 11, point 2),
  // so no .bak exists yet. Do one successful write first so a real .bak
  // exists (a copy of the then-valid main file).
  store.addClient('First', 'code-1');
  const mainAfterFirst = fs.readFileSync(main, 'utf-8');

  // persistClients() copies whatever the CURRENT valid main holds into .bak
  // before attempting the rename - by design, that step legitimately
  // advances .bak on every successful write (it is not meant to stay frozen
  // at its very first value). What matters for finding 11 is: (a) that copy
  // is only ever made FROM a provably-valid main (covered by
  // test11CorruptMainNeverCopiedOverGoodBackup), and (b) a rename failure
  // afterwards still leaves .bak as a valid, readable registry and does not
  // commit the failed write to either memory or the main file.
  await withPatchedFs({
    renameSync: () => { throw new Error('simulated rename failure'); },
  }, () => {
    assert.throws(() => store.addClient('Second', 'code-2'), /simulated rename failure/);
  });
  const bakAfterFailedAttempt = fs.readFileSync(`${main}.bak`, 'utf-8');
  assert.doesNotThrow(() => {
    const parsed = JSON.parse(bakAfterFailedAttempt);
    assert.ok(Array.isArray(parsed) && parsed.length === 2, '.bak must still be a valid, readable 2-client registry after the rename failure');
  }, '.bak must remain valid JSON after a rename failure elsewhere in the write');
  assert.equal(fs.readFileSync(main, 'utf-8'), mainAfterFirst, 'the main file must be untouched by the failed rename (still holding only existing+First)');
  assert.equal(store.getClients().length, 2, 'the in-memory list must not include the client from the failed add (existing+First only)');
}

async function test11CorruptMainNeverCopiedOverGoodBackup() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-11i-');
  const main = path.join(dir, 'clients.json');
  writeJson(main, [validClient('good')]);
  const store = new OwnerStorage(main);
  // Establish a real .bak via one successful write (constructor does not auto-persist).
  store.addClient('Seed', 'seed-code');
  const bakSnapshot = fs.readFileSync(`${main}.bak`, 'utf-8');

  // Now corrupt the ON-DISK main file directly (simulating external
  // corruption), without going through OwnerStorage. The in-memory `store`
  // still thinks its state is fine.
  fs.writeFileSync(main, '{not json', 'utf-8');

  // The next persistClients() call must detect the on-disk main is invalid
  // and must NOT copy it over the good .bak.
  store.addClient('AfterCorruption', 'after-code');
  const bakAfter = fs.readFileSync(`${main}.bak`, 'utf-8');
  assert.equal(bakAfter, bakSnapshot, 'a corrupt on-disk main file must never be copied over the .bak, even during a normal successful write');
}

async function test11AddUpdateDeleteRollback() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-11j-');
  const main = path.join(dir, 'clients.json');
  const store = new OwnerStorage(main);
  const client = store.addClient('Rollback test', 'rb-code');

  await withPatchedFs({
    writeFileSync: () => { throw new Error('simulated disk failure'); },
  }, () => {
    assert.throws(() => store.addClient('Should not persist', 'rb-code-2'));
  });
  assert.equal(store.getClients().length, 1, 'a failed addClient must not leave the new client in memory');

  await withPatchedFs({
    writeFileSync: () => { throw new Error('simulated disk failure'); },
  }, () => {
    assert.throws(() => store.updateClient(client.id, { name: 'Should not apply' }));
  });
  assert.equal(store.getClient(client.id).name, 'Rollback test', 'a failed updateClient must not change the in-memory record');

  await withPatchedFs({
    writeFileSync: () => { throw new Error('simulated disk failure'); },
  }, () => {
    assert.throws(() => store.deleteClient(client.id));
  });
  assert.equal(store.getClients().length, 1, 'a failed deleteClient must not remove the in-memory record');
}

async function test11Mutation() {
  const distPath = require.resolve('../dist/ownerStorage');
  const original = fs.readFileSync(distPath, 'utf8');
  // Reinstate the original bug: corrupt JSON -> silently return [].
  const anchor = 'function validateRegistry(parsed) {\n    if (!Array.isArray(parsed))\n        return null;';
  assert.ok(original.includes(anchor), 'mutation anchor not found in dist/ownerStorage.js');
  const mutatedLoad = original.replace(
    'load() {\n        const dir = path_1.default.dirname(this.filePath);\n        if (!fs_1.default.existsSync(dir))\n            fs_1.default.mkdirSync(dir, { recursive: true });\n        const backupPath = `${this.filePath}.bak`;',
    'load() {\n        const dir = path_1.default.dirname(this.filePath);\n        if (!fs_1.default.existsSync(dir))\n            fs_1.default.mkdirSync(dir, { recursive: true });\n        if (fs_1.default.existsSync(this.filePath)) { try { const p = JSON.parse(fs_1.default.readFileSync(this.filePath, "utf-8")); if (Array.isArray(p)) return p; } catch { return []; /* MUTATED: original silent swallow */ } }\n        const backupPath = `${this.filePath}.bak`;',
  );
  assert.notEqual(mutatedLoad, original, 'mutation replacement did not match dist/ownerStorage.js load() - has the compiled output changed shape?');
  fs.writeFileSync(distPath, mutatedLoad, 'utf8');
  try {
    let mutationDetected = false;
    try {
      await test11MainCorruptNoBackup();
    } catch {
      mutationDetected = true;
    }
    assert.ok(mutationDetected, 'reinstating the silent catch{return []} must make test11MainCorruptNoBackup fail, but it passed');
  } finally {
    fs.writeFileSync(distPath, original, 'utf8');
    delete require.cache[distPath];
  }
  freshRequire('../dist/ownerStorage');
  await test11MainCorruptNoBackup();
}

// ===========================================================================
// SECTION 02 - database.ts (PostgreSQL): dirty-state survival, backoff,
// flush() covering late arrivals, close() semantics. Requires TEST_DATABASE_URL.
// ===========================================================================

function assertSafeTestDatabase(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const testName = parsed.pathname.toLowerCase().includes('test');
  if (!local || !testName) {
    throw new Error('Refusing to run: TEST_DATABASE_URL must point to a local database whose name contains "test".');
  }
}

async function getPgTestHarness() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) return null;
  assertSafeTestDatabase(databaseUrl);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('select 1');
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
  return { databaseUrl, pool };
}

async function clearOutbox(pool) {
  const exists = await pool.query("select to_regclass('public.outbox_messages') as name");
  if (exists.rows[0]?.name) await pool.query('delete from outbox_messages');
}

async function test02DirtyStateSurvivesFailure(harness) {
  const { createPostgresBackend, migrateDatabase } = freshRequire('../dist/database');
  const { Storage, emptyStorageData } = freshRequire('../dist/storage');
  await migrateDatabase(harness.databaseUrl);
  await clearOutbox(harness.pool);
  const backend = await createPostgresBackend(harness.databaseUrl);
  const storage = new Storage('unused-sdlf-02a.json', { initialData: emptyStorageData(), backend });
  await storage.flush();

  await harness.pool.query("alter table outbox_messages add constraint tmp_sdlf_fail check (recipient <> 'whatsapp:SDLF_BREAK')");
  try {
    storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:SDLF_BREAK', text: 'doomed' });
    await assert.rejects(storage.flush());
  } finally {
    await harness.pool.query('alter table outbox_messages drop constraint tmp_sdlf_fail');
  }

  // Deliberately do NOT enqueue anything else yet. If the failed batch's
  // dirty markers were dropped instead of merged back (the original bug /
  // the mutation below), the scheduled backoff retry finds queuedSnapshot
  // empty and silently no-ops - nothing else would ever trigger a further
  // attempt, and this lone doomed write would never become durable. Proving
  // THIS write recovers on its own, with no other write's coincidentally-
  // shared object reference able to mask the bug, is what actually exercises
  // the merge-back.
  const soloDeadline = Date.now() + 10000;
  let soloOk = false;
  while (Date.now() < soloDeadline) {
    try { await storage.flush(); soloOk = true; break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  assert.ok(soloOk, 'flush() for the solitary doomed write must eventually succeed once the constraint is gone, via its own scheduled backoff retry - not dropped');

  // Now prove a write that arrives WHILE still backing off from a separate
  // failure is not lost either.
  await harness.pool.query("alter table outbox_messages add constraint tmp_sdlf_fail_b check (recipient <> 'whatsapp:SDLF_BREAK_B')");
  try {
    storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:SDLF_BREAK_B', text: 'doomed-b' });
    await assert.rejects(storage.flush());
    storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000777', text: 'unrelated' });
  } finally {
    await harness.pool.query('alter table outbox_messages drop constraint tmp_sdlf_fail_b');
  }
  const deadline = Date.now() + 10000;
  let ok = false;
  while (Date.now() < deadline) {
    try { await storage.flush(); ok = true; break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  assert.ok(ok, 'flush() must eventually succeed once the constraint is gone and the backoff retry runs');

  const { loadStorageSnapshot } = freshRequire('../dist/database');
  const reloaded = await loadStorageSnapshot(harness.databaseUrl);
  const recipients = reloaded.outboxMessages.map((m) => m.to);
  assert.ok(recipients.includes('whatsapp:SDLF_BREAK'), 'the originally-doomed write must be durable once retried');
  assert.ok(recipients.includes('whatsapp:SDLF_BREAK_B'), 'the second doomed write must be durable once retried');
  assert.ok(recipients.includes('whatsapp:972500000777'), 'the unrelated write that arrived during the failure must ALSO be durable - not dropped');
  await backend.close();
}

async function test02BackoffIsBoundedNotBusyLoop(harness) {
  const { createPostgresBackend, migrateDatabase } = freshRequire('../dist/database');
  const { Storage, emptyStorageData } = freshRequire('../dist/storage');
  await migrateDatabase(harness.databaseUrl);
  await clearOutbox(harness.pool);
  const backend = await createPostgresBackend(harness.databaseUrl);
  const storage = new Storage('unused-sdlf-02b.json', { initialData: emptyStorageData(), backend });
  await storage.flush();

  let attemptCount = 0;
  const originalError = console.error;
  console.error = (...args) => {
    if (String(args[0] || '').includes('PostgreSQL storage write failed')) attemptCount += 1;
    // still forward to keep other diagnostics visible
  };

  await harness.pool.query("alter table outbox_messages add constraint tmp_sdlf_fail2 check (recipient <> 'whatsapp:SDLF_BREAK2')");
  try {
    const stopAt = Date.now() + 3500; // within first three backoff steps (500/1000/2000ms)
    let i = 0;
    while (Date.now() < stopAt) {
      i += 1;
      storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:SDLF_BREAK2', text: `doomed-${i}` });
      await new Promise((r) => setTimeout(r, 50));
    }
    // Sustained traffic every 50ms for 3.5s is 70 potential triggers; with
    // real backoff, actual write ATTEMPTS against Postgres must be small
    // (bounded by the 500/1000/2000ms schedule, not 70).
    assert.ok(attemptCount <= 6, `expected a small, backoff-bounded number of write attempts, got ${attemptCount} (busy-loop bypassing backoff?)`);
    assert.ok(attemptCount >= 1, 'at least one attempt must have happened');
  } finally {
    console.error = originalError;
    await harness.pool.query('alter table outbox_messages drop constraint tmp_sdlf_fail2');
  }

  // Let it recover, then close cleanly.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { await storage.flush(); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  await backend.close();
}

async function test02CloseDuringBackoffFailsWithinBudget(harness) {
  const { createPostgresBackend, migrateDatabase } = freshRequire('../dist/database');
  const { Storage, emptyStorageData } = freshRequire('../dist/storage');
  await migrateDatabase(harness.databaseUrl);
  await clearOutbox(harness.pool);
  const backend = await createPostgresBackend(harness.databaseUrl);
  const storage = new Storage('unused-sdlf-02c.json', { initialData: emptyStorageData(), backend });
  await storage.flush();

  await harness.pool.query("alter table outbox_messages add constraint tmp_sdlf_fail3 check (recipient <> 'whatsapp:SDLF_BREAK3')");
  try {
    storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:SDLF_BREAK3', text: 'doomed' });
    await assert.rejects(storage.flush()); // first attempt fails synchronously-ish, backoff now scheduled
    const started = Date.now();
    await assert.rejects(storage.close(), /unsaved writes remain/, 'close() during backoff must report a documented failure, not hang or silently succeed');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `close() must return promptly during backoff, not wait out the full schedule (elapsed=${elapsed}ms)`);
  } finally {
    await harness.pool.query('alter table outbox_messages drop constraint tmp_sdlf_fail3').catch(() => {});
  }
}

async function test02Mutation(harness) {
  const distPath = require.resolve('../dist/database');
  const original = fs.readFileSync(distPath, 'utf8');
  const anchor = 'this.queuedSnapshot = this.queuedSnapshot ?? source;';
  assert.ok(original.includes(anchor), 'mutation anchor not found in dist/database.js');
  const mutated = original.replace(anchor, 'this.queuedSnapshot = null; // MUTATED: original bug, drops dirty state on failure');
  fs.writeFileSync(distPath, mutated, 'utf8');
  try {
    let mutationDetected = false;
    try {
      await test02DirtyStateSurvivesFailure(harness);
    } catch {
      mutationDetected = true;
    }
    assert.ok(mutationDetected, 'dropping the dirty-state merge-back must make test02DirtyStateSurvivesFailure fail, but it passed');
  } finally {
    fs.writeFileSync(distPath, original, 'utf8');
    delete require.cache[distPath];
  }
  freshRequire('../dist/database');
  await test02DirtyStateSurvivesFailure(harness);
}

// ===========================================================================
// R1-R6 - independent-review follow-up (docs/silent-data-loss-independent-review-2026-09-05.md).
// This section turns the six diagnostic repros in
// scripts/audit-silent-loss-review-gaps.js (CONFIRMED 1-6, which assert the
// BUGGY behavior existed) into acceptance tests that assert the FIXED
// contract - inverted expectations, same methodology (real dist/ modules,
// real Storage, real conversationState, a real connected startAdminServer +
// Inbox drainer for the HTTP-level claims).
// ===========================================================================

// ---- shared real-HTTP harness (R1 CONFIRMED 4, R2 CONFIRMED 5, R6) --------
// One server instance is reused across every HTTP-level scenario below - each
// scenario uses its own phone/campaign so they stay independent, avoiding the
// need to reload the config module's env-derived singleton mid-suite (config
// is only ever loaded fresh, right here, the first time dist/adminServer is
// required in this process).
async function getHttpTestHarness() {
  const dir = tmpDir('sdlf-http-');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    WHATSAPP_PROVIDER: 'META_CLOUD_API',
    BOT_REPLY_DELAY_MS: '0',
    STORAGE_PATH: path.join(dir, 'storage.json'),
    OWNER_STORAGE_PATH: path.join(dir, 'owner.json'),
    CONVERSATION_STATE_PATH: path.join(dir, 'conversation.json'),
    OWNER_ACCESS_TOKEN: 'sdlf-http-owner-token',
    CLIENT_ACCESS_TOKEN: 'sdlf-http-client-token',
    META_ACCESS_TOKEN: '',
    DOKPLOY_META_ACCESS_TOKEN: '',
    META_APP_SECRET: '',
  });
  // Every dist module that (transitively) touches conversationState must be
  // freshRequired here, IN DEPENDENCY ORDER, so each one's own internal
  // `require('./conversationState')` (etc.) resolves to the SAME fresh
  // instance this harness uses - not a stale one left cached in
  // require.cache by an earlier unit-level test in this same process (which
  // freshRequire only clears for the exact module path passed to it, not
  // transitively). Missing this for messageFlow specifically was an actual
  // bug found while writing this suite: adminServer.ts's own conversationState
  // reference was fresh, but a stale, previously-cached messageFlow.js still
  // held an OLD conversationState instance, so a block set through
  // harness.conversationState was invisible to handleIncomingWhatsAppMessage.
  const { config } = freshRequire('../dist/config');
  config.ADMIN_PORT = 0;
  const { Storage } = freshRequire('../dist/storage');
  const { conversationState } = freshRequire('../dist/conversationState');
  freshRequire('../dist/metaGatewayInbox');
  freshRequire('../dist/ownerStorage');
  freshRequire('../dist/messageFlow');
  const storage = new Storage(process.env.STORAGE_PATH);
  conversationState.configurePersistence(process.env.CONVERSATION_STATE_PATH, storage);
  conversationState.restore(() => undefined);
  addDecisionCampaign(storage, 'HTTP harness campaign', 'join-http');
  const { startAdminServer } = freshRequire('../dist/adminServer');
  const server = startAdminServer(storage);
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/auth/client/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode: 'sdlf-http-client-token' }),
  });
  assert.equal(login.status, 200, 'client login must succeed for the HTTP harness');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const inboxPath = path.join(dir, 'meta-client-inbox.json');
  return { dir, storage, server, base, cookie, conversationState, inboxPath };
}

async function closeHttpTestHarness(harness) {
  harness.server.closeAllConnections?.();
  await new Promise((resolve) => harness.server.close(resolve));
}

function readInboxItem(inboxPath, id) {
  if (!fs.existsSync(inboxPath)) return undefined;
  const data = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
  return data.items.find((item) => item.id === id);
}

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// R1 (P1): a blocked sender's reply must be recorded as 'held' in the real
// connected Inbox worker, never 'completed' - inverts CONFIRMED 4 exactly.
async function testR1RealHttpInboxHoldsBlockedReplyNotCompleted(harness) {
  const phone = '15551110001';
  const jid = `whatsapp:${phone}`;
  harness.conversationState.set(jid, {
    kind: 'needs_review', senderJid: jid, senderPhone: phone,
    reason: 'synthetic pre-existing block', timestamp: Date.now(),
  });

  const messageId = 'r1-held-http-' + Date.now();
  const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'r1-number' },
    messages: [{ id: messageId, from: phone, type: 'text', text: { body: 'are you still there' }, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] };
  const response = await fetch(`${harness.base}/internal/meta/whatsapp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Owner-Token': 'sdlf-http-owner-token' }, body: JSON.stringify(payload),
  });
  assert.equal(response.status, 202);

  const item = await waitFor(() => {
    const found = readInboxItem(harness.inboxPath, messageId);
    return found && found.status !== 'processing' && found.status !== 'queued' ? found : undefined;
  });
  assert.equal(item.status, 'held', `the real connected Inbox worker must mark a blocked sender's reply 'held', got '${item.status}' (this is the exact bug the independent review's CONFIRMED 4 reproduced)`);

  const held = harness.conversationState.get(jid);
  assert.equal(held.kind, 'needs_review', 'the block itself must be untouched');
  assert.ok(held.heldMessages?.some((entry) => entry.messageId === messageId), 'the held reply must be durably recorded for the admin to see, not silently dropped');
}

// R2 (P1): the resolve endpoint must hold up its HTTP response until the
// removal actually commits, fail (not 200) when the commit fails, and keep
// the block (in memory too) in that case. Inverts CONFIRMED 5.
async function testR2ResolveRequiresRealCommit(harness) {
  const phone = '15551110002';
  const jid = `whatsapp:${phone}`;
  harness.conversationState.set(jid, {
    kind: 'needs_review', senderJid: jid, senderPhone: phone,
    reason: 'synthetic block for resolve test', timestamp: Date.now(),
  });
  await harness.storage.flush();

  const realFlush = harness.storage.flush.bind(harness.storage);
  let flushCalls = 0;
  harness.storage.flush = async () => { flushCalls += 1; throw new Error('synthetic resolve commit unavailable'); };
  try {
    const failedResolve = await fetch(`${harness.base}/api/needs-review/${encodeURIComponent(jid)}/resolve`, {
      method: 'POST', headers: { Cookie: harness.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ heldMessagesAction: 'discard' }),
    });
    assert.notEqual(failedResolve.status, 200, 'resolve must NOT report 200 when the removal could not be durably committed');
    assert.ok(flushCalls >= 1, 'the throwing flush stub must actually have been called - proving the endpoint really awaits a commit, not just a synchronous conversationState.remove()');
    assert.equal(harness.conversationState.get(jid)?.kind, 'needs_review', 'the block must remain in memory too when the commit failed');
  } finally {
    harness.storage.flush = realFlush;
  }

  // Now let it actually succeed.
  const okResolve = await fetch(`${harness.base}/api/needs-review/${encodeURIComponent(jid)}/resolve`, {
    method: 'POST', headers: { Cookie: harness.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ heldMessagesAction: 'discard' }),
  });
  assert.equal(okResolve.status, 200);
  assert.equal(harness.conversationState.get(jid), undefined, 'a real, committed resolve must actually remove the block');
}

// R1 point 5 / R6: resolve must require an explicit choice for held
// messages, and the list endpoint must expose them (never a silent default,
// never invisible to the admin).
async function testR6DashboardApiRequiresExplicitChoiceAndExposesHeldMessages(harness) {
  const phone = '15551110003';
  const jid = `whatsapp:${phone}`;
  harness.conversationState.set(jid, {
    kind: 'needs_review', senderJid: jid, senderPhone: phone,
    reason: 'synthetic block for dashboard test', timestamp: Date.now(),
  });
  harness.conversationState.appendHeldMessage(jid, { messageId: 'dash-1', source: 'webhook', bodyPreview: 'hello?', timestamp: Date.now() });
  await harness.storage.flush();

  const list = await (await fetch(`${harness.base}/api/needs-review`, { headers: { Cookie: harness.cookie } })).json();
  const item = list.items.find((entry) => entry.jid === jid);
  assert.ok(item, 'the needs-review list must include this blocked sender');
  assert.equal(item.heldMessageCount, 1);
  assert.equal(item.heldMessages?.[0]?.bodyPreview, 'hello?');

  const missingAction = await fetch(`${harness.base}/api/needs-review/${encodeURIComponent(jid)}/resolve`, {
    method: 'POST', headers: { Cookie: harness.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(missingAction.status, 400, 'resolve without an explicit heldMessagesAction must be rejected, not default to either behavior silently');
  assert.equal(harness.conversationState.get(jid)?.kind, 'needs_review', 'a rejected resolve call must not have unblocked the sender');

  const explicit = await fetch(`${harness.base}/api/needs-review/${encodeURIComponent(jid)}/resolve`, {
    method: 'POST', headers: { Cookie: harness.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ heldMessagesAction: 'discard' }),
  });
  assert.equal(explicit.status, 200);
  const body = await explicit.json();
  assert.equal(body.heldMessagesAction, 'discard');

  const unauth = await fetch(`${harness.base}/api/needs-review/${encodeURIComponent(jid)}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ heldMessagesAction: 'discard' }),
  });
  assert.ok(unauth.status === 401 || unauth.status === 403, `resolve must require authentication, got ${unauth.status}`);
}

// R11 (secret redaction, small completion 2): an error string containing a
// credential-shaped substring must never reach the admin API response body.
async function testSecretRedactionOnAdminApi(harness) {
  const phone = '15551110004';
  const jid = `whatsapp:${phone}`;
  harness.conversationState.set(jid, {
    kind: 'needs_review', senderJid: jid, senderPhone: phone,
    reason: `Postgres error: password=sdlf-super-secret-token-abcdefghijklmnop authentication failed`,
    timestamp: Date.now(),
  });
  await harness.storage.flush();
  const list = await (await fetch(`${harness.base}/api/needs-review`, { headers: { Cookie: harness.cookie } })).json();
  const item = list.items.find((entry) => entry.jid === jid);
  assert.ok(item, 'item must be present');
  assert.ok(!item.reason.includes('sdlf-super-secret-token-abcdefghijklmnop'), `the raw secret must not appear in the admin API response, got: ${item.reason}`);
  assert.ok(item.reason.includes('[REDACTED]'), 'a redaction marker must be present in place of the secret');
  // Clean up so this held sender does not affect any later scenario against the shared harness.
  await fetch(`${harness.base}/api/needs-review/${encodeURIComponent(jid)}/resolve`, {
    method: 'POST', headers: { Cookie: harness.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ heldMessagesAction: 'discard' }),
  });
}

// ---- R2 continued: unit-level flush-boundary tests (CONFIRMED 1 inverted) -

async function testR2SuccessRequiresFlushBeforeReportingDone() {
  const { Storage } = freshRequire('../dist/storage');
  const { conversationState } = freshRequire('../dist/conversationState');
  const { handleIncomingWhatsAppMessage } = freshRequire('../dist/messageFlow');
  const dir = tmpDir('sdlf-r2a-');
  const storage = new Storage(path.join(dir, 'storage.json'));
  const phone = '15552220001';
  const jid = `whatsapp:${phone}`;
  conversationState.set(jid, { kind: 'contact-card-confirmation', senderJid: jid, senderPhone: phone, followupMessages: [], decisionFlow: [], timestamp: Date.now() });

  let flushCalls = 0;
  const realFlush = storage.flush.bind(storage);
  storage.flush = async () => { flushCalls += 1; throw new Error('synthetic persistence unavailable'); };
  const transport = makeFakeTransport();
  await assert.rejects(
    handleIncomingWhatsAppMessage(makeIncoming(phone, 'confirmed'), storage, transport, 'webhook'),
    'a state-changing success whose flush fails must reject, not silently report success',
  );
  assert.ok(flushCalls >= 1, 'storage.flush must actually be called before a state-changing handler reports success (it must not be skippable)');
  storage.flush = realFlush;
}

async function testR2MarkNeedsReviewWaitsForBlockToCommit() {
  const { Storage } = freshRequire('../dist/storage');
  const { conversationState } = freshRequire('../dist/conversationState');
  const { handleIncomingWhatsAppMessage } = freshRequire('../dist/messageFlow');
  const dir = tmpDir('sdlf-r2b-');
  const storage = new Storage(path.join(dir, 'storage.json'));
  addDecisionCampaign(storage, 'R2 block-commit test', 'join-r2b');
  const phone = '15552220002';
  const jid = `whatsapp:${phone}`;
  const transport = makeFakeTransport();
  await handleIncomingWhatsAppMessage(makeIncoming(phone, 'join-r2b'), storage, transport, 'webhook');

  transport.failAlways = true;
  const realFlush = storage.flush.bind(storage);
  let flushCalls = 0;
  storage.flush = async () => { flushCalls += 1; throw new Error('synthetic block-persist failure'); };
  await assert.rejects(
    handleIncomingWhatsAppMessage(makeIncoming(phone, 'option-go', { isButtonReply: true }), storage, transport, 'webhook'),
    'when persisting the needs_review block itself fails, the call must still reject (not resolve as "fine because it is blocked in memory")',
  );
  assert.ok(flushCalls >= 1, 'markSenderNeedsReview must actually await storage.flush() for the block itself');
  storage.flush = realFlush;
}

// R5 (P1): the Meta inbound path never populates message.senderPhone. A
// needs_review block created from a Meta-shaped message must still be
// findable by phone, and must inherit the prior pending's campaign context.
// Inverts CONFIRMED 2 - this exercises the same handleMetaInboundForStorage
// shape (message.senderPhone populated by adminServer.ts from message.from,
// not present on the raw IncomingWhatsAppMessage object messageFlow.ts sees
// from other callers) by constructing the message the same way
// handleMetaInboundForStorage now does.
async function testR5PhoneAndCampaignPreservedForMetaShapedBlock() {
  const { Storage } = freshRequire('../dist/storage');
  const { conversationState } = freshRequire('../dist/conversationState');
  const { handleIncomingWhatsAppMessage } = freshRequire('../dist/messageFlow');
  const dir = tmpDir('sdlf-r5-');
  const storage = new Storage(path.join(dir, 'storage.json'));
  const phone = '15553330001';
  const jid = `whatsapp:${phone}`;
  conversationState.set(jid, {
    kind: 'handoff', senderJid: jid, senderPhone: phone,
    campaignId: 'synthetic-campaign-r5', campaignResultId: 'synthetic-result-r5', timestamp: Date.now(),
    // humanHandoffEnabled must be true so handleMessage's handoff branch
    // actually attempts a send (and can therefore fail) - otherwise
    // sendHumanHandoff no-ops and there is nothing to fail R5 against.
    humanHandoffEnabled: true, humanHandoffText: 'handoff notice',
  });

  // Meta-shaped: senderPhone IS populated (adminServer.ts's fix), but phone
  // resolution inside handleMessage fails - this is the scenario that must
  // now fall back to the message's own senderPhone/the prior pending's phone
  // instead of losing it.
  const failingTransport = {
    async resolvePhone() { throw new Error('synthetic resolution failure'); },
    async sendMessage() { throw new Error('synthetic handoff send failure'); },
  };
  await assert.rejects(handleIncomingWhatsAppMessage(
    { id: 'r5-msg-1', from: jid, senderPhone: phone, body: 'reply', hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'Test'; } },
    storage, failingTransport, 'webhook',
  ));
  const held = conversationState.get(jid);
  assert.equal(held.kind, 'needs_review');
  assert.equal(held.senderPhone, phone, 'senderPhone must be preserved on the needs_review block');
  assert.equal(held.campaignId, 'synthetic-campaign-r5', 'campaignId from the prior pending must be copied onto the needs_review block');
  assert.equal(held.campaignResultId, 'synthetic-result-r5', 'campaignResultId from the prior pending must be copied onto the needs_review block');
  assert.equal(conversationState.findByPhone(phone)?.kind, 'needs_review', 'findByPhone must be able to locate the block (used by localMetaPendingRoute for shared-number routing)');
}

// R3 (P1): a provider-confirmed interactive-buttons send whose persist fails
// afterwards must NOT trigger a text fallback (which would resend the same
// question). Inverts CONFIRMED 3.
async function testR3UncertainPersistDoesNotDuplicateSend() {
  const { Storage } = freshRequire('../dist/storage');
  const { conversationState } = freshRequire('../dist/conversationState');
  const { handleIncomingWhatsAppMessage } = freshRequire('../dist/messageFlow');
  const dir = tmpDir('sdlf-r3-');
  const storage = new Storage(path.join(dir, 'storage.json'));
  storage.addCampaign({
    name: 'R3 buttons test', triggerType: 1, triggerPhrase: 'join-r3', suffix: '', active: true,
    conversation: { askNameEnabled: false, replyText: '', followupMessages: [], decisionFlow: [
      { id: 'r3-question', kind: 'question', presentation: 'buttons', text: 'R3 question?', options: [{ id: 'r3-option', text: 'Yes' }], timeoutMinutes: 30 },
    ] },
  });
  const realFlush = storage.flush.bind(storage);
  let rejectNextFlush = false;
  storage.flush = async (...args) => {
    if (rejectNextFlush) { rejectNextFlush = false; throw new Error('synthetic sent-commit failure'); }
    return realFlush(...args);
  };
  const sends = [];
  const transport = {
    async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); },
    async sendInteractiveButtons(_to, text) { sends.push({ kind: 'buttons', text }); rejectNextFlush = true; return { messageId: 'r3-button-sent' }; },
    async sendMessage(_to, text) { sends.push({ kind: 'text', text }); return { messageId: 'r3-text-sent' }; },
  };
  const phone = '15554440001';
  await assert.rejects(
    handleIncomingWhatsAppMessage(makeIncoming(phone, 'join-r3'), storage, transport, 'webhook'),
    'an uncertain-persist outcome after a successful buttons send must propagate as a failure (classified needs_review), not report success',
  );
  assert.equal(sends.filter((s) => s.kind === 'buttons').length, 1, 'the buttons must have been sent exactly once');
  assert.equal(sends.filter((s) => s.kind === 'text' && s.text.includes('R3 question?')).length, 0, 'R3: the same question must NOT also be sent as a text fallback after an uncertain-persist buttons send');
  assert.equal(conversationState.get(`whatsapp:${phone}`)?.kind, 'needs_review', 'the sender must end up needs_review, not silently "handled"');
  storage.flush = realFlush;
}

// R4 (P1): a sender blocked pending review must not receive an automatically
// queued outbound send (a follow-up queued before the block, or a fresh
// campaign step attempted after). Uses the real outboxDispatcher module
// against a real Storage - inverts CONFIRMED 6.
async function testR4OutboxDispatcherSkipsHeldSenderKeepsOthersFlowing() {
  const { Storage } = freshRequire('../dist/storage');
  const { conversationState } = freshRequire('../dist/conversationState');
  const { startOutboxDispatcher } = freshRequire('../dist/outboxDispatcher');
  const dir = tmpDir('sdlf-r4a-');
  const storage = new Storage(path.join(dir, 'storage.json'));
  const heldPhone = '15555550001';
  const heldJid = `whatsapp:${heldPhone}`;
  const otherJid = 'whatsapp:15555550002';
  conversationState.set(heldJid, { kind: 'needs_review', senderJid: heldJid, senderPhone: heldPhone, reason: 'r4 test', timestamp: Date.now() });

  const heldMessage = storage.enqueueOutboxMessage({ kind: 'text', to: heldJid, text: 'should not be sent while blocked' });
  const otherMessage = storage.enqueueOutboxMessage({ kind: 'text', to: otherJid, text: 'should still be sent' });
  await storage.flush();

  const sent = [];
  const dispatcher = startOutboxDispatcher(storage, () => ({
    async sendMessage(to, text) { sent.push({ to, text }); return { messageId: 'r4-sent-' + sent.length }; },
  }), 60000);
  try {
    await waitFor(() => sent.some((m) => m.to === otherJid));
    // Give the dispatcher a couple more ticks to prove the held one still never goes out.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!sent.some((m) => m.to === heldJid), 'R4: a sender blocked pending review must never receive an automatic outbound send, even one queued before the block');
    const stillQueued = storage.getOutboxMessage(heldMessage.id);
    assert.ok(stillQueued && stillQueued.status !== 'sent' && stillQueued.status !== 'failed', 'the held message must remain queued/preserved, not lost and not marked failed just for being blocked');
    const otherSent = storage.getOutboxMessage(otherMessage.id);
    assert.equal(otherSent.status, 'sent', 'a different, non-blocked recipient must still be sent normally in the same batch');
  } finally {
    await dispatcher.stop();
  }
}

async function testR4ServiceBotFollowUpDispatcherSkipsHeldSender() {
  const { Storage } = freshRequire('../dist/storage');
  const { conversationState } = freshRequire('../dist/conversationState');
  const { startServiceBotFollowUpDispatcher } = freshRequire('../dist/serviceBotFollowUpDispatcher');
  const dir = tmpDir('sdlf-r4b-');
  const storage = new Storage(path.join(dir, 'storage.json'));
  const heldPhone = '15555550003';
  const heldJid = `whatsapp:${heldPhone}`;
  conversationState.set(heldJid, { kind: 'needs_review', senderJid: heldJid, senderPhone: heldPhone, reason: 'r4 followup test', timestamp: Date.now() });

  storage.scheduleServiceBotFollowUp({ botId: 'bot-1', phone: heldPhone, to: heldJid, nodeId: 'node-1', text: 'should not be sent while blocked', runAt: new Date(Date.now() - 1000).toISOString() });
  await storage.flush();

  let delivered = 0;
  const dispatcher = startServiceBotFollowUpDispatcher(storage, () => ({ async sendMessage() { delivered += 1; return { messageId: 'r4b-sent' }; } }), 100);
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(delivered, 0, 'R4: a service-bot follow-up for a blocked sender must not be delivered automatically');
    const due = storage.getDueServiceBotFollowUps();
    assert.ok(due.some((item) => item.to === heldJid), 'the follow-up must remain scheduled/preserved, not lost');
  } finally {
    await dispatcher.stop();
  }
}

// ---- R2 continued: real PostgreSQL delayed/failed COMMIT + restart -------
// Unlike the HTTP-level testR2ResolveRequiresRealCommit (which proves the
// endpoint code path reacts correctly to a flush() outcome via a stub), these
// exercise conversationState + Storage against a REAL PostgreSQL instance -
// the actual commit-then-publish contract the independent review required
// ("PostgreSQL אמיתי לעיכוב/כשל commit, כולל restart").

async function setUpPostgresConversationState(harness, label) {
  const { createPostgresBackend, migrateDatabase } = freshRequire('../dist/database');
  const { Storage, emptyStorageData } = freshRequire('../dist/storage');
  const { conversationState } = freshRequire('../dist/conversationState');
  await migrateDatabase(harness.databaseUrl);
  await harness.pool.query('delete from conversation_state');
  const backend = await createPostgresBackend(harness.databaseUrl);
  const storage = new Storage(`unused-${label}.json`, { initialData: emptyStorageData(), backend });
  await storage.flush();
  const dir = tmpDir(`sdlf-${label}-`);
  conversationState.configurePersistence(path.join(dir, 'conversation-state.json'), storage);
  conversationState.restore(() => undefined);
  return { storage, backend, conversationState };
}

async function testR2PostgresDelayedCommit(harness) {
  const { storage, backend, conversationState } = await setUpPostgresConversationState(harness, 'r2-delay');
  const jid = 'whatsapp:15556660001';
  // createPostgresBackend() opens its OWN new pg.Pool from the connection
  // string (not harness.pool), and its writes go through a checked-out
  // PoolClient (pool.connect() -> client.query(...) inside begin/commit), not
  // pool.query() directly - so the delay must be injected at Client.prototype
  // level. This affects every pg Client in this process, including the
  // backend's, which is exactly what proves storage.flush() waits for the
  // REAL (delayed) commit rather than some other write path.
  const { Client } = require('pg');
  const originalQuery = Client.prototype.query;
  const DELAY_MS = 700;
  Client.prototype.query = async function patchedQuery(...args) {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (text && text.includes('conversation_state')) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    return originalQuery.apply(this, args);
  };
  try {
    conversationState.set(jid, { kind: 'needs_review', senderJid: jid, senderPhone: '15556660001', reason: 'r2 postgres delay test', timestamp: Date.now() });
    const started = Date.now();
    await storage.flush();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= DELAY_MS - 100, `flush() must genuinely wait for the delayed COMMIT to finish (elapsed=${elapsed}ms, expected >= ~${DELAY_MS}ms)`);
  } finally {
    Client.prototype.query = originalQuery;
  }
  const row = await harness.pool.query('select kind from conversation_state where jid = $1', [jid]);
  assert.equal(row.rows[0]?.kind, 'needs_review', 'after the delayed commit actually finishes, the block must be durably in PostgreSQL');
  await backend.close();
}

async function testR2PostgresFailedCommit(harness) {
  const { storage, backend, conversationState } = await setUpPostgresConversationState(harness, 'r2-fail');
  const jid = 'whatsapp:SDLF_R2_FAIL';
  await harness.pool.query("alter table conversation_state add constraint tmp_sdlf_r2_fail check (jid <> 'whatsapp:SDLF_R2_FAIL')");
  try {
    conversationState.set(jid, { kind: 'needs_review', senderJid: jid, senderPhone: 'SDLF_R2_FAIL', reason: 'r2 postgres failed-commit test', timestamp: Date.now() });
    await assert.rejects(storage.flush(), 'flush() must reject when the real COMMIT genuinely fails');
    const row = await harness.pool.query('select 1 from conversation_state where jid = $1', [jid]);
    assert.equal(row.rowCount, 0, 'a failed commit must not have landed in PostgreSQL');
    // The in-memory conversationState still shows the block (this is exactly
    // why markSenderNeedsReview/the resolve endpoint must treat a flush()
    // failure as "not actually safe yet", per R2 - the in-memory state alone
    // is not proof of durability).
    assert.equal(conversationState.get(jid)?.kind, 'needs_review');
  } finally {
    await harness.pool.query('alter table conversation_state drop constraint tmp_sdlf_r2_fail');
  }
  // Once the constraint is gone, the queued write must still land (same
  // dirty-state-survival contract as section 02, applied to conversation_state).
  const deadline = Date.now() + 10000;
  let ok = false;
  while (Date.now() < deadline) {
    try { await storage.flush(); ok = true; break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  assert.ok(ok, 'the block must eventually commit once the constraint is gone, via the existing backoff retry');
  const row = await harness.pool.query('select kind from conversation_state where jid = $1', [jid]);
  assert.equal(row.rows[0]?.kind, 'needs_review');
  await backend.close();
}

async function testR2PostgresRestartSurvivesBlock(harness) {
  const { storage, backend, conversationState } = await setUpPostgresConversationState(harness, 'r2-restart');
  const jid = 'whatsapp:15556660003';
  conversationState.set(jid, { kind: 'needs_review', senderJid: jid, senderPhone: '15556660003', campaignId: 'restart-campaign', reason: 'r2 postgres restart test', timestamp: Date.now() });
  await storage.flush();
  await backend.close();

  // Simulate a restart: fresh backend/connection reading the same database.
  const { loadStorageSnapshot } = freshRequire('../dist/database');
  const reloaded = await loadStorageSnapshot(harness.databaseUrl);
  const restoredState = reloaded.conversationStateSnapshot?.conversations?.[jid];
  assert.ok(restoredState, 'the needs_review block must survive a restart when read straight from PostgreSQL');
  assert.equal(restoredState.kind, 'needs_review');
  assert.equal(restoredState.campaignId, 'restart-campaign', 'campaign context must also survive the restart');
}

// ---- small completion 1: backoff off-by-one (exact delay sequence) --------

async function testBackoffFirstRetryUses500msNotSkippedTo1000ms(harness) {
  const { createPostgresBackend, migrateDatabase } = freshRequire('../dist/database');
  const { Storage, emptyStorageData } = freshRequire('../dist/storage');
  await migrateDatabase(harness.databaseUrl);
  await clearOutbox(harness.pool);
  const backend = await createPostgresBackend(harness.databaseUrl);
  const storage = new Storage('unused-sdlf-backoff.json', { initialData: emptyStorageData(), backend });
  await storage.flush();

  const attemptTimestamps = [];
  const originalError = console.error;
  console.error = (...args) => {
    if (String(args[0] || '').includes('PostgreSQL storage write failed')) attemptTimestamps.push(Date.now());
  };
  await harness.pool.query("alter table outbox_messages add constraint tmp_sdlf_backoff check (recipient <> 'whatsapp:SDLF_BACKOFF')");
  try {
    storage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:SDLF_BACKOFF', text: 'doomed' });
    await assert.rejects(storage.flush()); // first failure -> consecutiveFailures becomes 1, schedules retry
    // Wait for the second attempt (the scheduled retry) to actually fire.
    await waitFor(() => attemptTimestamps.length >= 2, { timeoutMs: 5000, intervalMs: 25 });
    const gapMs = attemptTimestamps[1] - attemptTimestamps[0];
    // The documented first tier is 500ms. Before the off-by-one fix this gap
    // was ~1000ms (delays[1]) because consecutiveFailures was indexed AFTER
    // being incremented. Generous tolerance for CI/local timer jitter, but
    // tight enough to fail against the old 1000ms behavior.
    assert.ok(gapMs >= 350 && gapMs < 800, `first retry delay must be ~500ms (documented tier), got ${gapMs}ms - the off-by-one bug produced ~1000ms`);
  } finally {
    console.error = originalError;
    await harness.pool.query('alter table outbox_messages drop constraint tmp_sdlf_backoff');
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { await storage.flush(); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  await backend.close();
}

// ---- small completion 2: ownerStorage registry validation -----------------

async function testOwnerStorageRejectsWrongTypedOwnerAccessToken() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-owner-badtoken-');
  const main = path.join(dir, 'clients.json');
  writeJson(main, [validClient('a', { ownerAccessToken: 12345 })]); // wrong type, not missing
  assert.throws(() => new OwnerStorage(main), /could not be parsed/, 'a present-but-wrong-typed ownerAccessToken must invalidate the record, not silently pass through');
}

async function testOwnerStorageRejectsEmptyOwnerAccessToken() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-owner-emptytoken-');
  const main = path.join(dir, 'clients.json');
  writeJson(main, [validClient('a', { ownerAccessToken: '' })]);
  assert.throws(() => new OwnerStorage(main), /could not be parsed/, 'an empty-string ownerAccessToken must invalidate the record');
}

async function testOwnerStorageMigratesMissingTokenOncePersisted() {
  const { OwnerStorage } = freshRequire('../dist/ownerStorage');
  const dir = tmpDir('sdlf-owner-migrate-');
  const main = path.join(dir, 'clients.json');
  const record = { id: 'legacy-1', name: 'Legacy client', accessCode: 'legacy-code', createdAt: new Date().toISOString() };
  // No ownerAccessToken key at all - legitimate old-format record.
  writeJson(main, [record]);

  const store = new OwnerStorage(main);
  const firstToken = store.getClient('legacy-1').ownerAccessToken;
  assert.ok(firstToken, 'a legacy record with no ownerAccessToken must get one generated');

  // The migration must have been PERSISTED immediately, not left in-memory
  // only - re-loading from disk (a fresh OwnerStorage instance, i.e. a
  // simulated restart) must see the SAME token, not a newly re-rolled one.
  const onDisk = JSON.parse(fs.readFileSync(main, 'utf-8'));
  assert.equal(onDisk.find((c) => c.id === 'legacy-1').ownerAccessToken, firstToken, 'the generated token must have been written to disk, not only kept in memory');

  const { OwnerStorage: ReloadedOwnerStorage } = freshRequire('../dist/ownerStorage');
  const reopened = new ReloadedOwnerStorage(main);
  const secondToken = reopened.getClient('legacy-1').ownerAccessToken;
  assert.equal(secondToken, firstToken, 'a restart must not silently re-roll a different ownerAccessToken for the same legacy record');
}

// ===========================================================================
// main
// ===========================================================================

(async () => {
  await record('01 - parallel calls to same messageId share the real outcome', test01ParallelCallsShareRealOutcome);
  await record('01 - duplicate after success is a no-op', test01DuplicateAfterSuccessIsNoop);
  await record('01/R1 - failure propagates, blocks sender, held messages recorded, other senders unaffected', test01FailurePropagatesAndBlocksSender);
  await record('01 - restart persists the needs_review block', test01RestartPersistsTheBlock);
  await record('01 - MUTATION: revert swallow breaks the failure-propagation test', test01Mutation);

  // ---- R1-R6 (docs/silent-data-loss-independent-review-2026-09-05.md) ----
  // Unit-level (real dist/ modules, real Storage/conversationState, no HTTP):
  await record('R2 - a state-changing success must await storage.flush() before reporting done', testR2SuccessRequiresFlushBeforeReportingDone);
  await record('R2 - markSenderNeedsReview must await the block\'s own flush and reject if it fails', testR2MarkNeedsReviewWaitsForBlockToCommit);
  await record('R3 - uncertain-persist after a successful buttons send must not duplicate-send as text', testR3UncertainPersistDoesNotDuplicateSend);
  await record('R4 - outboxDispatcher skips a held sender, keeps sending to others', testR4OutboxDispatcherSkipsHeldSenderKeepsOthersFlowing);
  await record('R4 - serviceBotFollowUpDispatcher skips a held sender', testR4ServiceBotFollowUpDispatcherSkipsHeldSender);
  await record('R5 - senderPhone and campaign context preserved on a Meta-shaped needs_review block', testR5PhoneAndCampaignPreservedForMetaShapedBlock);
  await record('11 - ownerStorage rejects a present-but-wrong-typed ownerAccessToken', testOwnerStorageRejectsWrongTypedOwnerAccessToken);
  await record('11 - ownerStorage rejects an empty ownerAccessToken', testOwnerStorageRejectsEmptyOwnerAccessToken);
  await record('11 - ownerStorage migrates a legacy missing ownerAccessToken once, persisted (not re-rolled on restart)', testOwnerStorageMigratesMissingTokenOncePersisted);

  // Connected-worker level (real HTTP against a real startAdminServer, real
  // Inbox drainer, real conversationState - one shared harness/install):
  let httpHarness;
  try {
    httpHarness = await getHttpTestHarness();
  } catch (err) {
    console.error('Could not start the HTTP test harness:', err);
  }
  if (!httpHarness) {
    skip('R1 - real connected Inbox worker holds a blocked sender\'s reply, never completes it', 'HTTP test harness failed to start');
    skip('R2 - resolve endpoint requires a real commit before reporting unblocked', 'HTTP test harness failed to start');
    skip('R6 - dashboard API requires an explicit heldMessagesAction and exposes held messages', 'HTTP test harness failed to start');
    skip('11 - a credential-shaped reason is redacted before reaching the admin API', 'HTTP test harness failed to start');
  } else {
    await record('R1 - real connected Inbox worker holds a blocked sender\'s reply, never completes it', () => testR1RealHttpInboxHoldsBlockedReplyNotCompleted(httpHarness));
    await record('R2 - resolve endpoint requires a real commit before reporting unblocked', () => testR2ResolveRequiresRealCommit(httpHarness));
    await record('R6 - dashboard API requires an explicit heldMessagesAction and exposes held messages', () => testR6DashboardApiRequiresExplicitChoiceAndExposesHeldMessages(httpHarness));
    await record('11 - a credential-shaped reason is redacted before reaching the admin API', () => testSecretRedactionOnAdminApi(httpHarness));
    await closeHttpTestHarness(httpHarness);
  }

  await record('R1 - a SECOND message from an already-held sender is itself claimable and held, not stuck queued forever', testR1SecondMessageForHeldSenderIsClaimable);
  await record('R1 - MUTATION: excluding held from group-blocking breaks the second-message test', testR1SecondMessageMutation);

  await record('03 - enqueue rolls back in-memory push on persist failure', test03EnqueueRollsBackOnPersistFailure);
  await record('03 - claimBatch rolls back status changes on persist failure', test03ClaimBatchRollsBackOnPersistFailure);
  await record('03 - update (markCompleted/markRetry/markFailed) rolls back on persist failure', test03UpdateRollsBackOnPersistFailure);
  await record('03 - pruneCompleted history not lost on a failed enqueue', test03PruneHistoryNotLostOnEnqueueFailure);
  await record('03 - restart preserves the last actually-committed state', test03RestartPreservesLastCommittedState);
  await record('03 - MUTATION: removing rollback breaks the enqueue-rollback test', test03Mutation);

  await record('11 - fresh install (no main, no .bak) -> []', test11FreshInstall);
  await record('11 - main missing, .bak valid -> recovers', test11MainMissingBackupValid);
  await record('11 - main missing, .bak corrupt -> throws', test11MainMissingBackupCorrupt);
  await record('11 - main corrupt, no .bak -> throws', test11MainCorruptNoBackup);
  await record('11 - main corrupt, .bak valid -> recovers, corrupt file kept for diagnosis', test11MainCorruptBackupValid);
  await record('11 - main valid [] is legitimate, not replaced by older .bak', test11MainEmptyArrayIsLegitimate);
  await record('11 - structurally-valid-but-invalid records ([null], missing id, duplicate id) -> throws', test11StructurallyValidButInvalidRecords);
  await record('11 - rename failure during a later write does not touch a valid .bak', test11RenameFailureDuringRepairDoesNotTouchValidBackup);
  await record('11 - a corrupt on-disk main is never copied over a good .bak', test11CorruptMainNeverCopiedOverGoodBackup);
  await record('11 - addClient/updateClient/deleteClient roll back on persist failure', test11AddUpdateDeleteRollback);
  await record('11 - MUTATION: reinstating catch{return []} breaks the corrupt-no-backup test', test11Mutation);

  const harness = await getPgTestHarness();
  if (!harness) {
    skip('02 - dirty state survives a failed batch, unrelated write not lost', 'TEST_DATABASE_URL not set or not reachable - see results doc for what this leaves unverified');
    skip('02 - backoff bounds retry attempts under sustained traffic (no busy loop)', 'no local Postgres test database reachable');
    skip('02 - close() during backoff fails within budget, not a hang', 'no local Postgres test database reachable');
    skip('02 - MUTATION: dropping the dirty-merge breaks the dirty-state test', 'no local Postgres test database reachable');
    skip('backoff off-by-one - first retry uses the documented 500ms tier, not 1000ms', 'no local Postgres test database reachable');
    skip('R2 - Postgres: resolve endpoint survives a delayed COMMIT', 'no local Postgres test database reachable');
    skip('R2 - Postgres: resolve endpoint fails cleanly on a failed COMMIT and keeps the block', 'no local Postgres test database reachable');
    skip('R2 - Postgres: the block survives a simulated process restart', 'no local Postgres test database reachable');
  } else {
    await record('02 - dirty state survives a failed batch, unrelated write not lost', () => test02DirtyStateSurvivesFailure(harness));
    await record('02 - backoff bounds retry attempts under sustained traffic (no busy loop)', () => test02BackoffIsBoundedNotBusyLoop(harness));
    await record('02 - close() during backoff fails within budget, not a hang', () => test02CloseDuringBackoffFailsWithinBudget(harness));
    await record('02 - MUTATION: dropping the dirty-merge breaks the dirty-state test', () => test02Mutation(harness));
    await record('backoff off-by-one - first retry uses the documented 500ms tier, not 1000ms', () => testBackoffFirstRetryUses500msNotSkippedTo1000ms(harness));
    await record('R2 - Postgres: resolve endpoint survives a delayed COMMIT', () => testR2PostgresDelayedCommit(harness));
    await record('R2 - Postgres: resolve endpoint fails cleanly on a failed COMMIT and keeps the block', () => testR2PostgresFailedCommit(harness));
    await record('R2 - Postgres: the block survives a simulated process restart', () => testR2PostgresRestartSurvivesBlock(harness));
    await harness.pool.end().catch(() => {});
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length} passed, ${skipped.length} skipped, ${failed.length} failed.`);
  if (failed.length) {
    console.error('\nFailed:');
    for (const f of failed) console.error(` - ${f.name}`);
    // Explicit exit (not relying on natural event-loop drain): startAdminServer
    // creates several setInterval timers (routes-cache refresh, Meta inbox
    // drain x2) with no stop handle exposed, and this suite creates one such
    // server. The prior round's suite left a live Node process after a
    // successful run for exactly this reason. Matches the same technique
    // scripts/audit-silent-loss-review-gaps.js already uses.
    process.exit(1);
  }
  console.log('\nSilent-data-loss-fix acceptance tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error('Fatal error running the suite:', err);
  process.exit(1);
});
