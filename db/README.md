# Database foundation

Apply pending migrations to a fresh PostgreSQL database using a privileged
migration connection, never the API runtime connection:

```powershell
node --env-file-if-exists=.env db/migrate.ts
node --test tests/core-schema.test.mjs
node --test tests/migrate.test.ts
```

Tests execute PostgreSQL through PGlite in memory, including the migration,
RLS, runtime permissions, transaction rollback, source identity and financial
constraints. They do not provision or verify Neon. `npm ci` installs the test
dependency. PGlite is a development dependency, not the application database.

The runner serializes migration clients with a session advisory lock and records
filenames/checksums in `schema_migrations`. Each migration and its ledger entry
commit together. Repeat runs skip applied SQL; modified/missing applied files or
older pending versions fail. Migration files must use `NNN_name.sql` and wrap
their SQL in `BEGIN;` / `COMMIT;`; the runner owns the actual transaction.
Do not manually apply SQL then run the ledger against that existing database:
there is no automatic history adoption. Review an adoption procedure or recreate
only a disposable development database. Hosted migrations use a direct TLS
connection; application runtime uses a separate restricted pooled connection.

The migration creates `cic_runtime` as a restricted NOLOGIN/NOBYPASSRLS role.
An operator must create a separate non-owner application login and grant it
membership in `cic_runtime`. The API must use that login, begin a transaction,
`SET LOCAL ROLE cic_runtime`, and parameterize transaction-local `app.org_id`
and `app.user_id` (verified Clerk subject) before any data operation. Never
derive these settings from an unverified request body or token.

All tables force RLS, including for their owner. Initial organization/member
bootstrap therefore requires a trusted provisioning operation; no public
signup, bootstrap endpoint or seed operation is included in this slice.
Do not grant BYPASSRLS or table ownership to the runtime login to bootstrap.

Runtime updates cannot change donor ownership or financial provenance.
Admin reassignment and automatic assignment need separately reviewed scoped
functions. Application services must pair mutations with audit inserts in the
same transaction; database grants alone do not supply that service workflow.
Communications/follow-ups and import staging remain their owners' later slices.

## Dashboard API keys (`004_reporting_api.sql`, #29)

- **`api_keys`** stores only a SHA-256 `key_hash`, a short `hint`, `scopes`
  (`read:aggregates`) and `revoked_at`.
  - Admins create and revoke keys through `cic_runtime`.
  - Revocation is one-way, and there's no delete.
  - **Runtime can never select `key_hash`.**
- **`cic_reporting`** is a non-login definer role.
  - The migration fails if it already exists with unsafe attributes or memberships.
  - Its column grants exclude every donor contact field.
- It owns three functions, executable only by `cic_runtime`:
  - `cic_reporting_gifts(key_hash, from, to)` (window ≤ 1830 days)
  - `cic_reporting_recent(key_hash, limit 1-100)`
  - `cic_reporting_programs(key_hash)`

  Each resolves the organization from an active key with the right scope, returns that
  org's non-void gift rows (internal UUIDs and amounts only), and raises `Invalid API
  key` otherwise.
- The API turns those rows into suppressed aggregates with `packages/reporting/summary.ts`;
  per-gift rows never leave the server. Tests: `node --test tests/reporting-api.test.ts`.
