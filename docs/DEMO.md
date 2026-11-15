# Demo video script (3 minutes 50 seconds)

Upload a video of **four minutes or less** to YouTube, Vimeo, Loom or Google Drive, add its link to README and the [Team Dashboard](https://www.ohack.dev/hack/fall-2026/manageteam), then Submit before Sun Nov 15, 2:00 PM MST.

This is a recording plan, not a claim that these steps passed on the latest deployment. Rehearse each row on the exact release being recorded; report PASS/FAIL and evidence on board #3. Cut a failed beat. Do not repair or seed production data for a recording.

## How the video runs

Open the public root and choose **Try Now** in the existing entry card. No Clerk sign-in, account enrollment or MFA prompt belongs in this walkthrough. Public startup uses fictional browser data even when config exists; it does not call the protected API. There is no required on-screen synthetic badge.

Say once: *"This walkthrough uses fictional records stored in the browser. Our separate backend remains authenticated; these screens do not demonstrate server persistence or delivery."*

For a local recording, run `npm start --prefix apps/web` and use the printed URL. No database, Clerk keys or `config.json` is needed. Do not imply a local recording is deployed evidence.

## Script

| Time | Screen and actions | Narration / check |
|---|---|---|
| 0:00-0:15 | Public root -> **Try Now** -> Overview | CIC needs one place for donor relationships and the next follow-up. Show entry as CEO/admin; give the fictional-data narration above. |
| 0:15-0:45 | `/import`: upload a rehearsed synthetic CSV, map, review and commit; repeat exact file if rehearsed | Date input explicitly uses US month/day/year, optional 12-hour time and Phoenix UTC-07:00; no ambiguous-date confirmation popup is promised. Show actual validation and review before save. If replay passes, describe only this browser import's same-source identity/file replay behavior. |
| 0:45-1:10 | `/donors` -> donor detail -> switch **Switch person** to Marcus Bell | Past gifts and communications stay separate from future tasks. Switching person returns to Overview; reopen Donors to show Marcus's own records. Admin-only navigation disappears. This demonstrates browser role scope, not PostgreSQL RLS. |
| 1:10-1:30 | `/prospects`: choose an assigned potential donor and open prior giving/interests | Show prior recipient, cause, amount/date and the stated program-interest overlap. These are fictional examples, not researched people, verified giving or a likelihood score. Switch back to admin; expect Overview. |
| 1:30-1:50 | `/donations`: Chart type **Bar -> Line -> Area** | The same filtered monthly net gifts have three views; chart style does not change amounts, currency or ledger rows. |
| 1:50-2:10 | `/ask`: choose a supported suggested question, inspect explanation and donor links | Ask uses supported local filters over this persona's records. Do not call it an external model response. An unsupported question can request clarification. |
| 2:10-2:55 | `/outreach`: select an unsent draft, **Regenerate draft**, inspect details; approve, then **Edit** and save a change | Only include regeneration after it is present and rehearsed on the recording release. Show gift/context-specific text, review it, and show that regeneration/editing clears approval. People remain responsible for approval and sending; never claim an actual email was delivered. Cut regeneration if unavailable; retain the existing review/edit/approve workflow. |
| 2:55-3:25 | `/retention` then `/funders`: select a funder/period and download CSV if rehearsed | Show donor movement and gift history with available funded outcomes. The public report is generated in the browser; do not call it a server-audited export. |
| 3:25-3:50 | Tab through a form, then show README/runbook and closing | Show visible keyboard focus without claiming a site-wide accessibility score. Open source, MIT, with setup and backend contracts; describe any remaining release gaps honestly. |

Total planned runtime: **230 seconds**, leaving ten seconds below the four-minute limit. Rehearse with a timer; trim narration rather than speed through review controls.

## Before recording

- Confirm the deployed commit contains the chosen features. A merged PR or green CI alone is not deployed acceptance. In particular, omit regeneration unless that release contains it.
- Rehearse the table on the recording URL: Try Now, reload, sign-out/re-entry, actual admin/board scope, prospects/direct URL scope, three chart types, supported Ask question, import review/replay and draft approval invalidation.
- Use fictional files and contacts only. **Settings -> Reset records** discards browser edits: reset only a disposable recording workspace, then rehearse the selected inputs again.
- For replay without source transaction IDs, use the exact same parsed file. Modified files cannot prove business identity; old filename-only imports require review. Do not promise retroactive cleanup of historical duplicates.
- Confirm the actual CSV download and inspect it. Do not substitute a JSON response or a button click for download evidence.
- Coordinate a short recording freeze: merges can trigger deployment. Close unrelated tabs and hide credentials; do not open a mail app or contact a real recipient for the video.
- `node deploy/smoke.ts https://cadence-cic.vercel.app` may check public routing/auth refusal. A 7/7 result does not prove signed-in data flows, imports or complete release acceptance.

## Backend evidence stays separate

The public app has no live-login switch. Existing API/session/MFA/RLS/audit implementations and tests are documented in [the API guide](../apps/api/README.md), [DEPLOY.md](DEPLOY.md) and [P0-LIVE-PLAN.md](P0-LIVE-PLAN.md). Include a server proof only if separately authorized, rehearsed and evidenced with a supported authenticated client; replace another beat so the video remains under four minutes. Do not create accounts, migrate/seed production, expose tokens or claim current verification from historical evidence.

## Do not claim

- Browser fixtures prove production persistence, server RLS, audited exports or actual message delivery.
- Prospect examples are real research; local Ask results are model-generated advice.
- Automatic sending, Google Calendar/grant tracking, voice/Meet ingestion, a site-wide accessibility score, tested backups or confirmed hosting costs.

Rubric: show CIC's workflow, a continuous usable interaction, honest security boundaries and documentation another maintainer can follow.
