# Full System QA Run - 2026-07-22

Source plan: `docs/full-system-qa-2026-07.md`

Safety boundary: no Production, active client, domain, webhook, Meta, Twilio, Dokploy deployment, or Production `DATABASE_URL` changes were performed. `client-account-fce3d086` was not touched.

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
| Real isolated test-client provisioning | NOT RUN | Requires an explicitly approved isolated test client / Dokploy target. No Production or real Dokploy change was performed. |

## Stage 5 - Campaign E2E

Result: NOT RUN.

Reason: requires an isolated test client, test phone/provider path, campaign that is not public, and live message flow. This would touch an external runtime/provider environment and was not executed without explicit approval.

## Stage 6 - Restart and Recovery

Result: NOT RUN.

Reason: requires stopping/restarting an isolated test client/runtime during active decision, timeout, outbox, and media-send states. No restart or fault injection was performed without an approved test target.

## Stage 7 - Load

Result: NOT RUN.

Reason: requires an isolated E2E load environment with 100-300 simulated users, four campaigns, provider latency/failure simulation, and runtime metrics collection. No such environment was identified or modified.

## Stage 8 - Health and Acceptance

Result: NOT RUN.

Reason: health checks in the plan are intended for the tested container/runtime after E2E/restart/load execution. No approved isolated runtime was started or modified as part of this run.

## Stage 9 - Rollback Drill

Result: NOT RUN.

Reason: requires an isolated test environment with PostgreSQL export, clone-from-JSON startup, counts/hash comparison, and documented recovery time. No environment-level rollback drill was performed without explicit approval.

## Final Status

Decision: APPROVED WITH LIMITATIONS.

Local regression, local PostgreSQL, Unicode/JSON, migration safety, outbox, and mock provisioning checks passed. Full release approval remains blocked on the not-run external stages: isolated real provisioning, E2E campaign, restart/fault injection, load, health acceptance, and rollback drill.


## Supplemental Verification - Provisioning Retry

After reviewing the Stage 4 evidence, the mock regression was extended to run provisioning twice for the same managed client.

| Check | Result | Notes |
| --- | --- | --- |
| Retry does not recreate application | PASS | `application.create` call count remained unchanged. |
| Retry does not recreate volume | PASS | `mounts.create` call count remained unchanged. |
| Retry does not recreate PostgreSQL | PASS | `postgres.create` call count remained unchanged. |
| Retry does not recreate domain | PASS | `domain.create` call count remained unchanged. |
| Build and updated mock regression | PASS | `npm run test:dokploy-provisioner` completed successfully. |

This closes the local idempotent-rerun evidence gap. Real isolated Dokploy provisioning remains NOT RUN.
