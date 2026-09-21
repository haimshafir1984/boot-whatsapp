# Stage E: independent review and implementation plan

Date: 2026-09-21. Inspected HEAD: `098b94f`, with existing unrelated worktree changes.
Status: planning only; implementation awaits approval, as requested in the brief.
No production access, migration, commit, push, or deployment performed.

## Decision

Approve the direction of a row-based PostgreSQL inbox for both gateway and
client. Do not treat that change alone as proof that the Oshrit incident cannot
recur. Current conversation persistence still performs full-state synchronous
work, and a stale trigger can still finish its inbox item as completed.

Use Stage E plus the narrowly scoped conversation-persistence and stale-outcome
work below as the release gate. Keep routing authority and the deployed Outbox
state machine unchanged. Any test requiring changes there becomes an explicit
blocking finding, not permission to silently redesign those systems.

## Evidence and corrections

Sources: `docs/stage-e-inbox-durability-brief-2026-09-21.md`, the previous 5.5
summary, `docs/stability-plan-2026-09-01.md`, and current source files.

1. **Whole-file inbox writes: confirmed.** `src/metaGatewayInbox.ts:245`
   serializes every item and synchronously writes, copies and renames files.
   `src/adminServer.ts:1277` creates both gateway and client inboxes using this
   implementation, regardless of the client's main storage backend.
2. **Read-side scaling: confirmed and must also be removed.**
   `src/metaGatewayInbox.ts:73` copies and sorts all items on claim; enqueue,
   update, held resolution and counts also scan the collection. Merely putting
   the JSON document into a database would preserve the problem.
3. **Non-completed retention: confirmed.** `src/metaGatewayInbox.ts:212`
   prunes only completed items. Retrying an existing message does NOT create
   another item. Backlog grows when new messages arrive faster than successful
   completion; retained failed/held items add history. Retries repeatedly pay
   the cost of that growing collection. Do not delete unresolved work to fix it.
4. **Timeout diagnosis: plausible mechanism, not historical proof.**
   Route and pending requests have 3-second timeouts
   (`src/adminServer.ts:1709,1861`). Synchronous gateway work can delay network
   handling and timers. A TimeoutError alone does not identify whether the
   gateway, client or network caused it, or establish that a reply arrived
   immediately. Verify with separate-process clients, injected gateway load,
   gateway lag, client processing time and request timings.
5. **Old retry curve is historical.** Current retry delay is 500ms exponential
   with a 5-second cap and 60 attempts (`src/adminServer.ts:2069`). The old
   10.25-minute backoff must not be presented as the current curve. The current
   delays alone sum to about 4.7 minutes before attempt 60, but network/handler
   time, polling, sender ordering and queue wait are additional. There is no
   hard guarantee that total age stays below the 10-minute Meta trigger limit.
   Raising the attempt ceiling increases worst-case work, not necessarily all
   traffic by exactly six times. Retain the current retry budget.
6. **Deployment fix exists in code.**
   `src/dokployProvisioner.ts:369` uses `application.deploy` in the existing
   client update flow. This review did not recheck the 16 production builds or
   the live Focus campaign configuration. Those are reported observations in
   the brief, not new verifications. Current pending lookup also explicitly
   tolerates 404 (`src/adminServer.ts:1872`); the historical log is not a literal
   description of current behavior. Require capability checks before launch;
   routing changes remain outside this plan.
7. **Cache failure path: confirmed; stale grace needs separate safety design.**
   `src/metaGatewayReliability.ts:136` replaces an expired cache value with a
   pending entry, and removes that entry when refresh fails. The routes caller
   returns unavailable. The refresh timer calls `get`, which returns a fresh
   value without refreshing it: comments about refreshing before expiry do
   not match implementation. A stale route list can hide a new conflicting
   trigger or retain a disabled campaign. Do not make stale data authoritative
   without a version/invalidation/ownership contract. The reported 3/33 runs
   and 166 events were not independently rerun here.
8. **Conversation bottleneck is STILL present.**
   `src/conversationState.ts:616` rebuilds the full conversation snapshot;
   `src/storage.ts:1744` deep-copies that snapshot using stringify/parse;
   `src/conversationState.ts:654` writes it synchronously even in PostgreSQL
   mode. `src/index.ts:57` wires this persistence into startup. Per-row DB dirty
   tracking and removing embedded flows did not eliminate these costs.
9. **Stale can look completed.** `src/messageFlow.ts:1643` logs and returns
   for an expired matched trigger. The caller can then mark the inbox item
   completed (`src/adminServer.ts:2189`). Durable receipt alone does not prove
   useful processing or prevent silent expiry.
10. **Other synchronous work remains.** `src/metaStatusQueue.ts:98,202`
    appends a journal and periodically rewrites it synchronously. Include
    realistic delivery-status traffic and compaction in the whole-system
    benchmark. Do not change the deployed Outbox/recovery machinery implicitly.

## Proposed implementation

### 1. Async inbox repository and isolated SQL schema

- Promise-based enqueue, claim, renew, complete, retry, held, failed, explicit
  replay, cancellation, paginated inspection and metrics. Adapt both drainers,
  HTTP receipt paths, admin actions and shutdown to await persistence.
- Dedicated gateway inbox connection setting, independent of main JSON owner
  storage. Client inbox uses its own client database. Bound pool sizes and
  query/lock waits; SQL failure is not permission to fall back to JSON.
- Inbox tables have their own migrations and are absent from snapshot writes,
  deletes, imports and exports unless explicitly supported by the inbox tool.
- Unique identity: storage namespace + inbox role + phoneNumberId + messageId.
  Persist original envelope, sender key, status, attempts, enqueue order,
  provider timestamp, receivedAt, nextAttemptAt, lease/token and errors. Preserve
  existing routing metadata without introducing new routing authority.
- Separate message payload retention from durable dedupe identity. Default
  dedupe window is 30 days for terminal records; unresolved records remain
  protected regardless of age. Cleanup uses bounded indexed batches. Failed
  and held work retains its evidence until explicit resolution.
- Webhook success only after every included inbound item commits. If a batch
  partially commits before failure, return an error and safely dedupe redelivery.
  Preserve existing status-receipt durability requirements.

### 2. Bounded scheduling and crash semantics

- Persist a scheduler row per sender/role/phone, pointing to its first eligible
  outstanding item and due time. Claim due sender rows with locking and bounded
  batches, then their head messages. Maintain these pointers transactionally
  on enqueue, retry, terminal transitions, cancellation and replay.
- Enqueue order is assigned while serializing on the sender row, so concurrent
  insertion cannot publish a later message ahead of an uncommitted earlier one.
  Use consistent lock order and indexed next-item lookup. No global sort or
  scan of all retry records on a polling tick, including ticks with no due work.
- Token-conditioned writes reject stale worker completion/retry. Renewable
  leases cover long flows; database loss stops new claims and fails receipts.
  Test old-worker resumption while a replacement is running. A token by itself
  does not fence network sends or guarantee exactly-once campaign execution.
- Gateway forwarding may be redelivered after crash; the client's durable
  identity must reject duplicates. For client crashes between business effects
  and inbox completion, prove safe resume using existing durable evidence, or
  hold for review. Never blindly rerun a possibly partially executed campaign.
- Preserve held/replay/cancellation behavior, including subsequent messages
  becoming visible as held. Historical requeue must not overtake active work.
  Failed/review work needs paginated inspection, alerts and audited resolution.

### 3. Close the remaining conversation and expiry gaps

- PostgreSQL conversation changes persist changed senders only. Remove the
  full-state rebuild/deep clone from the per-message path and remove its
  synchronous shadow-file write. Startup reconstructs from the database;
  explicit backup/export replaces the hot-path shadow copy. Keep legacy JSON
  behavior and tests, but do not describe it as scalable SQL storage.
- Preserve the existing flush-before-processing-success boundary, timer
  restoration and needs-review durability. Test database failure and restart
  with accumulated abandoned conversations.
- Introduce an explicit stale-trigger outcome: retain payload and reason as
  review/failed work with an alert, never silently complete it. Carry the
  outcome through the handler without routing it through generic retry or
  partial-send classification. Do not automatically run an expired campaign,
  overwrite the original message timestamp, or relax the expiry policy.
- Keep cache behavior fail-closed for this release. Record cache age, lookup
  failures, request timing and event-loop lag. Separate any stale-grace proposal
  from Stage E approval.

## Migration and recovery

1. Provision and verify gateway PostgreSQL, schema, disk capacity, backups and
   restore procedure. Inventory both inbox roles, client database identities,
   existing files and actual runtime versions/capabilities.
2. Dry-run validation reports status counts, missing identities, duplicate
   identity conflicts, invalid timestamps and malformed payloads. Never silently
   choose a conflicting duplicate or use a potentially older backup as truth.
3. Stop new workers, drain or fence active work, and stop all JSON writers.
   During the brief cutover, reject inbound receipts so upstream can retry.
   Verify no old process can resume writing; take immutable backup + checksum.
4. Import with transactional batches and an idempotent migration ledger keyed
   by source identity/checksum. Preserve attempts, ordering and replay evidence;
   processing items require recovery classification, not assumed success.
5. Verify per-status counts and identity/payload checksums; only then activate
   SQL as the single backend, enable receipts and resume workers. A restart
   must read the migration state and never start both backends.
6. Rollback before SQL writes can reactivate the unchanged original. After SQL
   receives new work, rollback is a controlled stop + verified export/reconcile
   into a compatible backend. Switching to the old JSON file would lose work.
7. Pilot a test client and gateway in staging, then a limited production rollout
   with separate deployment authorization. Retain the original source files.

## Acceptance gates

All figures below are proposed release thresholds, not measurements from this
review. Fix the test hardware, payload distribution and workload before running.

- Real PostgreSQL is required; absence/failure fails the suite instead of SKIP.
  Separate gateway/client processes; sequential load scenarios, clean process
  per scenario. No real customer sends.
- Concurrent 100/150 receipts, repeated IDs, different phone IDs with the same
  message ID, one sender versus many, two workers, and multi-message webhooks.
  No acknowledged item is missing; every item has an auditable final outcome.
- Kill/restart at receipt commit, claim, forward acceptance, business-effect
  persistence and completion. Test lost commit responses, long-running worker
  reclaim, database rollback/outage/recovery, held replay and cancellation races.
  Assert no duplicate user-visible effects in the defined scenarios; ambiguous
  processing is held and surfaced, not declared successfully recovered.
- Import twice, interrupt each checkpoint, corrupt input and attempt restart
  during cutover. Prove no dual writers and no silently omitted records.
- Cross-product of 300/5,000/50,000 retained records and independently sized
  active retry backlogs. Include one blocked sender with many later messages,
  many blocked senders, not-yet-due retries, held/failed history and idle polls.
  Examine query plans and rows visited, not just returned LIMIT sizes.
- No whole-history loading, sorting or serialization per inbox operation.
  Indexed lookup costs need not be mathematically constant, but must not be
  linear in total history/backlog. Proposed gate: p95 enqueue/claim/transition
  latency at 50,000 <= 2x the 300-row case and <= 100ms on fixed test hardware.
- Full flow: 100 simultaneous participants, 150 as stress, 1,000 over two hours,
  then a third-hour recovery observation with 30-40% abandonment and seeded
  conversation history. Include media statuses and status-journal compaction.
- Healthy-run proposed gates: gateway event-loop lag p99 < 100ms, max < 500ms;
  internal receipt-to-handler-start p99 < 5s, max < 30s; no stale drops and no
  unexplained routing timeouts. Media/provider delivery time is measured
  separately; intentional campaign delays are identified explicitly.
- Inject 60s/180s client and DB outages. Show bounded retry work and backlog
  drainage after recovery; no acknowledged message disappears or masquerades
  as completed. Test outages beyond trigger lifetime: visible review outcome
  is required even when automatic campaign delivery is no longer appropriate.
- Monitor oldest actionable message and queue-wait percentiles, not only
  counts. Proposed warning at 30s, critical at 120s; persistence failure,
  exhausted attempts and stale outcome alert immediately. Verify alert delivery
  and avoid relying on a dashboard query that scans history on every message.
- Run existing inbox, sender ordering, routing isolation, signature, PG delta,
  conversation recovery, shutdown, held/replay and Outbox recovery regressions.
  Compare whole-system lag and latency with the current HEAD baseline. A remaining
  synchronous bottleneck failing these gates blocks release and gets a focused
  follow-up; passing isolated repository tests is insufficient.

## Effort and completion criteria

Planning estimate for one engineer: 2-3 days repository/schema/scheduling,
1-2 days integration and conversation/expiry fixes, 1-2 days migration/recovery
tooling, 2-3 days fault/load/regression validation and review: 6-10 working days,
plus staged observation. Crash-window findings can expand scope; this is not a
delivery promise. Do not compress the safety checks to meet a campaign date.

Implementation approval should cover sections 1-3 and the migration/test tooling.
Actual migration and deployment remain separate authorized operations.
This review used static source inspection only; no new benchmark, production
verification or failure-injection run was performed. The release is ready only
when test evidence, migration rehearsal, backup restore, version/capability checks
and the production pilot are recorded, with no unresolved blocking findings.
