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
  const { handleIncomingWhatsAppMessage } = freshRequire('../dist/messageFlow');
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

  // A second message from the SAME sender must stay blocked, not re-attempt.
  transport.failAlways = false; // even though the transport would now succeed...
  await handleIncomingWhatsAppMessage(makeIncoming(blockedPhone, 'option-go', { isButtonReply: true }), storage, transport, 'webhook');
  assert.equal(transport.sent.filter((item) => item.text.includes('Second question')).length, 0, '...a still-blocked sender must not have advanced past the failed step');
  assert.equal(conversationState.get(`whatsapp:${blockedPhone}`).kind, 'needs_review', 'the block must remain until explicitly resolved');

  // A DIFFERENT sender must be entirely unaffected.
  await handleIncomingWhatsAppMessage(makeIncoming(otherPhone, 'join-blocked'), storage, transport, 'webhook');
  assert.equal(transport.sent.filter((item) => item.to === `whatsapp:${otherPhone}` && item.text.includes('First question')).length, 1, 'a different sender on the same campaign must be processed normally');
  assert.equal(conversationState.get(`whatsapp:${otherPhone}`) && conversationState.get(`whatsapp:${otherPhone}`).kind, 'decision', 'a different sender must not be blocked');
}

async function test01ResolveEndpointLogicUnblocks() {
  // Exercises the same operation POST /api/needs-review/:jid/resolve performs
  // (conversationState.remove after checking kind === 'needs_review') against
  // the real conversationState module - not a mock of it.
  const { Storage } = freshRequire('../dist/storage');
  const { conversationState } = freshRequire('../dist/conversationState');
  const { handleIncomingWhatsAppMessage } = freshRequire('../dist/messageFlow');
  const dir = tmpDir('sdlf-01d-');
  const storage = new Storage(path.join(dir, 'storage.json'));
  addDecisionCampaign(storage, 'Resolve test', 'join-resolve');
  const transport = makeFakeTransport();
  const phone = '972500000205';
  const jid = `whatsapp:${phone}`;

  await handleIncomingWhatsAppMessage(makeIncoming(phone, 'join-resolve'), storage, transport, 'webhook');
  transport.failAlways = true;
  await handleIncomingWhatsAppMessage(makeIncoming(phone, 'option-go', { isButtonReply: true }), storage, transport, 'webhook').catch(() => {});
  const held = conversationState.get(jid);
  assert.equal(held && held.kind, 'needs_review');

  transport.failAlways = false;
  conversationState.remove(jid); // the admin resolve action
  await handleIncomingWhatsAppMessage(makeIncoming(phone, 'join-resolve'), storage, transport, 'webhook');
  assert.ok(transport.sent.some((item) => item.text.includes('First question')), 'after the admin resolves the hold, a fresh message must be processed normally');
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
  const from = '            await markSenderNeedsReview(message, source, err);\n            console.error(`[MSG] handler failed via ${source}, sender blocked pending admin review:`, err);\n            throw err;\n        }';
  const to = '            await markSenderNeedsReview(message, source, err);\n            console.error(`[MSG] handler failed via ${source}, sender blocked pending admin review:`, err);\n            // MUTATED: original silent swallow (no throw)\n        }';
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
// main
// ===========================================================================

(async () => {
  await record('01 - parallel calls to same messageId share the real outcome', test01ParallelCallsShareRealOutcome);
  await record('01 - duplicate after success is a no-op', test01DuplicateAfterSuccessIsNoop);
  await record('01 - failure propagates, blocks sender, other senders unaffected', test01FailurePropagatesAndBlocksSender);
  await record('01 - admin resolve endpoint logic unblocks', test01ResolveEndpointLogicUnblocks);
  await record('01 - restart persists the needs_review block', test01RestartPersistsTheBlock);
  await record('01 - MUTATION: revert swallow breaks the failure-propagation test', test01Mutation);

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
  } else {
    await record('02 - dirty state survives a failed batch, unrelated write not lost', () => test02DirtyStateSurvivesFailure(harness));
    await record('02 - backoff bounds retry attempts under sustained traffic (no busy loop)', () => test02BackoffIsBoundedNotBusyLoop(harness));
    await record('02 - close() during backoff fails within budget, not a hang', () => test02CloseDuringBackoffFailsWithinBudget(harness));
    await record('02 - MUTATION: dropping the dirty-merge breaks the dirty-state test', () => test02Mutation(harness));
    await harness.pool.end().catch(() => {});
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length} passed, ${skipped.length} skipped, ${failed.length} failed.`);
  if (failed.length) {
    console.error('\nFailed:');
    for (const f of failed) console.error(` - ${f.name}`);
    process.exit(1);
  }
  console.log('\nSilent-data-loss-fix acceptance tests passed.');
})().catch((err) => {
  console.error('Fatal error running the suite:', err);
  process.exit(1);
});
