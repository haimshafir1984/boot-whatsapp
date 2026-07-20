# PostgreSQL hardening status

Updated: 2026-07-20

## Deployment safety

All PostgreSQL behaviour remains opt-in. Existing deployments without `DATABASE_URL` continue using JSON. No customer deployment or Dokploy environment was changed by these commits.

Every customer must be migrated and deployed manually. Pushing these commits does not migrate data.

## Completed hardening

### Incremental PostgreSQL persistence

Runtime writes still update the compatible `app_state` snapshot, but derived tables are no longer deleted and recreated on every event. Only added, changed, and removed rows are synchronized.

PostgreSQL writes are coalesced: while one snapshot is being stored, only the newest pending snapshot is retained. This prevents a burst from accumulating thousands of full snapshots in memory.

### Outbox delivery claims

Outbox messages now record:

- optional `idempotencyKey`
- `processingStartedAt`
- provider message ID
- retry and failure state

A freshly processing message is not picked up by the background dispatcher. It becomes retryable only after its processing lock is stale. This prevents the dispatcher from racing a normal in-flow send.

Migration `003_outbox_claims` adds the corresponding PostgreSQL columns and indexes.

### Import protection

Normal apply is safe for an empty database and idempotent for an identical snapshot:

```powershell
npm run db:migrate:apply
```

If PostgreSQL already contains a different snapshot, apply stops without changing it. Intentional replacement requires the explicit command:

```powershell
npm run db:migrate:force
```

Do not use force after PostgreSQL has become the active source unless the consequences have been reviewed.

### PostgreSQL to JSON rollback export

Export always requires an explicit output path and refuses to overwrite an existing file by default:

```powershell
npm run db:export -- --output ./data/contacts-from-postgres.json
```

The exported file must be verified before it replaces the active JSON storage file. Export does not modify PostgreSQL or the active JSON file.

## Tests

The following tests were added and executed against a local test-only PostgreSQL database:

- `npm run test:postgres-delta`
- `npm run test:outbox-claim`
- `npm run test:migration-safety`
- `npm run test:postgres-burst`

The burst test persisted 2,000 queued messages, verified both the relational table and compatible snapshot, and completed locally in approximately 4.2 seconds. This is a storage-layer test, not a Meta API throughput test.

Existing flow recovery, flow concurrency, timeout, and outbox durability tests also passed after the changes.

## Current timer model

Pending conversation state is durable and is restored after restart. Runtime timeout handles are recreated from the saved conversation timestamps.

The `scheduled_jobs` table exists, but there is not yet a distributed database scheduler that claims jobs across multiple application replicas. Current deployments must remain single-replica per customer.

## Remaining before customer cutover

1. Restore the R2 backup into a separate PostgreSQL database and verify counts and reports.
2. Run dry-run and import using a copy of the large customer's current JSON.
3. Decide between:
   - a short controlled cutover window; or
   - a separately implemented and tested JSON-primary shadow-write mode.
4. Verify final JSON/PostgreSQL counts immediately before enabling `DATABASE_URL`.
5. Deploy only the selected customer manually.
6. Verify `/health` and `/health.storage`, then run a complete test campaign.
7. Keep the original JSON and a PostgreSQL-to-JSON export during the acceptance period.

## Not implemented

- No Dokploy configuration or deployment.
- No automatic migration on application startup.
- No production database access.
- No multi-replica distributed timer worker.
- No JSON-primary shadow migration mode.

