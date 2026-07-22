# PostgreSQL Rollout Status - 2026-07-22

## Completed

- Promoted the validated QA branch to `master` at `e8eec8e`.
- Disabled Auto Deploy for all existing client applications and the Owner application.
- Deployed the Owner application manually.
- Verified automatic PostgreSQL-first provisioning with disposable client `client-lasttest-e96e18c6`:
  - dedicated PostgreSQL reached `done`;
  - `DATABASE_URL` existed before the first application deployment;
  - health returned `storage.enabled=true`, `storage.ready=true`, and `pendingWrites=0`.
- Migrated inactive client `client-1-cab55e82`:
  - source JSON: 1 campaign, 378 contacts, 378 contactQueue rows, 407 campaign results, 1,640 campaign events;
  - PostgreSQL export matched all counts;
  - final health: PostgreSQL enabled and ready, zero pending writes, empty outbox;
  - original JSON remains available for rollback.

## Deferred

- `client-account-706d5db8`: active campaign; migrate in a controlled window.
- `client-account-5ec279a8`: two active campaigns; migrate in a controlled window.
- `client-account-fce3d086` (Avia): explicitly deferred and untouched.
- Remaining JSON client inventory requires the same per-client process.
- Keep Auto Deploy disabled until the rollout is complete and the release policy is reviewed.

## Per-client cutover

1. Confirm no active campaign or schedule.
2. Create a dedicated PostgreSQL service and wait for `done`.
3. Set `DATABASE_URL` without exposing it.
4. Deploy/reload the validated application.
5. Run `npm run db:migrate` and review counts.
6. Run `npm run db:migrate:force` only when the database contains only the empty startup snapshot and the client is inactive.
7. Reload the application.
8. Verify health, counts, outbox, and a representative client workflow.
9. Export PostgreSQL to a new rollback JSON path and keep the original JSON.

No Production domain, webhook, Meta configuration, or Avia application deployment was changed during this checkpoint.
