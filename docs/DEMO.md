# Demo video script (4 minutes or less)

Recording starts **Sun Nov 15, 12:00 PM MST**. Upload to YouTube, Vimeo, Loom or Google Drive and
paste the link on the Team Dashboard. All data shown is **synthetic** (the web app's built-in demo
data, or `db/seed-demo.ts`). Never show a real donor.

The video has two parts. **Part A** is the product walkthrough in the web app's demo mode, which
runs entirely in the browser. **Part B** shows server-side proofs, recorded only if you rehearsed
each one against a live deployment beforehand. Narrate only what's on screen: demo mode is a
browser simulation and proves nothing about the database, the API or real donor protection.

## Before you record

- Run `node deploy/smoke.ts https://cadence-cic.vercel.app`.
  - **Below 7/7:** record Part A only, then use Part B's spare time for the closing.
  - **7/7:** you may add Part B. 7/7 only shows the API and config are served. It doesn't prove
    sign-in, imports, scoping or exports work, so rehearse every Part B step first and drop any
    that fail.
- Set the browser zoom to 110%, close other tabs, and in demo mode open Settings → Reset demo data.

## Part A — product walkthrough (demo mode, about 3:00)

Say once, at the start: *"This is Cadence running on synthetic sample data in the browser."*

| Time | Screen | What to say (and show) |
|---|---|---|
| 0:00–0:20 | Overview `/` | Coding in Color tracks donors in spreadsheets and platform exports, and follow-ups depend on memory. Cadence gives the CEO and the board one place for donors, gifts and the next touch. |
| 0:20–0:50 | Import `/import` | Load the AZ Gives sample. Columns map automatically, dates in an ambiguous format must be confirmed instead of guessed, and rows with bad emails or amounts are listed, not silently dropped. (Don't claim duplicate protection here: that lives in the server import path, not in this screen.) |
| 0:50–1:25 | Donors `/donors` → one donor | One record per donor with its owner. The timeline keeps **past** gifts and messages apart from **future** next steps. Switch **Signed in as** to a board member: the list narrows to their own donors. |
| 1:25–2:15 | Follow-ups `/outreach` | The queue shows overdue, this-week and upcoming items. Draft a thank-you from a template, approve it, then open it in your own mail app; nothing is sent automatically. Editing an approved draft drops the approval. |
| 2:15–2:40 | Retention `/retention` | New, reactivated, increased, flat, decreased and lapsed donors, year over year, for the donors this member can see. |
| 2:40–3:00 | Funders `/funders` | The funder packet: gift history plus funded outcomes, downloaded as CSV (generated in the browser in demo mode). |

## Part B — server proofs (live deployment only, about 0:45)

Record each line only after it passed in a rehearsal on the live site, signed in through Clerk, with
the demo seed loaded (`node --env-file-if-exists=.env db/seed-demo.ts --yes-demo-data`).

| Proof | Show | Say |
|---|---|---|
| Role scoping | As a board member, open another member's donor by URL | The API answers "not found", because PostgreSQL row-level security filters it, not just the screen. |
| Admin-only export | As a board member, request the funder packet; then as the admin, download it | The board member is refused, and the admin download is recorded as an audit event. |
| Read API | Call `GET /api/v1/summary` with a dashboard key | Aggregates only. Groups smaller than three donors are hidden, and the key is stored only as a hash. |

## Closing (about 0:15)

It's open source (MIT), with a runbook for CIC to run it (`docs/DEPLOY.md`): invite-only sign-in,
MFA for admins, and synthetic data only in this demo. Say plainly which parts are still being
connected (see README → What we built).

Rubric reminders: **Scope** (import, follow-up and funder report are CIC's real workflow), **Polish**
(one continuous take, with no errors on screen), **Documentation** (README and DEPLOY), **Security** (only
the Part B proofs you actually showed), **Accessibility** (tab through one form on camera with focus
visible).
