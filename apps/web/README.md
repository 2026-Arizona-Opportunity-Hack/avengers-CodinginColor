# Cadence web app

Angular 22 interface for the CIC donor platform. Owner: UI (@ashworks1706).

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

Wiring to the backend replaces `Store` reads with calls to the routes in
`apps/api/README.md` (`GET /api/v1/donors`, `/donors/:id`, reporting routes in #27–#29).

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
