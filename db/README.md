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

## Provisioning the organization and first members (`db/provision.ts`, #31)

Because RLS is forced on every table, the first organization and memberships are
created by a trusted operator, never by an API endpoint:

1. Invite each person in Clerk and copy their **Clerk user ID** (`user_…`, from the
   Clerk dashboard's Users page). Emails and names are rejected.
2. Copy `db/provision.example.json` to a file **outside the repo** and fill in the IDs
   and roles (`admin` or `board`; `"active": false` to deactivate). At least one
   active admin is required.
3. Run it with the privileged migration connection and the deployment's org ID:

```powershell
node --env-file-if-exists=.env db/provision.ts C:\path\to\roster.json
```

It needs `MIGRATION_DATABASE_URL` and `CIC_ORG_ID` (the same UUID the API uses). The run
is one transaction and safe to repeat: it creates or updates the organization name
and each listed membership's role and active flag, and prints counts only. People not
in the file are **left unchanged**, never deactivated implicitly. It refuses the runtime
login (any role that can `SET ROLE cic_runtime`; a migration owner that merely created
that role is fine), and it refuses any role that can't write under row-level security.
Invalid roster JSON gets a fixed message that never echoes the file. Never grant
BYPASSRLS to the runtime login to make provisioning work. Tests: `node --test tests/provision.test.ts`.

## Demo data (`db/seed-demo.ts`, #31)

For demos and local development only. After provisioning (it needs at least one active
**board** member), run:

```powershell
node --env-file-if-exists=.env db/seed-demo.ts --yes-demo-data
```

It inserts 3 programs, 5 campaigns, 26 fictional donors (`@example.org` emails,
`602-555-01xx` phones, `metadata.demo = true`) and 53 gifts from 2023 to 2026, with
deterministic IDs, in one transaction. Re-running inserts nothing. Donors are spread
round-robin across active board members. As of Nov 14, 2026 (YTD vs prior YTD), the
ledger covers every retention segment (new, reactivated, increased, flat, decreased,
lapsed, plus dormant). It also includes a fully refunded gift, pending gifts, gifts
with no campaign, three sources, and two foundations with program-restricted gifts
for the funder packet. It **refuses** to run against an organization that already has
any non-demo donor, and it refuses the runtime login. Tests: `node --test tests/seed-demo.test.ts`.
