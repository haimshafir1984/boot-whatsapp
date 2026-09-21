#!/usr/bin/env node
/**
 * Mandatory mutation checks for stage B (doc section 8.3, items 1 and 2).
 *
 * Each mutation edits a built file in dist/ in place (never src/), runs the tests that are
 * supposed to catch it, and ALWAYS restores the file byte-for-byte, verifying by SHA-256.
 * A mutation "survives" (i.e. the test suite is inadequate) when every listed test still passes.
 *
 *   node scripts/mutation-stage-b.js <out.json>          (needs TEST_DATABASE_URL for the PG test)
 * Run only when nothing else uses dist/ (sequential, never during the regression/load runs).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const MUTATIONS = [
  {
    id: 'M1a',
    protection: '6.1 filter before LIMIT (predicate removed entirely)',
    file: 'dist/storage.js',
    find: /\n\s*\.filter\(\(message\) => !isBlocked \|\| !isBlocked\(message\.to\)\)/,
    replace: '',
    tests: ['test-outbox-fairness.js'],
  },
  {
    id: 'M1b',
    protection: '6.1 filter before LIMIT (HEAD ordering: LIMIT first, filter afterwards)',
    file: 'dist/storage.js',
    find: /\.filter\(\(message\) => !isBlocked \|\| !isBlocked\(message\.to\)\)\s*\.slice\(0, limit\)/,
    replace: '.slice(0, limit).filter((message) => !isBlocked || !isBlocked(message.to))',
    tests: ['test-outbox-fairness.js'],
  },
  {
    id: 'M2a',
    protection: '6.3 uncertain classification removed everywhere (uniform retry)',
    file: 'dist/sendOutcome.js',
    find: /function classifySendError\(err\) \{/,
    replace: "function classifySendError(err) { return { outcome: 'rejected_transient', classified: false }; }\nfunction __unusedClassifySendError(err) {",
    tests: ['test-outbox-classification.js', 'test-meta-timeouts.js', 'test-outbox-uncertain-postgres.js'],
  },
  {
    id: 'M2b',
    protection: '6.3 dispatcher-only: uncertain branch removed (falls to retry)',
    file: 'dist/outboxDispatcher.js',
    find: /if \(outcome\.outcome === 'uncertain'\) \{/,
    replace: "if (false) {",
    tests: ['test-outbox-classification.js', 'test-meta-timeouts.js', 'test-outbox-uncertain-postgres.js'],
  },
  {
    id: 'M2c',
    protection: '6.3 crash recovery: orphaned processing row is re-claimable again (HEAD stale-reclaim behaviour)',
    file: 'dist/storage.js',
    find: /recoverOrphanedOutboxProcessing\(\) \{/,
    replace: 'recoverOrphanedOutboxProcessing() { return [];',
    tests: ['test-outbox-classification.js', 'test-outbox-uncertain-postgres.js'],
  },
];

// Stage B2, step 1 (select with MUT_SET=b2): attempt identity protections.
const MUTATIONS_B2 = [
  {
    id: 'B2-1', protection: 'provider stops sending biz_opaque_callback_data',
    file: 'dist/providers/MetaCloudProvider.js',
    find: /const attempt = typeof originalPayload\.to === 'string' \? \(0, sendAttempt_1\.currentSendAttempt\)\(\) : undefined;/,
    replace: 'const attempt = undefined;',
    tests: ['test-outbox-attempt-id.js'],
  },
  {
    id: 'B2-2', protection: 'claim is not flushed before the provider call (dispatcher)',
    file: 'dist/outboxDispatcher.js',
    find: /if \(!claimed\)\s*return;\s*await storage\.flush\(\);/,
    replace: 'if (!claimed) return;',
    tests: ['test-outbox-attempt-id.js', 'test-outbox-attempts-postgres.js'],
  },
  {
    id: 'B2-3', protection: 'a retry reuses the previous attemptId instead of a new one',
    file: 'dist/storage.js',
    find: /const attemptId = \(0, sendAttempt_1\.newAttemptId\)\(\);/,
    replace: 'const attemptId = message.attemptId ?? (0, sendAttempt_1.newAttemptId)();',
    tests: ['test-outbox-attempt-id.js', 'test-outbox-attempts-postgres.js'],
  },
];

// Stage B2, step 2 (MUT_SET=b2s2): durable forwarding / exact matching / durable ack / service-bot routing.
const MUTATIONS_B2S2 = [
  { id: 'S2-1', protection: 'gateway stops persisting statuses (fire-and-forget again)', file: 'dist/adminServer.js',
    find: /enqueueMetaStatusForward\(statusPayload\);/, replace: '/* mutated: no enqueue */', tests: ['test-meta-status-forwarding.js'] },
  { id: 'S2-2', protection: 'recipient mismatch check removed (a tagged status for another recipient is applied)', file: 'dist/storage.js',
    find: /if \(input\.recipientId && !sameRecipient\(input\.recipientId, message\.to\)\)/, replace: 'if (false)', tests: ['test-meta-status-forwarding.js', 'test-meta-status-postgres.js'] },
  { id: 'S2-3', protection: 'early statuses are thrown away (buffer never re-applied)', file: 'dist/storage.js',
    find: /this\.drainBufferedStatuses\(providerMessageId\);/, replace: ';', tests: ['test-meta-status-forwarding.js'] },
  { id: 'S2-4', protection: 'client acknowledges a status before it is durable', file: 'dist/adminServer.js',
    find: /if \(statusChanged\)\s*await storage\.flush\(\);/, replace: '', tests: ['test-meta-status-forwarding.js'] },
  { id: 'S2-5', protection: 'service bot bypasses the outbox again (message entry point)', file: 'dist/serviceBot.js',
    find: /transport = \(0, messageFlow_1\.createOutboxTrackedTransport\)\(storage, transport\);/, replace: '/* mutated */', tests: ['test-service-bot-outbox.js'] },
];

// Stage B2, step 3 (MUT_SET=b2s3): delivery recovery protections.
const MUTATIONS_B2S3 = [
  { id: 'R1', protection: 'no window: the retry is granted immediately', file: 'dist/storage.js',
    find: /if \(Number\.isFinite\(endsAt\) && endsAt > now\.getTime\(\)\)\s*continue;/, replace: '', tests: ['test-delivery-recovery.js'] },
  { id: 'R2', protection: 'no budget: retries are granted without limit', file: 'dist/storage.js',
    find: /if \(possiblyDelivered < \(0, exports\.recoveryPostBudget\)\(\)\)/, replace: 'if (true)', tests: ['test-delivery-recovery.js', 'test-delivery-recovery-postgres.js'] },
  { id: 'R3', protection: 'delivery evidence is ignored (never resolves an uncertain message)', file: 'dist/storage.js',
    find: /this\.applyDeliveryEvidence\(message, attempt, wamid, input\.status\)/, replace: 'false', tests: ['test-delivery-recovery.js'] },
  { id: 'R4', protection: 'ANY needs_review hold is released by a resolution (not only the one tied to that message)', file: 'dist/deliveryRecovery.js',
    find: /const ownHold = hold\?\.recovery\?\.outboxId === id \? hold : undefined;/, replace: 'const ownHold = hold;', tests: ['test-delivery-recovery.js'] },
  { id: 'R5', protection: 'replay does not skip already delivered sends', file: 'dist/messageFlow.js',
    find: /if \(prior\?\.status === 'sent'\)/, replace: 'if (false)', tests: ['test-delivery-recovery.js'] },
  { id: 'R6', protection: 'a resolution revives a run the participant already left', file: 'dist/deliveryRecovery.js',
    find: /const eligible = row\.status === 'sent' && transport && participantStillInThisRun\(row, Boolean\(ownHold\)\) && isLatestResultForSender\(storage, row\);/, replace: "const eligible = row.status === 'sent' && transport;", tests: ['test-delivery-recovery.js'] },
  { id: 'R7', protection: 'a restart resets the recovery window', file: 'dist/storage.js',
    find: /if \(!message\.recovery \|\| message\.recovery\.attemptId !== message\.attemptId\) \{/, replace: 'if (true) {', tests: ['test-delivery-recovery.js'] },
  { id: 'R8', protection: 'the recovery hold blocks the message own retry', file: 'dist/outboxDispatcher.js',
    find: /return hold\.recovery\?\.outboxId !== message\.id;/, replace: 'return true;', tests: ['test-delivery-recovery.js'] },
];

// Stage 3 follow-up (MUT_SET=b2s3b): the four paths (answer, wait_reply, service bot, timers) inside delivery recovery.
const MUTATIONS_B2S3B = [
  { id: 'T1', protection: 'timer: an uncertain send no longer holds the participant (only logged)', file: 'dist/messageFlow.js',
    find: /if \(holdSenderForUncertainFailure\(senderJid, senderPhone, err\)\) \{\s*console\.warn\(`\[TIMER_DELIVERY_HELD\]/, replace: 'if (false) { console.warn(`[TIMER_DELIVERY_HELD]', tests: ['test-delivery-recovery-paths.js'] },
  { id: 'T2', protection: 'inactivity timeout is not a flow unit (no continuation)', file: 'dist/messageFlow.js',
    find: /await \(0, flowUnit_1\.runFlowUnit\)\(\{ kind: 'decision_timeout', campaignId, campaignResultId, senderJid, senderPhone, stepId: step\.id, timeout: \{ source: 'decision'.*?\}, \(\) => sendDecisionTimeoutAction\(([^;]*?)\)\);/, replace: 'await sendDecisionTimeoutAction($1);', tests: ['test-delivery-recovery-paths.js'] },
  { id: 'T3', protection: 'follow-up dispatcher retries an uncertain follow-up instead of holding', file: 'dist/serviceBotFollowUpDispatcher.js',
    find: /if \(\(0, messageFlow_1\.holdSenderForUncertainFailure\)\(claimed\.to, claimed\.phone, err\)\) \{/, replace: 'if (false) {', tests: ['test-delivery-recovery-paths.js'] },
  { id: 'T4', protection: 'service bot replay does not restore the session before replaying', file: 'dist/serviceBot.js',
    find: /if \(sb\.sessionBefore\)\s*storage\.saveServiceBotSession\(/, replace: 'if (false) storage.saveServiceBotSession(', tests: ['test-delivery-recovery-paths.js'] },
  { id: 'T5', protection: 'replay of a button answer is swallowed by the duplicate-reply guard', file: 'dist/messageFlow.js',
    find: /if \(!\(0, flowUnit_1\.currentFlowUnit\)\(\)\?\.replayOf && \(isRecentDecisionReply/, replace: 'if ((isRecentDecisionReply', tests: ['test-delivery-recovery-paths.js'] },
  { id: 'T6', protection: 'replay of the reply chain re-creates the contact-save job (double side effect)', file: 'dist/messageFlow.js',
    find: /if \(!\(0, flowUnit_1\.currentFlowUnit\)\(\)\?\.replayOf\) \{\s*storage\.markCampaignResultStage\(campaignResultId, 'contact_queueing'/, replace: "if (true) {\n        storage.markCampaignResultStage(campaignResultId, 'contact_queueing'", tests: ['test-delivery-recovery-paths.js', 'test-delivery-recovery.js'] },
];

// Stage 3 follow-up + stages 4/5 (MUT_SET=b2s45): Baileys held-message replay, participant-started recovery, retry membership, provider ids.
const T45 = ['test-delivery-recovery-paths.js', 'test-delivery-recovery-s45.js'];
const MUTATIONS_B2S45 = [
  { id: 'H1', protection: 'a replayed held message is swallowed by the handled-id dedupe', file: 'dist/messageFlow.js',
    find: /handledMessageIds\.delete\(messageKey\(incoming\)\);/, replace: '', tests: T45 },
  { id: 'H2', protection: 'held Baileys messages are recorded without a replay snapshot', file: 'dist/messageFlow.js',
    find: /\.\.\.\(source === 'baileys' \? \{ replay: await heldReplaySnapshot\(message\) \} : \{\}\),/, replace: '', tests: T45 },
  { id: 'H3', protection: 'the controller does not replay held Baileys messages after the release', file: 'dist/deliveryRecovery.js',
    find: /if \(toReplay\.length && transport\)/, replace: 'if (false)', tests: T45 },
  { id: 'H4', protection: 'a held message without replay data is dropped without a trace', file: 'dist/messageFlow.js',
    find: /console\.error\(`\[HELD_MESSAGE_NOT_REPLAYABLE\][^\n]*\n/, replace: '', tests: T45 },
  { id: 'S1', protection: 'a fresh trigger no longer supersedes a recovery hold', file: 'dist/messageFlow.js',
    find: /pending\.recovery && await supersedeRecoveryHoldForFreshTrigger/, replace: 'false && await supersedeRecoveryHoldForFreshTrigger', tests: T45 },
  { id: 'S2', protection: 'ANY message (not only a fresh exact trigger) supersedes a recovery hold', file: 'dist/messageFlow.js',
    find: /if \(message\.isReaction \|\| !\(0, triggerDetector_1\.detectTrigger\)\(message\.body \|\| '', storage\.getActiveCampaigns\(\)\)\.matched\)\s*return false;/, replace: 'if (message.isReaction) return false;', tests: T45 },
  { id: 'S3', protection: 'supersede abandons a message that is being sent right now', file: 'dist/storage.js',
    find: /if \(message\.status === 'processing'\)\s*return false;/, replace: '', tests: T45 },
  { id: 'S4', protection: 'a retry is sent although the participant moved on to a newer run', file: 'dist/outboxDispatcher.js',
    find: /if \(descriptor && !\(\(0, runMembership_1\.isLatestResultForSender\)/, replace: 'if (false && descriptor && !((0, runMembership_1.isLatestResultForSender)', tests: T45 },
  { id: 'S5', protection: 'delivery status only matches the latest provider id', file: 'dist/storage.js',
    find: /\|\| item\.attemptLog\?\.some\(\(entry\) => entry\.providerMessageId === id \|\| entry\.providerMessageIds\?\.includes\(id\)\)\);/, replace: ');', tests: T45 },
];

// Evidence during the send (MUT_SET=ev): a delivery callback that arrives while the POST is in the air must not be lost.
const TEV = ['test-evidence-during-send.js', 'test-evidence-during-send-postgres.js'];
const MUTATIONS_EV = [
  { id: 'V1', protection: 'the outcome decision (uncertain) ignores evidence kept on the attempt (the reported bug)', file: 'dist/storage.js',
    find: /if \(this\.settleSentByDeliveryEvidence\(message\)\)\s*return true;/, replace: '', tests: TEV },
  { id: 'V2', protection: 'the naive fix: processing is treated like uncertain and marked sent while the POST is in the air (race)', file: 'dist/storage.js',
    find: /if \(message\.status === 'processing'\) \{\s*\/\/[\s\S]*?return false;\s*\}\s*if \(message\.status === 'uncertain' \|\| message\.status === 'retry'/, replace: "if (message.status === 'processing' || message.status === 'uncertain' || message.status === 'retry'", tests: TEV },
  { id: 'V3', protection: 'a transient rejection after evidence still schedules a retry', file: 'dist/storage.js',
    find: /if \(this\.settleSentByDeliveryEvidence\(message\)\)\s*return;\s*\/\/ the provider already confirmed a copy: no further POST/, replace: '', tests: TEV },
  { id: 'V4', protection: 'the retry decision (release) ignores confirmed attempts', file: 'dist/storage.js',
    find: /if \(reason !== 'delivery_failed_evidence' && this\.settleSentByDeliveryEvidence\(message\)\)\s*return;/, replace: '', tests: TEV },
  { id: 'V5', protection: 'crash recovery treats a confirmed processing row as an orphan again', file: 'dist/storage.js',
    find: /if \(this\.markOutboxUncertain\(message\.id, `Process ended while sending[^\n]*\)\)\s*continue;/, replace: 'this.markOutboxUncertain(message.id, "orphan");', tests: TEV },
];

const SELECTED = process.env.MUT_SET === 'ev' ? MUTATIONS_EV : process.env.MUT_SET === 'b2s45' ? MUTATIONS_B2S45 : process.env.MUT_SET === 'b2s3b' ? MUTATIONS_B2S3B : process.env.MUT_SET === 'b2s3' ? MUTATIONS_B2S3 : process.env.MUT_SET === 'b2s2' ? MUTATIONS_B2S2 : process.env.MUT_SET === 'b2' ? MUTATIONS_B2 : MUTATIONS;
const out = process.argv[2];
const report = { startedAt: new Date().toISOString(), mutations: [] };
let restoredOk = true;
for (const m of SELECTED) {
  if (process.env.MUT_ONLY && process.env.MUT_ONLY !== m.id) continue;
  const file = path.join(root, m.file);
  const original = fs.readFileSync(file);
  const originalSha = sha(original);
  const text = original.toString('utf8');
  const entry = { id: m.id, protection: m.protection, file: m.file, applied: false, tests: [] };
  try {
    if (!m.find.test(text)) throw new Error(`mutation pattern not found in ${m.file}`);
    fs.writeFileSync(file, text.replace(m.find, m.replace));
    entry.applied = true;
    for (const t of m.tests) {
      const r = spawnSync(process.execPath, [path.join('scripts', t)], { cwd: root, env: process.env, encoding: 'utf8', timeout: Number(process.env.MUT_TEST_TIMEOUT_MS || 240_000) });
      const timedOut = r.status === null;
      const failedNames = (r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.slice(6).trim().slice(0, 140));
      entry.tests.push({ test: t, exit: r.status, timedOut, caught: r.status !== 0, failedScenarios: failedNames, outputTail: timedOut || failedNames.length === 0 ? ((r.stdout || '') + (r.stderr || '')).split(String.fromCharCode(10)).slice(-6).join(String.fromCharCode(10)) : undefined });
    }
    entry.caught = entry.tests.some((x) => x.caught);
  } catch (e) {
    entry.error = e.message;
  } finally {
    fs.writeFileSync(file, original);
    entry.restoredExactly = sha(fs.readFileSync(file)) === originalSha;
    if (!entry.restoredExactly) restoredOk = false;
  }
  report.mutations.push(entry);
  console.log(`${m.id} ${m.protection}: applied=${entry.applied} caught=${entry.caught} restored=${entry.restoredExactly}` + (entry.error ? ` ERROR=${entry.error}` : ''));
  for (const t of entry.tests) console.log(`    ${t.test}: exit=${t.exit}${t.timedOut ? ' (TIMED OUT)' : ''}${t.failedScenarios.length ? ' failing: ' + t.failedScenarios.length : ''}`);
}
report.allCaught = report.mutations.every((x) => x.caught);
report.allRestored = restoredOk;
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
process.exit(report.allCaught && restoredOk ? 0 : 1);
