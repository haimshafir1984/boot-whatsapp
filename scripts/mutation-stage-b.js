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

// Stage E / C2 (MUT_SET=inbox): the PostgreSQL inbox repository's safety properties. Each mutation must make test-inbox-repository-postgres.js fail.
const TINBOX = ['test-inbox-repository-postgres.js'];
const MUTATIONS_INBOX = [
  { id: 'E1', protection: 'a worker transition does not republish the sender pointer (scheduler goes stale)', file: 'dist/inbox/postgresRepository.js',
    find: /else if \(!r\.rowCount\)\s*return null;\s*await this\.recomputeHead\(c, item\.sender_key\);/, replace: 'else if (!r.rowCount) return null;', tests: TINBOX },
  { id: 'E2', protection: 'the lease token no longer fences a stale worker on completion/retry/hold/fail/review', file: 'dist/inbox/postgresRepository.js',
    find: /where id = \$1 and status = 'processing' and lease_token = \$2 returning id`, \[id, leaseToken, to,/, replace: "where id = $1 and status = 'processing' and $2::text is not null returning id`, [id, leaseToken, to,", tests: TINBOX },
  { id: 'E3', protection: 'a CLIENT item with an expired lease is re-run instead of going to review (duplicate business effect)', file: 'dist/inbox/postgresRepository.js',
    find: /\(this\.role === 'gateway' \? claimIds : reviewIds\)\.push\(h\.id\);/, replace: 'claimIds.push(h.id);', tests: TINBOX },
  { id: 'E4', protection: 'renew does not move the sender due_at (pointer drift)', file: 'dist/inbox/postgresRepository.js',
    find: /await this\.recomputeHead\(c, item\.sender_key\); \/\/ due_at follows the new lease expiry \(I3\)/, replace: '', tests: TINBOX },
  { id: 'E5', protection: 'requeue keeps the old sequence (a requeued message can overtake active work)', file: 'dist/inbox/postgresRepository.js',
    find: /sender_seq = \$2, attempts = 0, next_attempt_at = null, last_error = null,\s*resolution = null/, replace: 'sender_seq = sender_seq + 0 * $2, attempts = 0, next_attempt_at = null, last_error = null, resolution = null', tests: TINBOX },
  { id: 'E6', protection: 'the per-sender sequence counter is not advanced (order / uniqueness lost)', file: 'dist/inbox/postgresRepository.js',
    find: /do update set next_seq = inbox_senders\.next_seq \+ 1, updated_at = \$\{this\.T\}/, replace: 'do update set updated_at = ${this.T}', tests: TINBOX },
  { id: 'E7', protection: 'cleanup deletes held/failed/review evidence', file: 'dist/inbox/postgresRepository.js',
    find: /select id from inbox_items where namespace = \$1 and role = \$2 and status = 'completed'\n\s*and updated_at < \$\{this\.TS\} - \(\$3::int \* interval '1 day'\) order by updated_at, id limit \$4 for update skip locked\)`,\s*\[this\.ns, this\.role, dedupeDays, batch\]/, replace: "select id from inbox_items where namespace = $1 and role = $2 and status in ('completed','held','failed','review')\n            and updated_at < ${this.TS} - ($3::int * interval '1 day') order by updated_at, id limit $4 for update skip locked)`, [this.ns, this.role, dedupeDays, batch]", tests: TINBOX },
  { id: 'E8', protection: 'a late completion by ANY token closes an ambiguous item', file: 'dist/inbox/postgresRepository.js',
    find: /where id = \$1 and status = 'review' and resolution = 'ambiguous_processing' and lease_token = \$2 returning id`, \[id, leaseToken\]/, replace: "where id = $1 and status = 'review' and resolution = 'ambiguous_processing' and $2::text is not null returning id`, [id, leaseToken]", tests: TINBOX },
];

// Stage E / C3 (MUT_SET=c3): the runtime wiring of the inboxes. Each mutation must make test-inbox-runtime-postgres.js fail.
const TC3 = ['test-inbox-runtime-postgres.js'];
const MUTATIONS_C3 = [
  { id: 'W1', protection: 'the gateway webhook is acknowledged before its messages are committed (no ACK before commit)', file: 'dist/adminServer.js',
    find: /await metaGatewayInbox\.enqueueMany\(/, replace: 'void metaGatewayInbox.enqueueMany(', tests: TC3 },
  { id: 'W2', protection: 'the client receipt returns 2xx before the items are committed', file: 'dist/adminServer.js',
    find: /await metaClientInbox\.enqueueMany\(/, replace: 'void metaClientInbox.enqueueMany(', tests: TC3 },
  { id: 'W3', protection: 'an expired trigger is recorded as completed (silent stale)', file: 'dist/adminServer.js',
    find: /if \(outcome\?\.kind === 'stale_trigger'\)\s*await parkStaleTrigger\(metaClientInbox/, replace: "if (false) await parkStaleTrigger(metaClientInbox", tests: TC3 },
  { id: 'W4', protection: 'an interrupted (ambiguous) item does not put the sender on hold', file: 'dist/adminServer.js',
    find: /for \(const r of reviewed\)\s*void handleAmbiguousInbox\(r\);/, replace: '', tests: TC3 },
  { id: 'W5', protection: 'a held sender\'s message is completed instead of held', file: 'dist/adminServer.js',
    find: /metaClientInbox\.hold\(item, err\)/, replace: 'metaClientInbox.complete(item, "processed")', tests: TC3 },
  { id: 'W6', protection: 'shutdown ignores claims that are still in flight (items run against closed pools)', file: 'dist/adminServer.js',
    find: /while \(\(pendingInboxClaims > 0 \|\| metaGatewayDrainer/, replace: 'while ((false || metaGatewayDrainer', tests: TC3 },
];

// Stage E / C4 (MUT_SET=c4): conversation state row persistence in PostgreSQL mode. Each mutation must make test-conversation-state-rows-postgres.js fail.
const TC4 = ['test-conversation-state-rows-postgres.js'];
const MUTATIONS_C4 = [
  { id: 'K1', protection: 'restore falls back to a leftover file in PostgreSQL mode (stale conversations come back)', file: 'dist/conversationState.js',
    find: /\?\? \(this\.rowsMode \? undefined : this\.readSnapshotFile\(\)\)/, replace: '?? this.readSnapshotFile()', tests: TC4 },
  { id: 'K2', protection: 'removals are not sent to the database (a removed conversation comes back after a restart)', file: 'dist/conversationState.js',
    find: /removed\.push\(jid\);\s*continue;/, replace: 'continue;', tests: TC4 },
  { id: 'K3', protection: 'the frozen copy keeps a removed row (the direct writer never sees the deletion)', file: 'dist/database.js',
    find: /else\s*delete conv\[jid\];/, replace: ';', tests: TC4 },
  { id: 'K4', protection: 'the direct row writer never deletes', file: 'dist/database.js',
    find: /async function syncConversationRowsDirect\(pool, jids, conversations\) \{[\s\S]*?if \(removed\.length\)/, replace: (m) => m.replace(/if \(removed\.length\)$/, 'if (false)'), tests: TC4 },
  { id: 'K5', protection: 'PostgreSQL mode still writes the synchronous shadow file', file: 'dist/conversationState.js',
    find: /console\.warn\('Could not persist conversation state:', err\);\s*\}\s*return;\s*\}/, replace: "console.warn('Could not persist conversation state:', err);\n            }\n            /* mutated: no early return */\n        }", tests: TC4 },
  { id: 'K6', protection: 'non-restorable rows are left in the database after restore', file: 'dist/conversationState.js',
    find: /if \(dropped\.length\)/, replace: 'if (false)', tests: TC4 },
  { id: 'K7', protection: 'a change is applied in memory but never queued for the database', file: 'dist/storage.js',
    find: /this\.persist\(\['conversationStateSnapshot'\], \{ conversationStateSnapshot: \[\.\.\.Object\.keys\(upserts\), \.\.\.removed\] \}\);/, replace: '', tests: TC4 },
];

// Stage E / C5 (MUT_SET=mig): migration safety properties. Each mutation must make test-inbox-migration-postgres.js fail.
const TMIG = ['test-inbox-migration-postgres.js'];
const MUTATIONS_MIG = [
  { id: 'G1', protection: 'the import runs without a verified backup', file: 'dist/inbox/migration.js',
    find: /const backup = writeImmutableBackup\(o\.sourceFile, o\.backupDir, read\.sha256\);/, replace: "const backup = { path: path.join(o.backupDir, 'none'), sha256: read.sha256 };", tests: TMIG },
  { id: 'G2', protection: 'verification cannot block activation', file: 'dist/inbox/migration.js',
    find: /if \(!v\.ok\) \{/, replace: 'if (false) {', tests: TMIG },
  { id: 'G3', protection: 'a conflicting existing row is overwritten by the import', file: 'dist/inbox/migration.js',
    find: /on conflict \(namespace, role, phone_number_id, message_id\) do nothing/, replace: 'on conflict (namespace, role, phone_number_id, message_id) do update set payload = excluded.payload, status = excluded.status', tests: TMIG },
  { id: 'G4', protection: 'rollback restores the old file even after SQL did work (loses that work)', file: 'dist/inbox/migration.js',
    find: /const unchanged = \(0, exports\.digestRows\)\(cur\) === marker\.importedDigest;|const unchanged = digestRows\(cur\) === marker\.importedDigest;/, replace: 'const unchanged = true;', tests: TMIG },
  { id: 'G5', protection: 'the source is deleted instead of renamed', file: 'dist/inbox/migration.js',
    find: /fs_1\.default\.renameSync\(o\.sourceFile, migratedName\);/, replace: 'fs_1.default.unlinkSync(o.sourceFile);', tests: TMIG },
  { id: 'G6', protection: 'no startup guard: the JSON backend starts over a migrated inbox (two writers)', file: 'dist/inbox/migration.js',
    find: /if \(backend === 'json' && fs_1\.default\.existsSync\(markerPath\(jsonFile\)\)\)/, replace: "if (false)", tests: TMIG },
  { id: 'G7', protection: 'a still-active writer is not detected', file: 'dist/inbox/migration.js',
    find: /await ensureQuiet\(o\.sourceFile, o\.quietMs \?\? 2000\);/, replace: '', tests: TMIG },
  { id: 'G8', protection: 'the dry-run writes something', file: 'dist/inbox/migration.js',
    find: /report\.markerPresent = /, replace: "fs_1.default.writeFileSync(o.sourceFile + '.dryrun', 'x'); report.markerPresent = ", tests: TMIG },
];

const SELECTED = process.env.MUT_SET === 'mig' ? MUTATIONS_MIG : process.env.MUT_SET === 'c4' ? MUTATIONS_C4 : process.env.MUT_SET === 'c3' ? MUTATIONS_C3 : process.env.MUT_SET === 'inbox' ? MUTATIONS_INBOX : process.env.MUT_SET === 'ev' ? MUTATIONS_EV : process.env.MUT_SET === 'b2s45' ? MUTATIONS_B2S45 : process.env.MUT_SET === 'b2s3b' ? MUTATIONS_B2S3B : process.env.MUT_SET === 'b2s3' ? MUTATIONS_B2S3 : process.env.MUT_SET === 'b2s2' ? MUTATIONS_B2S2 : process.env.MUT_SET === 'b2' ? MUTATIONS_B2 : MUTATIONS;
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
