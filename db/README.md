# Database foundation

Migration 010 adds admin-only approved aggregate program outcomes. Upload through
`POST /api/v1/reports/outcomes` with `{approved: true, outcomes: [...]}`; each row
contains `program_id`, `from`, `to` (exclusive Phoenix calendar end), `metric`,
`value`, `unit`, `denominator` and `source`. Null is not reported; zero is reported.
The same program/period/metric replaces its approved values and records a new audit
event. Batches are atomic. Funder JSON, CSV and print include overlapping approved
rows with their source, period, units, denominator and approval date.

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
deterministic per-organization IDs, in one transaction. Re-running inserts nothing. Donors are spread
round-robin across active board members. As of Nov 14, 2026 (YTD vs prior YTD), the
ledger covers every retention segment (new, reactivated, increased, flat, decreased,
lapsed, plus dormant). It also includes a fully refunded gift, pending gifts, gifts
with no campaign, three sources, and two foundations with program-restricted gifts
for the funder packet. For Outreach it adds a Q4 2026 quarterly touch per donor and six next
steps (two overdue, two due this week, two upcoming on Nov 15, 2026), each owned by the donor's owner. It **refuses** to run against an organization that already has
any non-demo donor, and it refuses the runtime login. Tests: `node --test tests/seed-demo.test.ts`.

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

## Outreach tables (`005_outreach.sql`, #47)

`follow_ups`, `drafts` and `communications` follow **donor visibility**: board
members see and act only on their own donors' rows; admins see the organization's.
Runtime has column-level grants and **no DELETE** on any of them.

- **`follow_ups`:**
  - New tasks belong to the donor's current owner.
  - Quarterly touches are unique per donor and quarter. Generate them with
    `ON CONFLICT (org_id, donor_id, quarter) WHERE kind = 'quarterly' DO NOTHING`.
  - `completed_by` must be the acting member.
  - Runtime cannot change `owner_id`; moving open tasks on reassignment is a core
    follow-up to `reassign_donor`.
- **`drafts`:** a non-draft status always carries an `approval_hash`. A trigger drops
  the approval whenever `subject` or `body` changes, and refuses any change once a
  draft is `sent` or `logged`. Runtime cannot change `recipient` or `channel`.
- **`communications`:** insert-only, written by the acting member.
  - A unique index allows only one delivered or manually logged record per approval
    hash, so a double send fails.
  - A failed delivery can never be `qualifying`.

Rules for queues and messages live in `packages/outreach`. Tests: `node --test tests/outreach-db.test.ts`.

## Import staging (`006_import_review.sql`)

`import_batches` is restricted to the current organization's admins. File bytes
are bounded to 4 MiB; one active batch per organization/file SHA prevents replay
through a changed source label. Creator, organization and file identity are immutable
to the runtime role. Committing or abandoning requires purging bytes, layout and
decisions; terminal rows cannot reopen. Minimal hashes/results remain for safe retries.
Gift source-row provenance is unique per organization even across owner visibility.
Existing duplicate provenance aborts the migration; it never deletes history.
This migration adds storage, not an import HTTP endpoint. Tests: `node --test tests/import-ledger.test.ts`.

`007_owner_followups.sql` extends the admin-only reassignment function: only open
follow-ups move with the donor; completed history keeps its prior owner. The
assignment role receives only org-scoped follow-up reads and `owner_id` updates.
Runtime cannot change task ownership directly. A failed task update rolls back
the donor update and audit together. Tests: `node --test tests/owner-followups.test.ts`.

`008_import_provenance_uuid.sql` compares gift provenance batch IDs as UUIDs,
so uppercase and lowercase UUID aliases cannot bypass uniqueness across owners.
Organization scope and exact row keys remain distinct. Historical aliases abort
the transaction, preserving both gifts and the prior index for operator review;
the migration never deletes history. Tests: `node --test tests/import-provenance-uuid.test.ts`.
