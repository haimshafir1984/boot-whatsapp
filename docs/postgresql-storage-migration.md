# PostgreSQL storage migration

Updated: 2026-07-22

## Safety model

PostgreSQL is opt-in for existing clients. Existing clients keep using JSON storage unless `DATABASE_URL` is set for that specific deployment.

New Dokploy clients created through the owner dashboard are PostgreSQL-first: provisioning creates a dedicated PostgreSQL service for that client, stores its Dokploy metadata in owner storage, and injects `DATABASE_URL` into the new application environment before the first application deployment.

If `DATABASE_URL` is set and PostgreSQL is unreachable, startup fails. The app must not silently fall back to JSON because that can split data between two stores.

Media files stay in the existing filesystem/Volume. PostgreSQL stores file metadata and paths only.

## Environment

```env
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DATABASE
```

Do not commit real database URLs, passwords, tokens, or customer data.

## Local test database

Example local test URL:

```env
DATABASE_URL=postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test
```

## Migrations and import

Dry-run is the default. It verifies database migrations and reports JSON counts without importing JSON data:

```powershell
$env:DATABASE_URL="postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test"
npm run db:migrate
```

Apply imports the current JSON snapshot idempotently into PostgreSQL:

```powershell
$env:DATABASE_URL="postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test"
npm run db:migrate:apply
```

The import reads `STORAGE_PATH` and does not modify or delete the JSON file.

## Tables

The first migration creates:

- `schema_migrations`
- `app_state` for the full compatible storage snapshot
- `admin_settings`
- `client_profile`
- `campaigns`
- `campaign_results`
- `campaign_events`
- `contact_queue`
- `saved_contacts`
- `uploaded_files`
- `twilio_templates`

Indexes cover campaign IDs, phones, pending/status fields, queue schedule time, dedupe keys, and trigger phrases.

## Per-client rollout

1. Create a PostgreSQL database for one client.
2. Set `DATABASE_URL` only on that client's deployment.
3. Run `npm run db:migrate` and review counts.
4. Run `npm run db:migrate:apply` once approved.
5. Deploy that client manually.
6. Check `/health`; `storage.enabled` should be `true`, `storage.ready` should be `true`.
7. Keep the JSON files for rollback until the migration is accepted.

## Rollback

If PostgreSQL has received any production writes, export its latest compatible snapshot before removing `DATABASE_URL`:

```powershell
npm run db:export -- --output ./data/contacts-from-postgres.json
```

Verify the exported counts and keep a copy of the existing JSON. Replace the active JSON only during an approved rollback procedure, then remove `DATABASE_URL` and redeploy manually. Removing `DATABASE_URL` without exporting/reconciling first would return the application to stale JSON data.

## Dokploy

New clients created through the owner dashboard get a dedicated Dokploy PostgreSQL service automatically. The provisioner creates PostgreSQL, requests its deployment, stores the generated connection metadata with the managed client record, and saves `DATABASE_URL` into the application environment before the first app deployment.

Existing clients are still migrated manually per client. If an existing Dokploy application has no PostgreSQL metadata in owner storage, provisioning refuses to redeploy it instead of creating a blank database or overwriting a manually configured `DATABASE_URL`. Finish the controlled migration and record the metadata before managing that client through provisioning again.

Migration scripts do not create Dokploy resources. They only operate against the `DATABASE_URL` supplied to the app/container.
