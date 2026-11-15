# Coding in Color web app

Angular 22 interface for the CIC donor platform. Owner: UI (@ashworks1706).

The interface uses Coding in Color's supplied nonprofit logo and product name on
sign-in, navigation, browser titles and the favicon. The asset source is documented
in [public/branding/README.md](public/branding/README.md).

```bash
cd apps/web
npm ci
npm start          # http://localhost:4200, proxies /api to the API on :3000
npm run build      # static output in dist/web/browser
```

## Pages

Each page has one job.

| Route | Purpose | Who |
|---|---|---|
| `/` | Overview: money in, retention, work due, board portfolios | Everyone (board sees own portfolio) |
| `/donors` | One record per donor, with owner, contact, sources and next step | Board sees only their donors |
| `/donors/:id` | Profile, next steps (future) and timeline of gifts and communications (past) | Owner or admin |
| `/donors/new` | Add one donor by hand, with duplicate warning and owner preview | Everyone |
| `/donations` | Ledger of every gift, filterable, CSV download | Everyone (scoped) |
| `/outreach` | Approve and send drafts, next steps, quarterly touch, send history | Everyone (scoped) |
| `/import` | CSV/XLSX → map columns → check rows → resolve duplicates → confirm | Admin |
| `/retention` | New, reactivated, increased, flat, decreased, lapsed; year over year | Everyone (scoped) |
| `/funders` | Funder packet: gift history plus funded outcomes, CSV or PDF | Admin |
| `/api` | Read API keys and documentation | Admin |
| `/settings` | Members and roles, custom donor fields, audit log | Admin |

## Data

The app currently runs on a synthetic, deterministic demo dataset stored in the
browser (`src/app/core/demo-data.ts`, `store.ts`). Use the **Signed in as** menu to
switch between an admin and a board member and see role scoping. The UI mirrors
the server's rules; the API and PostgreSQL row-level security remain the authority.
Settings → Reset demo data restores the original records.

### Live mode (#59)

Put a `config.json` next to `index.html` (in `public/` for `npm start`, or in the
deployed `dist/web/browser/`) to sign in with Clerk and read the real API:

```json
{ "apiBase": "https://api.example.org", "clerkPublishableKey": "pk_test_REPLACE_ME" }
```

Both values are public. `apiBase` is `""` when the API serves the app from the same
origin, and the API's `APP_ORIGIN` must equal the app's origin. With no valid
`config.json` the app stays in demo mode.

In live mode, Donors, Donor detail (edit and archive) and Retention read and write
through `GET/PATCH /api/v1/donors`, `POST /api/v1/donors/:id/archive`,
`GET /api/v1/me` and `GET /api/v1/reports/retention`. Queues and drafts load from
the scoped outreach routes. Administrators can issue and revoke real keys on
Read API; raw keys are shown once and kept out of browser storage. Follow-ups
supports server-backed task creation/completion, quarterly task planning (admin),
draft editing and approval, consent-checked email/SMS compose, and confirmed manual
send logging with scoped history. Quarterly touches require a logged contact.
Import now uploads original CSV/XLSX bytes and walks through server mapping,
explicit financial facts, invalid-record acknowledgments, donor/gift decisions,
per-currency reconciliation and atomic commit. Re-uploading the same file returns
the saved result. Review state stays in memory and clears on session changes;
abandoning a staged batch purges it on the server. XLSX API support requires #105.
The admin Funder reports screen now requests the server's funder/program/period
packet and downloads its audited CSV. Print/PDF uses the same loaded report.
Amounts remain per-currency with unattributed gifts separate; unavailable outcome
data is never replaced with zero. Administrators can upload and review aggregate JSON outcomes, then explicitly approve them.
The example uses the selected program and period; fill the actual source and results.
Reports refresh after persistence. Same program/period/metric uploads correct prior approved values.
Donor records are kept in
memory only, never in browser storage, and are cleared on sign-out. Screens whose
server routes have not landed (donations, add donor,
settings) are hidden. Any other write shows "not
connected yet" instead of pretending to save. Other owners appear as a short member
ID until the API has a member directory route.

Live donor summaries and timelines now load gifts, campaign/program labels and
communications from the server. Contact logs save through scoped routes and reload
history/quarterly tasks before reporting success. The giving currency selector
keeps summaries in one currency at a time. Internal notes remain a separate pending
workflow; failed delivery is never counted as a successful contact.

## Design rules

- Coding in Color palette from the brand guidelines: dark green `#007A3D`, white, tinted green `#E6F4ED`, `#00A850` for small accents only. Text is black, or white on dark green. No gray text.
- Hierarchy from size, weight, the mono face and 1px rules.
- Charts use brand-green fill, hatching and dots, so series never depend on color alone.
- Every control is a native button, link or form element with a visible focus ring.

Lighthouse accessibility is 100 on every route (checked against the production build).

## Human in the loop

- Import: suggested column mappings must be accepted; invalid rows and formula
  cells are excluded; duplicates are merged only by explicit choice.
- Outreach: Cadence drafts. A person approves, sends from their own email or
  phone, then records it. Nothing is sent automatically.

The overview uses scoped persisted gifts and outreach, the selected currency, net settled amounts, and Phoenix calendar boundaries.

Overview and Retention read server retention KPIs for the selected currency.
Currency changes select the matching server bucket; sign-out clears loaded reports.

Overview and Retention share period/program/owner/campaign/acquisition-year controls.
Gift widgets compare the selected Phoenix calendar range with the matching prior
year; current follow-ups keep their own due dates while following the donor scope.
Acquisition year uses first positive settled giving across currencies. Filters
intersect server authorization and clear private dimensions when the session changes.

Review lapsed donors from Follow-ups or Retention. The current scoped report opens
a lapsed drill-down; eligible active contacts can receive an editable server nudge
draft. Every nudge still requires the normal approval and manual-send steps.
