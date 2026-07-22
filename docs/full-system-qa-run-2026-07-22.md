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

Campaign creation, PostgreSQL persistence, two decision/button steps, long Meta button title configuration, Unicode sanitization, and post-restart readback passed. A real inbound trigger and button reply still require a message from an approved test handset; no arbitrary recipient was contacted.

## Stage 6 - Restart and Recovery

Result: PARTIAL PASS.

Clean reloads before and after a 300-save burst preserved the campaign and active state with `pendingWrites=0`. Pending-participant, in-flight outbox, delayed media, and timeout restarts still require the live handset/provider flow.

## Stage 7 - Load

Result: PARTIAL PASS.

The local PostgreSQL burst passed with 2,000 writes. The deployed isolated runtime passed 300 campaign-save requests at concurrency 20 with zero HTTP failures, p95 369 ms, maximum 555 ms, and `pendingWrites` returning to zero. Multi-user message-flow/provider load was not run.

## Stage 8 - Health and Acceptance

Result: PASS for the exercised runtime scope.

A Meta webhook health-reporting defect was found, fixed, covered by `npm run test:provider-health`, deployed only to the test client, and verified twice after reload. PostgreSQL, campaign counts, outbox, and provider status all met the acceptance criteria.

## Stage 9 - Rollback Drill

Result: NOT RUN.

A PostgreSQL export, second-export refusal, JSON clone boot, count/hash comparison, and measured recovery time remain outstanding in the isolated environment.

## Final Status

Decision: APPROVED WITH LIMITATIONS.

Local regression, PostgreSQL, Unicode/JSON, migration safety, outbox, mock provisioning, isolated runtime storage, 300-save runtime pressure, clean restart, and health acceptance passed. Full release completion remains limited by live Meta message-flow/restart tests, the external rollback drill, and one real owner-driven provisioning run after the owner runtime is upgraded.

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
| Campaign E2E | PARTIAL | Campaign and button configuration persist, but a real inbound Meta trigger, button click, duplicate click, timeout, media, scoring, raffle, and contact-card flow still require an approved test handset. |
| Restart/recovery | PARTIAL | Clean restart and post-burst persistence passed. Restart while a participant is pending, while an outbox item is in flight, and during delayed media still require the live test handset/provider path. |
| Load | PARTIAL | Local 2,000-write PostgreSQL test and live 300-save runtime test passed. Multi-user message-flow/provider load was not run. |
| Health acceptance | PASS | Repeated post-restart health checks passed after the Meta reporting fix. |
| Rollback drill | NOT RUN | A PostgreSQL export, second-export refusal, JSON clone boot, count/hash comparison, and measured recovery time remain outstanding. |

## Updated QA Decision

Decision: **APPROVED WITH LIMITATIONS**.

The original Unicode/PostgreSQL crash path is covered locally and on the deployed isolated runtime, including real persistence, a 300-save burst, and restart. The isolated client is healthy. Full release completion still requires live Meta message-flow/restart testing, the external rollback drill, and one real owner-driven new-client provisioning run after the owner runtime is upgraded.
