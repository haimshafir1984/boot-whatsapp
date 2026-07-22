# Full System QA Run - 2026-07-22

Source plan: `docs/full-system-qa-2026-07.md`

Safety boundary: the initial run was local-only. After explicit authorization, external changes and tests were limited to `client-newtest-3f9077f9`. No Production client, domain, webhook, Meta, or Twilio configuration was changed. `client-account-fce3d086` was not touched.

## Starting Point

- Branch: `master`
- Commit: `d9bbe26 Add isolated PostgreSQL migration pilot`
- Worktree state before run: dirty, with existing modified/deleted/untracked files.
- Environment used: local repository and local PostgreSQL test database only.
- PostgreSQL test URL used in commands: `postgres://flowsbiz_test:***@localhost:5432/flowsbiz_test`

## Stage 1 - Local Regression

| Check | Result | Notes |
| --- | --- | --- |
| `npm run build` | PASS | `tsc` completed with exit code 0. |
| `npm run test:flow-recovery` | PASS | Script completed with "Flow recovery tests passed." Log included expected recovery/state-miss scenarios. |
| `npm run test:flow-concurrency` | PASS | Script completed with "Flow concurrency and timeout tests passed." Log included planned transport failure and retry. |
| `node scripts/test-campaign-data-reset.js` | PASS | Script completed with "Campaign data reset tests passed." |
| `node scripts/test-meta-contact-payload.js` | PASS | Script completed with "Meta contact payload tests passed." |
| `node scripts/test-meta-gateway-reliability.js` | PASS | Script completed with "Meta gateway reliability tests passed." |
| `node scripts/test-meta-campaign-routing.js` | PASS | Script completed with "Meta campaign routing tests passed." |
| `npm run test:outbox-claim` | PASS | Script completed with "Outbox claim and idempotency test passed." |
| `npm run test:outbox-durability` | PASS | Script completed with "Outbox durability test passed." |
| `npm run test:dokploy-provisioner` | PASS | Mock regression completed with "Dokploy PostgreSQL provisioning regression passed." |

## Stage 2 - Local PostgreSQL

`TEST_DATABASE_URL` was set to the local `flowsbiz_test` database for this stage.

| Check | Result | Notes |
| --- | --- | --- |
| `npm run test:postgres-delta` | PASS | Script completed with "PostgreSQL delta persistence test passed." |
| `npm run test:postgres-burst` | PASS | Script completed with "PostgreSQL burst test passed: 2000 writes, 19092ms." |
| `npm run test:migration-safety` | PASS | Script completed with "Migration guard and PostgreSQL export test passed." |

## Stage 3 - Unicode and JSON

| Check | Result | Notes |
| --- | --- | --- |
| Broken high surrogate sanitized | PASS | Covered by `scripts/test-postgres-delta.js`. |
| Broken low surrogate sanitized | PASS | Covered by `scripts/test-postgres-delta.js`. |
| NUL sanitized | PASS | Covered by `scripts/test-postgres-delta.js`. |
| Valid emoji preserved | PASS | Covered by `scripts/test-postgres-delta.js`. |
| Persisted to `app_state` and derived `jsonb` table | PASS | Covered by `scripts/test-postgres-delta.js` checks against `app_state` and outbox persistence. |
| No `22P02`, `json_errsave_error`, or invalid JSON syntax error | PASS | No such error appeared during the PostgreSQL delta run. |

## Stage 4 - Provisioning for New Client

| Check | Result | Notes |
| --- | --- | --- |
| Mock provisioning regression | PASS | `npm run test:dokploy-provisioner` validated PostgreSQL-before-app flow, env handling, dedicated resources, and idempotent rerun behavior in mock mode. |
| Real isolated runtime preparation | PARTIAL PASS | Dedicated PostgreSQL, test-app `DATABASE_URL`, QA branch deployment, and live health passed for `client-newtest-3f9077f9`. The database was attached manually because the deployed owner runtime predates the new provisioning code. |
| Automatic owner-driven provisioning | NOT RUN | Requires upgrading the owner runtime and creating one additional disposable client through the normal owner flow. |

## Stage 5 - Campaign E2E

Result: PARTIAL.

Campaign creation, PostgreSQL persistence, a real inbound Meta trigger, timeout, restart, late button recovery, both decision/button steps, long Meta button-title handling, raffle entry, completion, Unicode sanitization, and post-restart readback passed. Ask-name, scoring, media, contact-card confirmation, referral, and provider-failure injection were not exercised.

## Stage 6 - Restart and Recovery

Result: PARTIAL PASS.

Clean reloads before and after a 300-save burst preserved the campaign and active state with `pendingWrites=0`. A timed-out button reply after restart triggered flow recovery, restored the correct first step, advanced to the second step, and completed. Restart during an active pending timer, in-flight outbox item, or delayed media send was not exercised.

## Stage 7 - Load

Result: PARTIAL PASS.

The local PostgreSQL burst passed with 2,000 writes. The deployed isolated runtime passed 300 campaign-save requests at concurrency 20 with zero HTTP failures, p95 369 ms, maximum 555 ms, and `pendingWrites` returning to zero. Multi-user message-flow/provider load was not run.

## Stage 8 - Health and Acceptance

Result: PASS for the exercised runtime scope.

A Meta webhook health-reporting defect was found, fixed, covered by `npm run test:provider-health`, deployed only to the test client, and verified twice after reload. PostgreSQL, campaign counts, outbox, and provider status all met the acceptance criteria.

## Stage 9 - Rollback Drill

Result: PASS.

The isolated runtime exported PostgreSQL to a new JSON file with matching counts, refused a second export without `--force`, produced SHA-256 `87ba97ec2ecdcce5ee47282be4bb0dbcf1eeed31a297a09f5e11bbf7ab815468`, loaded the export through the JSON storage backend, and booted a temporary clone without `DATABASE_URL` on an internal port. Clone health returned one active campaign, ready JSON storage, an empty outbox, and ready Meta webhook status. The clone was stopped and its port was confirmed closed. Clone health was available within the 3-second verification window.

## Final Status

Decision: APPROVED WITH LIMITATIONS.

Local regression, PostgreSQL, Unicode/JSON, migration safety, outbox, mock provisioning, isolated runtime storage, 300-save runtime pressure, clean restart, health acceptance, and rollback passed. Full release completion remains limited by live Meta message-flow/restart tests and one real owner-driven provisioning run after the owner runtime is upgraded.

## Supplemental Verification - Provisioning Retry

After reviewing the Stage 4 evidence, the mock regression was extended to run provisioning twice for the same managed client.

| Check | Result | Notes |
| --- | --- | --- |
| Retry does not recreate application | PASS | `application.create` call count remained unchanged. |
| Retry does not recreate volume | PASS | `mounts.create` call count remained unchanged. |
| Retry does not recreate PostgreSQL | PASS | `postgres.create` call count remained unchanged. |
| Retry does not recreate domain | PASS | `domain.create` call count remained unchanged. |
| Build and updated mock regression | PASS | `npm run test:dokploy-provisioner` completed successfully. |

This closes the local idempotent-rerun evidence gap. A manually completed isolated Dokploy runtime test is documented below; automatic owner-driven provisioning remains NOT RUN.


## Isolated Runtime QA - client-newtest-3f9077f9

Authorization: the user explicitly approved all required testing on this client. No other client was changed. In particular, `client-account-fce3d086` was not touched.

Runtime target:

- Application: `client-newtest-3f9077f9-3vr9cg`
- Application ID: `NmFGzkZ0ssxMeuEWYsJIQ`
- PostgreSQL: `client-newtest-3f9077f9-postgres`
- QA branch: `codex/postgres-full-qa`
- Storage hardening commit: `c27b91e`
- Provider-health commit: `890212f`

### Provisioning and deployment

| Check | Result | Notes |
| --- | --- | --- |
| Dedicated PostgreSQL exists | PASS | A database dedicated to this isolated client was created and reached status `done`. |
| Application uses PostgreSQL | PASS | `DATABASE_URL` was added only to the test application; its value was not printed or stored in this report. |
| QA code deployed only to test application | PASS | The application was switched to `codex/postgres-full-qa`; no Production application was deployed. |
| Automatic new-client provisioning through the owner runtime | NOT RUN | The deployed owner/admin runtime still predates the provisioning change. This test client was corrected manually, so automatic live provisioning remains unproven until the owner runtime is deliberately upgraded. |

### PostgreSQL, Unicode, and restart

| Check | Result | Notes |
| --- | --- | --- |
| Health after PostgreSQL enablement | PASS | `storage.enabled=true`, `storage.ready=true`, `pendingWrites=0`. |
| Campaign persisted | PASS | Campaign `mrwhp52zpjjw` remained present and active after deploys and reloads. |
| Decision flow persisted | PASS | Both button steps were present after restart. |
| Broken high surrogate removed | PASS | Live readback returned no lone high surrogate. |
| Broken low surrogate removed | PASS | Live readback returned no lone low surrogate. |
| NUL removed | PASS | Live readback returned no NUL. |
| Restart after write burst | PASS | Campaign count and active state survived the reload; PostgreSQL returned ready with zero pending writes. |

### Runtime save load

A safe save-only burst was executed against the isolated application. The campaign was temporarily disabled to avoid provider sends and trigger-reservation traffic, then restored to its original name and active state.

| Metric | Result |
| --- | --- |
| Requests | 300 |
| Concurrency | 20 |
| HTTP failures | 0 |
| p50 | 202 ms |
| p95 | 369 ms |
| p99 | 455 ms |
| Maximum | 555 ms |
| Final `pendingWrites` | 0 |
| Final campaign state | Original name restored; active restored |
| Outbox after test | 0 queued, 0 processing, 0 failed |

This is a PASS for deployed-runtime PostgreSQL save pressure. It is not a substitute for the runbook's 100-300 user message-flow/provider load test.

### Provider health defect found and fixed

The first live check exposed inconsistent status reporting: `/api/qr` correctly reported Meta as ready, but `/health` reported the unused Chromium `botState` as stopped.

The health calculation was unified for webhook providers and covered by `npm run test:provider-health`. Commit `890212f` was deployed only to this test application.

Two checks separated by 15 seconds after reload both returned:

- `ok=true`
- `campaigns.total=1`, `campaigns.active=1`
- `storage.enabled=true`, `storage.ready=true`, `storage.pendingWrites=0`
- outbox queue/processing/failed all zero
- `whatsapp.ready=true`
- `whatsapp.authenticated=true`
- `whatsapp.lifecycle=running`
- `whatsapp.actualProvider=META_CLOUD_API`
- `whatsapp.shouldRun=true`

### Remaining external coverage

| Stage | Status | Remaining evidence |
| --- | --- | --- |
| Campaign E2E | PARTIAL PASS | Real trigger, timeout, restart, flow recovery, long button, second step, raffle, and completion passed. Ask-name, scoring, media, referral, and contact-card confirmation remain untested. WhatsApp disabled the already-used button, so manual duplicate clicking was unavailable; local concurrency/deduplication coverage passed. |
| Restart/recovery | PARTIAL PASS | Clean restart, post-burst persistence, and a late timed-out reply after restart passed through flow recovery. Restart during an active timer, in-flight outbox item, or delayed media remains untested. |
| Load | PARTIAL | Local 2,000-write PostgreSQL test and live 300-save runtime test passed. Multi-user message-flow/provider load was not run. |
| Health acceptance | PASS | Repeated post-restart health checks passed after the Meta reporting fix. |
| Rollback drill | PASS | PostgreSQL export, overwrite refusal, hash/count verification, JSON clone boot, health verification, and clone shutdown all passed. |

## Updated QA Decision

Decision: **APPROVED WITH LIMITATIONS**.

The original Unicode/PostgreSQL crash path is covered locally and on the deployed isolated runtime, including real persistence, a 300-save burst, restart, rollback, and the critical live Meta button recovery path. The isolated client is healthy. Full release completion still requires the unexercised media/scoring/contact-card/fault-injection cases and one real owner-driven new-client provisioning run after the owner runtime is upgraded.


### Rollback drill evidence

| Check | Result | Notes |
| --- | --- | --- |
| PostgreSQL export to a new path | PASS | Counts: campaigns 1; all queue/result/event/outbox/pending-conversation collections 0. |
| Existing export overwrite refused | PASS | A second run without `--force` was rejected. |
| Export integrity | PASS | JSON parsed successfully and SHA-256 was recorded. |
| Standalone JSON storage load | PASS | One campaign loaded; queue and outbox counts matched the export. |
| Temporary JSON clone boot | PASS | Started without `DATABASE_URL` on container-local port 3999 and returned `ok=true`, one active campaign, `storage.enabled=false`, `storage.ready=true`, and a clean outbox. |
| Clone cleanup | PASS | The temporary process was terminated and port 3999 was confirmed closed. |

The active PostgreSQL runtime was not switched, stopped, or modified by the clone test. The export remains on the isolated test client's data volume as `qa-rollback-20260722.json`.


### Live Meta button-flow evidence

An approved test handset sent the unique trigger `qa-c27b91e-3f9077f9` to the configured Meta number.

Observed sequence:

1. The first long-title button was delivered.
2. The one-minute decision timeout fired.
3. The isolated application was reloaded.
4. A late reply to the old button produced the configured `QA flow recovery` response and re-presented the correct first step.
5. The first choice advanced to the second `Finish QA` button.
6. The second choice produced `QA completed`.

Post-flow PostgreSQL export counts:

| Item | Count |
| --- | ---: |
| campaigns | 1 |
| campaignResults | 1 |
| campaignEvents | 7 |
| outboxMessages | 4 |
| pendingConversations | 0 |

Event types were exactly: `step_sent=3`, `step_answered=2`, `raffle_entry=1`, `completed=1`. The outbox reported four sent messages and zero queued, processing, retry, or failed messages. The campaign summary reported one participant and one completion. This proves no duplicate result, raffle entry, or completion in the exercised flow.

WhatsApp disabled the button after use, so the same interactive button could not be clicked manually a second time. Duplicate-click and serialized-reply behavior remains covered by the passing local concurrency tests.

One contact-save job ended as failed after retries because this fresh test client uses `contactsProvider=google` while `googleConnected=false`. This is an expected configuration limitation for a client that has not authorized Google Contacts; it did not block campaign completion, Meta delivery, PostgreSQL writes, or outbox completion.
