# Demo video script (4 minutes or less)

Recording starts **Sun Nov 15, 12:00 PM MST**. Upload to YouTube, Vimeo, Loom or Google Drive and
paste the link on the Team Dashboard. All data shown is **synthetic** (`db/seed-demo.ts` or the
web app's built-in demo data). Never show a real donor.

Before you record:
- Run `node deploy/smoke.ts https://cadence-cic.vercel.app`. With **7/7 PASS**, record the
  live version. Otherwise record demo mode and say so on screen. Never imply a backend that isn't
  there.
- For live mode, sign in once as the CEO (admin, with an authenticator code ready) and once as a
  board member in a second browser profile. Load the seed first:
  `node --env-file-if-exists=.env db/seed-demo.ts --yes-demo-data`.
- Set the browser zoom to 110% and close other tabs.

| Time | Screen | What to say (and show) |
|---|---|---|
| 0:00–0:20 | Title / Overview `/` | Coding in Color tracks donors in spreadsheets, and follow-ups depend on memory. Cadence gives the CEO and the board one place for donors, gifts and the next touch. |
| 0:20–0:55 | Import `/import` | Upload a sample export (`az_gives_export.csv`). Columns map automatically, and ambiguous dates must be confirmed, never guessed. Bad rows are listed, not silently dropped. Re-importing the same file adds **zero** duplicate gifts. |
| 0:55–1:30 | Donors `/donors` → a donor | One record per donor with its owner. The timeline keeps **past** gifts and communications apart from **future** next steps. Then switch to a board member: they see only their own donors. Opening someone else's donor gives "not found", enforced by the database (row-level security), not just the screen. |
| 1:30–2:20 | Outreach `/outreach` | The queue shows overdue, this week and upcoming items. Draft a thank-you from a template, approve it, then **Send from my email**, which opens the person's own mail app with the approved text. Confirm it was sent, and it's logged once. This quarter's touch closes. Editing an approved draft drops the approval, and nothing is sent automatically. |
| 2:20–2:55 | Retention `/retention` | New, reactivated, increased, flat, decreased and lapsed donors, year over year. Groups smaller than three donors are hidden so no one can be singled out. |
| 2:55–3:25 | Funders `/funders` | Admin-only funder packet: gift history plus funded outcomes, downloaded as CSV. The download is audited. A board member gets "not allowed". |
| 3:25–3:45 | API `/api` | An admin issues a read-only key for CIC's dashboard. It's shown once and stored only as a hash, and it can be revoked. Aggregates only, never donor names. |
| 3:45–4:00 | Close | It's open source (MIT), with a runbook for CIC to run it (`docs/DEPLOY.md`). Invite-only sign-in with MFA for admins, and synthetic data only. |

Rubric reminders for the narration: **Scope** (import, follow-up and funder report are CIC's real
workflow), **Security** (row-level security, MFA for admins, approval before any message, hashed keys,
no secrets in git), **Polish** (one continuous take with no errors on screen), **Documentation**
(README and DEPLOY), **Accessibility** (keyboard focus visible, labels on every control; tab through one
form on camera if time allows).
