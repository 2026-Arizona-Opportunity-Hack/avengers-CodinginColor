# avengers — Coding in Color

The live **Ask your data** screen finds authorized active donors by retention, gift status,
currency and net giving threshold. It explains its filters, asks for clarification on unsupported
wording, and works without model keys. Questions and donor records never go to the optional model.

Built at [ASU Fall Hackathon 2026 | Phoenix Hackathon for Nonprofits: Nov 14-15](https://www.ohack.dev/hack/fall-2026) for the public good (MIT license).

> **⚠️ This is your team's ONE repository — all code goes here.** Please don't create
> another repo (personal or org). Judges, the Team Dashboard's code-activity card,
> the public project page and the nonprofit all read **this** repo; work pushed
> anywhere else is invisible to them and won't count. Everyone on the team should be
> a collaborator here — ask an organizer in Slack if someone can't push.

| | |
|---|---|
| **Nonprofit** | [Coding in Color](https://www.ohack.dev/nonprofit/YIXYdYCoxIZC08uQ5DL3) |
| **Problem statement** | [Donor & Funder Relationship Platform (CIC Problem 2)](https://www.ohack.dev/project/e26932c0df1b11f189a8dead68f07eb5) |
| **Team page** | [avengers](https://www.ohack.dev/hack/fall-2026/team/959f5c24e05811f1adacdeadb145c312) · [Team Dashboard](https://www.ohack.dev/hack/fall-2026/manageteam) (story, demo video, submit) |
| **Slack** | team: [#avengers](https://opportunity-hack.slack.com/app_redirect?channel=avengers) · nonprofit: [#npo-coding-in-color](https://opportunity-hack.slack.com/app_redirect?channel=npo-coding-in-color) · help: [#ask-a-mentor](https://opportunity-hack.slack.com/archives/C01E5CGDQ74) |
| **Created by** | Greg V [Staff/Mentor] |

## Final day

Start recording your demo video by **Sun Nov 15, 12:00 PM MST** — hacking ends at **Sun Nov 15, 2:00 PM MST**, and a demo you recorded with time to spare beats a feature you finished at 1:59.

- Sun Nov 15, 11:00 AM MST — Presentation Feedback Hour
- **Sun Nov 15, 12:00 PM MST — Start recording your demo video**
- Sun Nov 15, 12:30 PM MST — Judges Arrive
- **Sun Nov 15, 2:00 PM MST — 🛑 Submission Deadline: Hacking ends**
- Sun Nov 15, 2:05 PM MST — Judging Round 1
- Sun Nov 15, 3:40 PM MST — Judging Final Round
- Sun Nov 15, 4:30 PM MST — Closing Ceremony: Winners Announced

## Before hacking ends — the submission checklist

Everything is submitted from your [Team Dashboard](https://www.ohack.dev/hack/fall-2026/manageteam); judges read the dashboard, this README and your demo video.

- [ ] **Code pushed** to this repo, in small PRs (see `AGENTS.md`) — judges and future recruiters read the history
- [ ] **Project story** written on the dashboard (`#project`): the problem, who it helps, what you built, what's next
- [ ] **Demo video** (4 minutes or less) on YouTube, Vimeo, Loom or Google Drive, linked on the dashboard (`#demo`) — show it working, not slides
- [ ] **Submit** on the dashboard (you can keep editing until the close)
- [ ] This README filled in below: team, tech stack, how to run it, live link if you have one
- Optional: a [DevPost entry](https://opportunity-hack-2026-arizona.devpost.com/) — the dashboard is the submission of record.

Judges score **Scope, Documentation, Polish and Security**, plus a separate **Accessibility** prize — the rubric is at [ohack.dev/hackathon-judging-criteria](https://www.ohack.dev/hackathon-judging-criteria). Document your work as GitHub Issues as you go: that's how you get public credit for it.

## Team

- [Ash](https://github.com/ashworks1706) — UI and shared visual components (Person 3)
- [Ibrahim Ali](https://github.com/ibrahim-alii) — core backend (Person 2)
- [Aayan Mapara](https://github.com/amapara27) — data ingestion and reconciliation (Person 1)
- [Soumya Mejari](https://github.com/smejari1) — outreach and follow-ups (Person 4)
- [Nathan Narrik](https://github.com/nathannarik) — reporting, deployment and integration QA (Person 5)

## What we built

Coding in Color keeps its donors in spreadsheets and platform exports (Zeffy, Benevity, AZ Gives), and
follow-ups live in people's heads. **Coding in Color** gives the CEO and the board one place to see every
donor and gift, know who owns each relationship, and keep the next touch from slipping. It also
produces the funder report CIC needs, without re-keying anything.

What's built on `main` (API, database and rules):
- **Import:** CSV exports are uploaded privately, mapped and validated. Dates are confirmed, never
  guessed, and cents are exact. An admin reviews each import before an atomic commit, and
  re-importing the same file adds no duplicate gifts (`apps/api/imports.ts`). XLSX uploads use the
  same reviewed API flow, with bounded workbook parsing and original-file fingerprints (#105).
- **Donors and gifts:** one record per donor with an owner, a gift ledger with audited corrections,
  and admin reassignment that moves open follow-ups along with the donor.
  The live Donations screen keeps currencies separate and limits CSV download to admins.
  Archived donors retain their gift/contact history; donor records show separate donation history,
  communications and future-task sections.
- **Follow-ups:** a queue of overdue, this-week and upcoming items, plus one quarterly touch per
  donor. Messages are drafted from templates and need human approval, then go out from the
  person's own email or phone and are logged once. Nothing is sent automatically.
- **Reporting:** a retention breakdown (new, reactivated, increased, flat, decreased, lapsed), scoped
  to each member's own donors, and an admin-only, audited funder packet CSV from the API. A
  read-only, hashed API key gives CIC's dashboard aggregate totals, and that summary API hides any
  group smaller than three donors.
- **Security:** invite-only Clerk sign-in, MFA required for admins, PostgreSQL row-level security
  (board members see only their own donors), and audit events for changes, sends and exports.

The live web screens now connect imports, donor/gift history and entry, follow-ups,
retention, audited funder exports and staff settings to these APIs. Automated tests
cover the integrated workflows; a deployed signed-in rehearsal remains the release
gate in #30. Demo mode uses synthetic browser data and does not prove persistence
or deployed authorization.

Project requirements and delivery roles: [CIC Donor Platform Implementation Plan](CIC_Donor_Platform_Implementation_Plan.pdf).

Campaign and contact-person values require explicit alias choices in live import review. Choose
a stored campaign or leave the gift unattributed; choose an active board member for new donors
or automatic assignment. Linked existing donors retain their owner. Unresolved aliases remain
excluded for explicit review, and stale/foreign alias IDs are rejected before persistence.

Unmapped headers can request optional Jev suggestions. Only the selected header leaves the server;
the reviewer must explicitly accept a suggestion and apply the mapping. Without a configured key
or when the provider is unavailable, deterministic aliases and manual mapping continue to work.

The live admin Import screen uses the API for upload, mapping, donor/gift review
and atomic commit. It requires explicit status/refund and missing date/currency
facts, acknowledges invalid records, and separates source totals from canonical
changes by currency. [Local synthetic UI preview](docs/screenshots/live-import-review.png)
uses synthetic review state; deployed signed-in acceptance remains pending.

## Tech stack

- Frontend: Angular 22 web app in [`apps/web`](apps/web/README.md). It runs on built-in sample data until a `config.json` points it at the API.
- Backend: Node.js 24.15+ with TypeScript run directly by Node, Express 5, and Zod validation shared through `packages/contracts`.
- Database: PostgreSQL 16+ (Neon in production). Row-level security scopes every query to the signed-in member's organization and, for board members, to their own donors.
- APIs / services: Clerk for invite-only sign-in. Tests run real migrations on in-memory PostgreSQL (PGlite); no live service or credentials are needed.

## Run it locally

Administrators can use the live Funder reports screen to select a donor, program
and inclusive calendar range, inspect the server packet, then download its audited
CSV or print it. Gift totals stay separated by currency and attribution. Until
approved outcomes are uploaded, reports explicitly show that outcome data is
unavailable.

Retention accepts optional `from`, `programId`, `ownerId`, `campaignId` and
`cohort` (acquisition year) filters alongside inclusive `asOf`. Dates compare
matched Phoenix calendar windows within one year. Cohort is the donor's first
positive settled gift year across their visible history, before campaign/program
narrowing. Every filter intersects the caller's existing organization/owner scope.

Live administrators can reassign a donor to any active same-organization board
member, including members without donors. Assignment and open-task transfer remain
server-controlled and audited; board members cannot list other eligible owners.

Live donor views load their scoped gift and contact history from the API. Logging
a call, text, email or meeting persists a real communication and refreshes the queue;
giving summaries separate currencies using the workspace currency selector.

Live workspaces load the server-scoped follow-up queue and drafts. Administrators
can issue and revoke real aggregate API keys from **Read API**; the secret is shown
once and is never stored in the browser dataset. Other live workflows remain
tracked separately; demo actions do not persist to the server.
**Follow-ups** now saves tasks and drafts to the API, checks exact-message approval
and consent before opening email/SMS, and records a manual send only after the
person selects **I sent it**. A logged contact closes the matching quarterly touch.

Tests and checks need no accounts or keys:

```bash
git clone https://github.com/2026-Arizona-Opportunity-Hack/avengers-CodinginColor.git
cd avengers-CodinginColor
npm ci
npm run typecheck
npm run test:contracts
npm run test:api
node --test tests/*.test.ts tests/*.test.mjs packages/reporting/*.test.ts packages/outreach/*.test.ts
```

Running the API against a real database and Clerk instance:

```bash
cp .env.example .env   # fill in your own values — never commit .env
node --env-file-if-exists=.env db/migrate.ts   # uses MIGRATION_DATABASE_URL
npm run start:api                             # GET /healthz should return {"status":"ok"}
```

Database setup (the two logins, provisioning the organization and members) and hosting
are covered step by step in the deploy runbook, `docs/DEPLOY.md` (#42).

## Links

- Deployment setup: [Vercel runbook](docs/DEPLOY.md). The repository pins Express and Node 24, validates runtime settings before building, and generates same-origin frontend configuration.
- Live demo: [cadence-cic.vercel.app](https://cadence-cic.vercel.app). This is the web app on sample data only, with no backend. The full-stack deploy is tracked in #30.
- Demo video:
- Design / docs: [implementation plan](CIC_Donor_Platform_Implementation_Plan.pdf), [API](apps/api/README.md), [database](db/README.md), [reporting](packages/reporting/README.md), [outreach](packages/outreach/README.md), [web app](apps/web/README.md), [deploy runbook](docs/DEPLOY.md)

## CSV import preflight

Requires Node.js 24.15 or newer. Install the shared contract's locked dependencies;
no credentials are needed.

```bash
npm ci
node tools/import-preview.ts spreadsheet data/cic_donor_spreadsheet.csv
node tools/import-preview.ts zeffy data/zeffy_export.csv
node tools/import-preview.ts benevity data/benevity_export.csv
node tools/import-preview.ts az_gives apps/web/public/samples/az_gives_export.csv \
  --date-format MM/DD/YYYY --utc-offset -07:00
node --test tests/import-preview.test.ts tests/import-mapping.test.ts
```

The CLI prints row counts and issue categories without donor contact details.
Exit code 0 means the preview ran, not that rows are approved; unreadable or
malformed files exit 1. Input must be UTF-8 CSV, at most 5 MiB. Unknown headers,
invalid amounts/contacts, formulas and uneven rows require human review.
Blank data records are retained and flagged. Source labels identify provenance
(`spreadsheet`, `zeffy`, `benevity`, `az_gives`, `united_way`); these illustrative
CSVs do not establish real Zeffy/Benevity export formats.

AZ Gives headers are recognized (`donor first`, `donor last`, `donor email address`,
`mobile #`, `employer name`, `gift amt`, `board contact`, `designation`,
`donation date`), but a bare `04/07/2026` is never guessed. A reviewer confirms the
date interpretation explicitly: `--date-format MM/DD/YYYY|DD/MM/YYYY|YYYY-MM-DD`
paired with `--utc-offset ±HH:MM`. Only exact matches on real calendar dates
become `YYYY-MM-DDT00:00:00±HH:MM`; other shapes stay `invalid_occurred_at` review
issues. The flags may appear anywhere after the source and file, and always
require both values.

All supplied samples lack currency, and the AZ Gives sample's dates stay unconfirmed
until a reviewer passes both date flags, so every preview remains `needs_review`.
External transaction IDs are optional in
the backend baseline; reimport safety still needs reconciliation logic.
Phone formatting is normalized without guessing a country; contact-person names
do not assign owners. Local review helpers and the CSV import API are described
below; XLSX upload still needs a backend integration.

For ambiguous headers, pass an optional JSON mapping file as the final argument:
`node tools/import-preview.ts spreadsheet export.csv mapping.json`.
Keys must exactly match source headers. Targets are `first_name`, `last_name`,
`email`, `phone`, `company`, `contact_person`, `campaign`, `occurred_at`,
`currency`, `external_id`, `amount_decimal`, `amount_cents`, `status`,
`refund_decimal`, or `refund_cents`; null explicitly
ignores a column while retaining its raw cells. Unknown targets/headers and
multiple columns targeting the same field are rejected.

`node tools/import-xlsx.ts <source> <file.xlsx> [mapping.json] [--date-format FMT --utc-offset ±HH:MM]`
previews a limited `.xlsx` by converting it to CSV text for the same validation
(counts only; errors contain no cell values). Accepted: one visible
worksheet, at most 5 MiB, 256 entries, 8 MiB per entry / 16 MiB inflated, 20,001
rows by 200 columns, ordinary ZIP archives, text/number cells (numbers stay exact text).
Physical blank rows and row numbers are retained for review/provenance. Rejected:
formulas, date-formatted cells (enter dates as text and confirm the format),
hidden/multiple sheets, DOCTYPE/ENTITY XML, duplicate, truncated or malformed archive
entries, and ZIP64. Text dates require a reviewer-selected format and fixed UTC offset;
Excel date serials are unsupported because their timezone cannot be inferred.
This is not full Excel support.

`node tools/import-drafts.ts <source> <file.csv|file.xlsx> --mapping mapping.json
--currency USD --status settled --refund-cents 0 --occurred-at 2026-11-15T12:00:00Z`
passes explicit mappings and reviewer facts into the shared draft/review pipeline;
`--mapping` is optional and confirmed dates use `--date-format` plus `--utc-offset`.
Its output contains counts only. Missing financial facts stay unresolved. Excluded
record numbers remain available in the returned drafts for the API's `skip_records`.

For optional TypeSafe Jev suggestions, set `TYPESAFE_API_KEY` and run
`node tools/import-suggest.ts <source> <file.csv>`. `JEV_API_KEY` is a legacy fallback.
The client calls only `https://api.typesafe.ai/v1/systemone` with `jev-latest`;
known mappings are resolved locally, and only unknown header names are sent.
No donor row or sample value is sent. All suggestions require human approval;
write approved choices to a mapping JSON file before preview or draft creation.
This command makes a paid API request for each unknown header, so run it only
when you choose to use the service.

The five accepted source labels (`spreadsheet`, `zeffy`, `benevity`, `az_gives`,
`united_way`) identify provenance. They are not verified provider-specific adapters;
real export schemas, timezones and status/refund meanings remain unverified.
The live `/api/v1/imports` upload accepts raw CSV with
`Content-Type: text/csv; charset=utf-8` and original `.xlsx` bytes with
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. Both require
an admin with MFA, `X-Import-Source`, `X-Import-Filename` and a file up to 4 MiB.
XLSX uses the reviewed parser, stages validated cells for the existing two-phase
review and atomic commit, and retains the original workbook fingerprint for safe
reimport. Only one visible worksheet is supported; macros, formulas, unsafe ZIPs
and numeric date cells are rejected. Converted staging data must also fit 4 MiB.
The live import screen remains a separate integration task.

```json
{"Contribution Value":"amount_decimal","When Received":"occurred_at","Money Code":"currency","Unused":null}
```

`amount_decimal` consumes major units (12.34 becomes 1234 cents); `amount_cents`
consumes integers already in cents (1234 stays 1234). The known `donation amount`
header uses decimal units; `amount_cents` uses integer cents. Gift timestamps
require real calendar dates and explicit timezones. Currency codes are uppercased
then validated, together with timestamps and optional external IDs, using the
shared schemas from contract PR #8. Missing/invalid facts remain review issues.
Mappings are explicit input choices, not final approval: previews still report
`needs_review`, and donor IDs, refunds, gift status and persistence are not inferred.

Refund mappings follow the same unit rule: `refund_decimal` and the known
`refunded amount` header consume major units, while `refund_cents` consumes integer
cents. Mapped statuses must be `settled`, `pending` or `void` (case-insensitive).
Invalid/missing mapped facts and refunds exceeding gift amounts require review.
Batch status/refund values are only requested when those columns are unmapped;
they never replace the financial facts in a mapped row.

## Reconciliation planning (Data)

`tools/import-reconcile.ts` exports `planDonorMatches(orgId, drafts, existing)` and
`planGiftChanges(orgId, drafts, existing)` for reviewed canonical drafts. They
validate with shared schemas and return one decision per input row (zero-based),
including candidate IDs/row references and a reason. All plans remain
`needs_review`; they do not write, authorize, assign owners or create IDs.

Donor links require a unique email with matching name and no contact conflicts.
Shared contacts, archived donors, phone/name-only matches and repeated new-donor
drafts require review. Gifts match source/external ID and batch/row provenance
independently; disagreement requires review. Exact replays are distinguished from changed facts;
different same-source IDs preserve legitimate repeated gifts. Cross-source
overlaps and gifts without transaction identity require review, never silent
deduplication by amount/date/name. A no-ID gift matching an earlier batch's
same-source gift is reviewed as `possible_file_replay`, because a re-saved export
gets a new batch. Snapshot records must be valid, unique and from the selected
organization. Callers still enforce user scope, donor/campaign and batch ownership.

## Saved review and file replay (Data)

`tools/import-review.ts` is pure and in-memory:

- `fingerprintFile(bytes)` returns `sha256:<hex>` of the exact uploaded bytes.
- `checkFileReplay(orgId, hash, priorImports)` returns `replay` for an already
  committed file, `resume` for an open review and `new` otherwise. Prior imports
  from another organization are rejected, not filtered.
- `createReviewPlan(...)` runs both planners and hashes the org, batch, file and
  drafts together with every planned row and referenced stored record. Gift
  provenance must name this batch.
- `resolveReview(plan, decisions)` returns `needs_review` with pending rows, or
  `ready` with operations (`create`, `link`, `insert`, `correct`). Each decision
  carries the plan hash and reviewer ID. Links must target a listed candidate,
  invalid or conflicting-identity rows can only be skipped, changed transactions need `correct` on the
  matched gift, and one transaction identity yields at most one write.

`ready` means ready to submit, not committed. The hash detects stale or edited
plans but is not a signature: the server must rebuild the plan from stored drafts
and a fresh in-transaction snapshot, compare hashes, authorize the reviewer and
apply all operations atomically. Import records and that transaction are core
backend work (#19).

### Gifts for donors created in the same import

Resolve donors first with no gift drafts. Pass that `ready` result as
`donor_resolution` to a second `createReviewPlan` call, with `donors: []`.
Each phase-two gift uses a zero-based `donor_row` instead of `donor_id`.
Both phases must describe the same organization, batch and file hash.

- Linked donors substitute their stored ID before gift matching.
- Newly created donors produce gift operations with `donor_row`; their gift
  drafts omit `donor_id`. No temporary ID escapes in an operation.
- Skipped or missing donor rows produce `donor_unresolved` review rows that can
  only be skipped. Transaction conflicts still require review.
- Phase-two hashes also bind the donor resolution. Ordinary gifts with
  `donor_id` and no resolution retain the single-phase workflow.

The server must rebuild both phases with fresh authorized data in one transaction,
apply phase-one donor operations first, map each created donor row to its stored ID,
then substitute those IDs into phase-two gift operations. Neither phase writes data.

### Drafts from a preview

`tools/import-drafts.ts` turns a `needs_review` preview into donor and gift drafts
for schema validation by the review planners. Rows with any row-level preview issue are listed in `excluded` by
record number and code, never dropped or echoed. Rows whose donor drafts are
exactly identical and share an email become one donor; contact person and
campaign columns are never used to infer owners or campaigns. Gift facts come
from the row first and then from reviewer `values` (`currency`, `occurred_at`,
`status`, `refund_cents`), which are validated and rejected for any field the
column mapping already supplies. Missing facts are omitted and reported in
`unresolved`, never defaulted.

```bash
node tools/import-drafts.ts zeffy data/zeffy_export.csv \
  --currency USD --status settled --refund-cents 0 --occurred-at 2026-11-14T00:00:00-07:00
```

Sources are `spreadsheet`, `zeffy`, `benevity`, `az_gives` and `united_way`.
When the sheet's dates are in a known format but carry no zone, confirm both
`--date-format MM/DD/YYYY|DD/MM/YYYY|YYYY-MM-DD` and `--utc-offset ±HH:MM`
(within ±14:00) together; dates are then resolved, never guessed. A partial pair,
an unsupported format, a repeated flag or an out-of-range offset is rejected
without producing a draft plan.

The CLI is a dry run: it prints plan counts only (no names, emails, phones or
paths), runs phase one and, when that is `ready`, phase two.

Run `node --test tests/*.test.ts packages/contracts/*.test.ts` for Data and
shared-contract tests. The live API/database integration is still pending.

Typecheck Data explicitly; `npm run typecheck` currently covers contracts only:

```bash
node node_modules/typescript/bin/tsc --noEmit --target ES2023 --module NodeNext \
  --strict --types node --allowImportingTsExtensions --skipLibCheck \
  tools/import-*.ts tests/import-*.test.ts
```

## Reviewed gift persistence

`tools/import-apply.ts` applies approved gift rows inside the caller's existing
`cic_runtime` transaction. It never begins, commits or rolls back that transaction
and sets no role: every call is wrapped in a savepoint, so a rejected operation
leaves earlier applies intact and the caller's transaction usable.

Each call must pass the session organization; the actor is always the session
member, and a supplied `reviewer_id` must match it. Only gift insert and gift
correct operations are accepted, so donor creation and unresolved `donor_row`
references are rejected. Drafts are validated with the shared `GiftWriteSchema`
and every value is parameterized. Inserts store exact integer cents, literal
source text, the original instant and the database-generated id. Corrections
change financial columns only; changes to `donor_id`, `source`, `external_id` or
`source_row` are identity changes and are refused. Duplicate external ids rely on
the existing unique index, and duplicate or already stored `source_row`
provenance is checked inside the transaction. Row-level security still governs
which donors and gifts the session may touch. Successful inserts and corrections
add `gift.insert` / `gift.correct` audit events for the session member. It does not
create donors, map `donor_row` values, or store the file fingerprint. Those remain
core #19.

## Agent message board

Coordination follows the [Hackathon Agent Board guide](https://marvelous-relative-5de.notion.site/hack).
This repository has an original Python implementation; no extra Python packages
are required. Install Python 3 and GitHub CLI, then run `gh auth login`.

Use the pinned [Agent Message Board #3](https://github.com/2026-Arizona-Opportunity-Hack/avengers-CodinginColor/issues/3)
for all teammates and their agents. Do not create another board.
Never close or unpin the board; close separate task issues instead.
The CLI discovers an open issue titled exactly **Agent Message Board**. To select
a different issue, set `BOARD_ISSUE` (PowerShell: `$env:BOARD_ISSUE = '7'`).

```text
python tools/board.py whoami
python tools/board.py read -n 20
python tools/board.py unread
python tools/board.py post "[Ibrahim's Codex] @all board tooling is ready for review"
python tools/board.py wait --interval 30 --timeout 60
python -m unittest discover -s tests
```

`unread` and `wait` mark displayed comments read. `read` leaves the cursor alone.
Messages tagging your GitHub login or `@all` are flagged MENTION. Waiting returns
on a new post from another GitHub account or after the timeout; it does not launch
an agent automatically. Polls read all comment pages, so increase the interval
for large boards. Authentication and API errors stop the command visibly.

Local cursors live in ignored `.board-state/`, separately per issue and GitHub
login. Sessions sharing a checkout and login share a cursor; use separate
worktrees for independent readers. Delete a cursor to replay existing comments.
Set teammate ownership in AGENTS.md before parallel edits. Claude reads those
instructions through CLAUDE.md; Codex and other agents should read AGENTS.md.
Claude hooks check unread posts at session start and on each prompt. A missing
board or unavailable GitHub connection is reported without blocking the session.
Existing Claude clock and secret-guard hooks remain active.

## After the hackathon

Winning teams finish the project with the nonprofit — the [Definition of Done](https://www.ohack.dev/about/completion) (deployed, nonprofit sign-off, docs, open source) is tracked on your team page. Keep the repo public and the README honest; recruiters do read these.

Need a hand this weekend? [#ask-a-mentor](https://opportunity-hack.slack.com/archives/C01E5CGDQ74) on Slack, or ask in [#avengers](https://opportunity-hack.slack.com/app_redirect?channel=avengers) and a mentor will drop in.

Manual donor entry saves through the authenticated API with server-selected ownership.
The optional first gift records a settled USD gift; a partial gift failure stays
on the form for a same-key retry. Donors assigned to another board member remain
visible only to that owner and admins.

Each visible donor also has a historical gift form with explicit currency, refund,
status, campaign and date. Failed saves retain the same request identity for retry;
confirmed gifts update that currency in the timeline.

Live admin Team settings list actual membership roles and activity, add existing
verified Clerk users and save audited access changes. Reassign a board member's
active donor portfolio before deactivation.

Admin Team settings send and revoke seven-day staff invitation emails through
Clerk on explicit submission. The invitation sign-up page links verified primary
email to stored role intent; failed, expired and revoked invitations grant no access.
