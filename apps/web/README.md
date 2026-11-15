# Coding in Color web app

The public app opens **Try Now** without an account. It always uses fictional browser data before config/auth access, including when `config.json` exists. Clerk widgets and live security/account routes are not part of this public flow; backend session verification, MFA and authorization remain enforced separately.

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
browser (`src/app/core/demo-data.ts`, `store.ts`). Use the **Switch person** selector to
switch between an admin and a board member and see role scoping. The UI mirrors
the server's rules; the API and PostgreSQL row-level security remain the authority.
Settings → Reset records restores the original records.

### Retained backend integration source

API and live-client implementations remain in the repository with their authorization and validation. Public startup does not activate them. `/setup-security`, `/sign-up` and `/impact` redirect to Try Now; `?demo=0` does not expose a live login. Adding `public/config.json` cannot switch this build to real accounts or server persistence.

For separately authenticated backend development, follow [API contracts](../api/README.md) and [deployment operations](../../docs/DEPLOY.md). Keep database URLs, Clerk secrets and session credentials out of this static app and browser storage. No anonymous production API access is added by Try Now.

Public edits, imports and drafts stay in browser storage. Persona changes return to Overview with actual admin/board scope. See [the recording script](../../docs/DEMO.md) for release rehearsal checks.

## Design rules

- Coding in Color palette from the brand guidelines: dark green `#007A3D`, white, tinted green `#E6F4ED`, `#00A850` for small accents only. Text is black, or white on dark green. No gray text.
- Hierarchy from size, weight, the mono face and 1px rules.
- Charts use brand-green fill, hatching and dots, so series never depend on color alone.
- Every control is a native button, link or form element with a visible focus ring.

The earlier UI redesign reported Lighthouse accessibility100 on its then-existing routes. Rerun the audit on current routes before closing #73; this integration pass does not claim a new Lighthouse result.

## Human in the loop

- Import: suggested column mappings must be accepted; invalid rows and formula
  cells are excluded; duplicates are merged only by explicit choice.
- Outreach: Cadence drafts. A person approves, sends from their own email or
  phone, then records it. Nothing is sent automatically.

The overview uses scoped browser-local gifts and outreach, the selected currency, net settled amounts, and Phoenix calendar boundaries.

### Retained live-client reporting code

The following describes retained server integration source, not the current public Try Now experience. Public startup does not connect these requests.

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

On an active donor profile, Draft a program update loads scoped net program gifts
and approved available aggregate results for an inclusive date range. Inspect the
source facts, edit the message and save it for the existing approval/send workflow.
Source changes invalidate the proposal; identical unsent saves reuse the draft.
No model key is required. External suggestions receive only synthetic fact types.

Reporting charts, owner giving totals and the funder selector retain authorized archived donor history. Archived donors remain excluded from active assignment counts and follow-up workload.
