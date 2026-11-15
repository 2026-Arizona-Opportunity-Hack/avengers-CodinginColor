# Demo video script (4 minutes or less)

Recording starts **Sun Nov 15, 12:00 PM MST**. Hacking ends at **2:00 PM MST**. Upload to YouTube,
Vimeo, Loom or Google Drive and paste the link on the Team Dashboard. All data shown is
**synthetic**. Never show a real donor.

**Agents: verify, don't build.** Before anyone changes code for the video, check every row of the
script and the pre-recording checklist on the deployed site, then report PASS or FAIL with evidence on
board #3. Only open a fix once the FAIL is posted and a human agrees it's worth the time. A beat that
fails gets cut, not rushed.

## How the video runs

- **Clerk sign-in, about 10 seconds.** Show the invite-only Clerk sign-in at
  `https://cadence-cic.vercel.app/sign-in` and the admin MFA step. Don't do setup on camera.
- **Try now (#223) for the walkthrough.** The deployed URL serves `config.json`, so it opens in live
  mode. **Try now** enters the synthetic browser workspace on that same URL, without Clerk or the API.
  Use it as an admin, then switch persona from the top-left workspace control. If #223 is not
  deployed and verified by 11:50 AM, run demo mode locally instead: `npm start` in `apps/web` with
  **no** `public/config.json`.
- **Live proofs, only if rehearsed.** Server-backed claims (persistence, RLS, audit, read API) need
  a real signed-in session on the deployed site. Record each one only after it passed a rehearsal.

Say once, near the start: *"The walkthrough uses Try now, a sample workspace in the browser. The
live proofs at the end run against our deployed server."*

## Script

| Time | Mode | Screen and actions | What to say | Verified before recording |
|---|---|---|---|---|
| 0:00–0:15 | Live | `/sign-in` → Clerk invite-only sign-in → admin MFA prompt → cut | CIC tracks donors in spreadsheets and exports; follow-ups live in people's heads. Sign-in is invite-only and admins use MFA. | Admin account with MFA already enrolled signs in on the deployed URL |
| 0:15–0:20 | Try now | Sign out → **Try now** → workspace opens as admin, synthetic label visible | This is a sample workspace with made-up donors. | #223 deployed; entry, reload and sign-out work |
| 0:20–0:50 | Try now | `/import` → load the Zeffy sample → columns map automatically → ambiguous date must be confirmed → invalid rows listed | Columns map automatically. Ambiguous dates get confirmed, not guessed. Bad rows are listed, never silently dropped. | Sample loads, mapping and date prompt appear. **Don't claim duplicate protection here:** it lives in the server import path |
| 0:50–1:25 | Try now | `/donors` → one donor → owner, donation history, communications, future next steps | One record per donor with an owner. Past gifts and messages sit apart from what's next. | Timeline shows gifts and communications together |
| 1:25–2:10 | Try now | `/outreach` → overdue/this week/later → draft a thank-you → approve → open in mail app → edit it and show approval dropped | Cadence drafts and reminds. A person approves and sends from their own email. Nothing is sent automatically. | Draft, approve, compose link and approval reset all work |
| 2:10–2:30 | Try now | `/retention` → new, reactivated, increased, flat, decreased, lapsed | Year-over-year retention for the donors this member can see. | Segments render, no errors |
| 2:30–2:45 | Try now | `/funders` → pick a funder → gift history plus funded outcomes → Export CSV | The funder packet CIC re-keys today, in one click. | CSV downloads (browser-generated in Try now; don't call it audited) |
| 2:45–3:00 | Try now | Top-left control → switch to a board member → list narrows; Import, Funders, API leave the sidebar | Board members see only their own donors. | Persona switcher works by keyboard |
| 3:00–3:35 | Live | Signed in on the deployed site: (a) board member opens another member's donor URL → not found; (b) admin downloads the funder packet → audit event; (c) `GET /api/v1/summary` with a key → 200, bad key → 401 | On the server, PostgreSQL row-level security enforces this, not the screen. Exports are audited. The read API returns aggregates only and hides groups under three. | Each proof passed a rehearsal on the deployed site. **Cut any that didn't** |
| 3:35–3:48 | Either | Tab through the add-donor form with focus visible | Keyboard users can do everything here. | Focus ring visible on every field |
| 3:48–4:00 | — | README and `docs/DEPLOY.md` | Open source (MIT) with a runbook for CIC. Say plainly what's still being connected. | README live link is current |

Optional, only if rehearsed and time allows (replace a beat, never run over 4:00):

- **Ask your data (live):** one supported question, such as lapsed donors. Since #222, model advice
  is accepted regardless of JSON key order. Say "AI interprets the question" only if the redeployed site
  shows it accepted the model's advice; otherwise say "built-in filters." No donor rows reach the model.
- **Review meeting notes (live donor record):** paste notes → edited contact note, action and draft →
  review before saving.

## Pre-recording checklist (report each on board #3)

1. **Deployed P0 gate.** Run all 11 checks in [P0-LIVE-PLAN.md](./P0-LIVE-PLAN.md) on
   `cadence-cic.vercel.app` and record PASS/FAIL per check. #30, #47 and #73 stay open until this
   passes. Only the steps that pass go in the video.
2. **Live database (Ash, who deployed it).** Confirm on the production Neon database:
   - migrations 001–018 have run (`db/migrate.ts` with the migration owner);
   - the CIC org, an admin and **at least two** active board members exist (`db/provision.ts`);
   - `node --env-file-if-exists=.env db/seed-demo.ts --yes-demo-data` has run.

   Without these, live screens are empty and the role-scoping proof fails.
3. **Accounts.** One admin with MFA already enrolled and one board-member login, both rehearsed.
4. **Try now (#223).** Deployed, labeled synthetic, keyboard persona switcher, reload and sign-out tested.
5. **Smoke.** `node deploy/smoke.ts https://cadence-cic.vercel.app` passes 7/7 on the deployment being recorded.
   7/7 shows the API and config are served, not that sign-in, scoping or exports work.
6. **Freeze main from 11:55 AM until the recording is done.** Every merge redeploys.
7. **Browser.** Zoom 110%, other tabs closed, Try now data reset (Settings → Reset demo data).

## Don't show or claim

- Google Calendar dates, grant deadline tracker, voice debrief, automatic Meet ingestion: not built.
- In live mode these save nothing ("not connected"): logging a contact of type note, follow-up
  statuses other than done, templates other than the four live ones, discarding a draft, owner
  digests, custom fields. Don't click them on camera.
- Duplicate protection, audit, persistence or RLS during Try now beats. Try now is a browser simulation.
- A site-wide accessibility score. The 95/100 Lighthouse result covers the sign-in page on localhost only.
- Backups, restores or confirmed hosting costs.
- Clerk's "Development mode" badge is expected on the test instance; don't linger on it.

Rubric reminders: **Scope** (import, follow-up and funder report are CIC's real workflow), **Polish**
(one continuous take, no errors on screen), **Documentation** (README and DEPLOY), **Security** (only
the live proofs actually shown), **Accessibility** (keyboard beat on camera).
