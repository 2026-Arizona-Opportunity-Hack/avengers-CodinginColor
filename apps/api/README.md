# Core API foundation

`POST /api/v1/ask-data` accepts only `{question}` (1–500 characters) and requires a member session.
Supported intent includes visible/my donors; new/reactivated/increased/flat/decreased/lapsed/retained;
settled/pending/void gifts; this/last year; USD/EUR/GBP/CAD/AUD/JPY; and strict “over” net thresholds.
USD and current Phoenix year are explicit defaults. Unknown terms clarify instead of broadening.
Results are bounded to 50 and RLS-scoped; no SQL or writes come from the model. The optional
shared `OPENAI_*` adapter receives typed nonpersonal filters only and has a deterministic fallback.

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
Only exact `APP_ORIGIN` is allowed by CORS. Summary/activity preflights also allow
`X-API-Key`; the request still requires a valid scoped read API key.
Configure invitation-only registration
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
Optional UUID `request_id` makes manual creation retry-safe: the same organization,
actor, request and exact normalized facts return the original IDs with 200. Changed
facts with a reused key return 409. Creation, assignment, audit and the replay
receipt commit together. Existing callers without a key still create normally.
`PATCH /api/v1/donors/:id` accepts a nonempty subset of name, email, phone,
consent, and metadata; ownership is not accepted there.
`POST /api/v1/donors/:id/owner` reassigns a donor to a board member of the same
organization, returns 200 with exactly `{id, owner_id}`, and is admin-only (403
otherwise); an unknown donor returns 404 and an ineligible owner returns 409.
`POST /api/v1/donors/:id/archive` archives
without deleting gifts. Creates, updates, reassignments, and archives record an
audit event inside the same transaction. Inaccessible donors return 404.

Historical gifts form their own ledger, separate from communications and
follow-ups. Authenticated `GET /api/v1/gifts?donor_id=<uuid>` accepts an optional
strict donor UUID plus `limit` (1-100, default 50) and `offset`, returns
`{items, limit, offset}` ordered by `occurred_at` then `id`, includes archived
donors' history, and returns 404 when the donor is not visible. Amounts are exact
safe-integer cents and timestamps keep PostgreSQL microsecond precision.
Without donor_id it returns the member's visible gift ledger under RLS.
`GET /api/v1/catalog` returns same-org program/campaign labels for authenticated
members. `GET /api/v1/communications?limit=100&offset=0` pages the visible donors'
contact history, including approved draft links and actual status. Both endpoints
enforce active membership, organization and the admin MFA requirement.
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

Import staging requires an active admin with verified MFA. `POST /api/v1/imports`
accepts raw UTF-8 `text/csv` or original `.xlsx` bytes with MIME
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, up to 4 MiB,
with `X-Import-Source` and basename-only
`X-Import-Filename`. The server computes the file hash and batch UUID; exact replay
resumes the existing batch and changing its source label gives409. Staging writes
no donor or gift rows. `POST /:batchId/layout` accepts reviewed column mapping,
explicit batch financial metadata and optional paired date-format/UTC-offset.
`GET /:batchId` returns a summary; `GET /:batchId/rows?kind=preview|donor|gift`
returns bounded pages. `POST /:batchId/abandon` irreversibly purges staged bytes
and layout. All routes are under `/api/v1/imports`, enforced by membership and
database RLS; foreign batches are404. Stage/layout/abandon are audited atomically.
Malformed batch path UUIDs also return404 `import_not_found` after authorization.
Blank or duplicate CSV headers return400 `invalid_csv`; invalid column mappings
and decision body IDs remain400 `invalid_mapping` and `invalid_decision` respectively.
Review uses two phases: `POST /:id/donors/plan`, then `/donors/review` with
`{plan_hash,decisions}`; after donors are ready, `/gifts/plan`, then `/gifts/review`
with `{donor_plan_hash,plan_hash,decisions}`. Decisions contain kind, row, action
and the applicable donor/gift ID only. The server binds reviewer identity and
rebuilds from fresh scoped facts. Stale plans return409 with a fresh hash; layout
changes invalidate both phases. `GET /:id/plan/rows?kind=donor|gift` returns bounded
review rows and authorized candidates. Each review request REPLACES the complete
decision set for that phase: send all saved decisions, not only the current page.
Review never writes donors/gifts. Commit
is explicit: `POST /:id/commit` accepts only `{donor_plan_hash,plan_hash}`. It
serializes imports per org, locks current donor/gift facts, rebuilds both plans,
applies assigned donors then gifts, audits and saves the result in one transaction.
Stale facts return409; a dependency/audit failure returns503 and rolls everything
back. Identical retries/re-uploads return the saved result with `replayed:true`.
Raw bytes, layout and decisions are purged on success. Excluded CSV records require
explicit `layout.skip_records:[recordNumber,...]` before review; otherwise commit
fails400. Their validation issues are available on preview row pages. No financial
defaults or client-supplied write operations are accepted. XLSX uses the reviewed
bounded parser and stages its validated cells as CSV, with the original workbook's
fingerprint retained for replay. The normalized CSV must also fit 4 MiB. One visible
sheet is supported; formulas, macros, unsafe archives and numeric date cells are
rejected. Enter workbook dates as text and review their format/timezone. Invalid
workbooks return400 `invalid_xlsx`, oversized input returns413, and wrong MIME or
extension returns415. The UI must wire these server routes.

`tests/import-native.test.ts` provides optional real-PostgreSQL concurrency proof
using `CIC_NATIVE_TEST_URL`. It accepts only an empty disposable loopback database
named `cic_native_<hex>` and creates synthetic test data. It checks overlapping
commit retries and competing-file staleness; it must never target a live database.

Admin/MFA-only `GET /api/v1/members` lists same-org membership IDs, Clerk subjects,
roles and activity. `POST` accepts `{clerk_subject,role,active}` for an existing
Clerk user with a verified primary email. `PATCH /:id` changes `{role,active}`.
Self-admin removal, last-admin removal and making an active donor owner ineligible
return409; reassign the portfolio first. Unknown/foreign IDs return404. Changes
and audit events commit together; Clerk invitations remain a separate workflow.

<<<<<<< HEAD
Optional AI suggestions use server-only OPENAI_BASE_URL, OPENAI_API_KEY and
OPENAI_MODEL. Missing key/model, timeout or invalid output uses deterministic
templates. Grounded update proposals expose only synthetic fact categories to the
provider; donor details, gift amounts and outcome text stay local. Reviewed drafts
remain unapproved until the existing exact-content approval flow is completed.
=======
Admin/MFA `POST /api/v1/invitations` accepts `{request_id,email,role?}` (default
board), saves role intent, then sends one Clerk invitation outside SQL. Identical
sent retries return200 without another email. Failed/queued delivery never grants
access; explicit retry of a failed request may send again. Ten attempts per admin
per hour are allowed. GET lists up to200; POST `/:id/revoke` closes database intent
before provider cleanup. Only sent/unexpired intent may be claimed from a verified
primary Clerk email at /me. Existing inactive memberships stay inactive. Roles
never come from client email, query parameters or Clerk public metadata.
>>>>>>> c187e75 (Send staff invitations only after persisting reviewed access intent)
