# avengers — Coding in Color

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

<!-- Two or three sentences: the problem, who it helps, what the nonprofit can do now that they couldn't before -->

Project requirements and delivery roles: [CIC Donor Platform Implementation Plan](CIC_Donor_Platform_Implementation_Plan.pdf).
This is the planning source of truth; its proposed features are not implemented yet.

The first data pipeline slice is a local CSV preflight tool. It parses the three
sample exports, normalizes known columns, validates contact fields and exact
integer cents, and reports review issues. It preserves raw cells and record
numbers in memory; it never writes donors or gifts.

## Tech stack

- Frontend:
- Backend:
- Database:
- APIs / services:

## Run it locally

```bash
git clone https://github.com/2026-Arizona-Opportunity-Hack/avengers-CodinginColor.git
cd avengers-CodinginColor
cp .env.example .env   # fill in your own values — never commit .env
# install + start commands here
```

## Links

- Live demo:
- Demo video:
- Design / docs:

## CSV import preflight

Requires Node.js 24.2 or newer. Install the shared contract's locked dependencies;
no credentials are needed.

```bash
npm ci
node tools/import-preview.ts spreadsheet data/cic_donor_spreadsheet.csv
node tools/import-preview.ts zeffy data/zeffy_export.csv
node tools/import-preview.ts benevity data/benevity_export.csv
node --test tests/import-preview.test.ts tests/import-mapping.test.ts
```

The CLI prints row counts and issue categories without donor contact details.
Exit code 0 means the preview ran, not that rows are approved; unreadable or
malformed files exit 1. Input must be UTF-8 CSV, at most 5 MiB. Unknown headers,
invalid amounts/contacts, formulas and uneven rows require human review.
Blank data records are retained and flagged. Source labels identify provenance;
these illustrative CSVs do not establish real Zeffy/Benevity export formats.

All supplied samples lack required gift dates (`occurred_at`) and currency, so
every preview remains `needs_review`. External transaction IDs are optional in
the backend baseline; reimport safety still needs reconciliation logic.
Phone formatting is normalized without guessing
a country; contact-person names do not assign owners. XLSX, Jev suggestions,
donor/gift deduplication, saved review decisions and transactional import remain
follow-up work against the baseline published in [backend issue #7](https://github.com/2026-Arizona-Opportunity-Hack/avengers-CodinginColor/issues/7),
with persistence integration after the shared foundation is reviewed and merged.

For ambiguous headers, pass an optional JSON mapping file as the final argument:
`node tools/import-preview.ts spreadsheet export.csv mapping.json`.
Keys must exactly match source headers. Targets are `first_name`, `last_name`,
`email`, `phone`, `company`, `contact_person`, `campaign`, `occurred_at`,
`currency`, `external_id`, `amount_decimal`, or `amount_cents`; null explicitly
ignores a column while retaining its raw cells. Unknown targets/headers and
multiple columns targeting the same field are rejected.

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
