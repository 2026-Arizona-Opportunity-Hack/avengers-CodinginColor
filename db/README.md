# Database foundation

Apply `migrations/001_core.sql` once to a fresh PostgreSQL database using a
privileged migration connection, never the API runtime connection:

```powershell
psql "$env:MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_core.sql
node --test tests/core-schema.test.mjs
```

Tests execute PostgreSQL through PGlite in memory, including the migration,
RLS, runtime permissions, transaction rollback, source identity and financial
constraints. They do not provision or verify Neon. `npm ci` installs the test
dependency. PGlite is a development dependency, not the application database.

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
