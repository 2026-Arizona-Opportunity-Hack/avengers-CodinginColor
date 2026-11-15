# Core API foundation

Requires Node 24+, `npm ci`, a migrated PostgreSQL database and Clerk instance.
Copy root `.env.example` to `.env` and supply actual values privately. Configure
`CIC_ORG_ID` to CIC's database organization UUID; callers cannot choose an org.
`DATABASE_URL` must use a restricted login granted `cic_runtime`, never the
migration owner. Provision an active membership matching each invited Clerk user
subject using an administrative connection. There is no public sign-up endpoint.

Run `npm run start:api`, `npm run typecheck`, and `npm run test:api`.
The start command loads `.env` when present; deployments may inject all required
environment variables without creating a file. Configuration validation still
rejects missing or invalid values. Public `GET /healthz` returns
`{"status":"ok"}` without authenticating or connecting to PostgreSQL. This is
process liveness, not proof that Clerk or the database is configured or reachable.
`GET /api/v1/me` takes `Authorization: Bearer <Clerk session token>` and returns
only `{id, org_id, role}`. Missing/invalid sessions get 401, disallowed origins or
memberships get 403, and dependency failures get 503 without underlying messages.
Only exact `APP_ORIGIN` is allowed by CORS. Configure invitation-only registration
in Clerk; require verified primary email and MFA for admins. Each request verifies
the signed token's issuer/authorized party, checks the live session and user, and
checks current database membership. Admin tokens must contain a verified second
factor (`fva[1] >= 0`); MFA enrollment alone grants no access.

Database context and runtime role are transaction-local; failed transactions roll
back, and failed rollback destroys the pooled connection. Tests stub Clerk and include HTTP requests against PGlite with the migration and
restricted role; they do not prove live provider configuration or Neon connectivity.

Authenticated `GET /api/v1/donors` lists donors with optional `q`, `owner_id`,
`archived=true|false` (default `false`), `limit` (1-100, default 25), and
`offset` (default 0). Results are ordered by name then ID and include `items`,
`limit`, and `offset`. `GET /api/v1/donors/:id` returns one donor, including
archived records. Board members see only their own donors; admins see their
organization's.
`POST /api/v1/donors` creates a donor from `name`, optional `email` and `phone`,
required `consent`, and optional `metadata`, returning 201 with exactly
`{id, owner_id}`. The scoped assignment function picks the owner, so a creator
who is not the owner cannot read the new row; no name, email, contact or other
donor fields are returned. Non-members get 403 and an organization with no
eligible board owner gets 409 without creating a donor or audit row.
`PATCH /api/v1/donors/:id` accepts a nonempty subset of name, email, phone,
consent, and metadata; ownership is not accepted there.
`POST /api/v1/donors/:id/owner` reassigns a donor to a board member of the same
organization, returns 200 with exactly `{id, owner_id}`, and is admin-only (403
otherwise); an unknown donor returns 404 and an ineligible owner returns 409.
`POST /api/v1/donors/:id/archive` archives
without deleting gifts. Creates, updates, reassignments, and archives record an
audit event inside the same transaction. Inaccessible donors return 404.

Historical gifts form their own ledger, separate from communications and
follow-ups. Authenticated `GET /api/v1/gifts?donor_id=<uuid>` requires a strict
donor UUID plus `limit` (1-100, default 50) and `offset`, returns
`{items, limit, offset}` ordered by `occurred_at` then `id`, includes archived
donors' history, and returns 404 when the donor is not visible. Amounts are exact
safe-integer cents and timestamps keep PostgreSQL microsecond precision.
`POST /api/v1/gifts` accepts donor, campaign (nullable), amount, refund,
currency, occurred_at, status and optional `external_id`; the server forces
`source='manual'` and `source_row=null` and rejects provenance, org, owner, role
or id fields. Campaigns must belong to the organization. Insert returns 201 and
audits `gift.insert` in the same transaction; an identical replay of the same
caller's `external_id` returns 200 without a new audit, differing facts return
409 for explicit correction, and another owner's identity
returns 409 without disclosing data. Equal gifts without `external_id` stay
separate records. `PATCH /api/v1/gifts/:id` accepts a nonempty subset of campaign,
amount, refund, currency, occurred_at and status, merges the stored record under a
row lock, revalidates, and audits `gift.correct` atomically; identity and
provenance cannot be rewritten. Gifts are never hard-deleted.

