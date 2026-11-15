# Final demo video plan (3:55)

This plan replaces the shot list in [DEMO.md](./DEMO.md) as the target for the final recording. Recording happens only after every beat below works **live**.

## Recording rule

- Record the deployed app in **live mode**: Clerk sign-in, real API, data persisted and reloaded from the server.
- Demo-mode or browser-only behaviour must not appear as a working feature.
- `node deploy/smoke.ts <url>` must pass 7/7, and the P0 acceptance gate in [P0-LIVE-PLAN.md](./P0-LIVE-PLAN.md) must pass, before recording.
- Use synthetic donors only. Never show a real donor.
- Security is what judges will test: donor PII, board-member role access, and a human in front of every outbound message.

## Script

| Time | Beat | Screen and actions | Say on camera | Requirement covered |
|---|---|---|---|---|
| 0:00–0:12 | Intro and sign-in | Team on camera → invite-only sign-in → admin enters an MFA code | No shared passwords; admins use MFA | Team intro, role-based auth |
| 0:12–0:40 | Import | `/import` → Zeffy file → automatic column mapping → **Resolve duplicates** against existing donors → merge → **Confirm** shows new donors tagged Round-robin → save. Cut to Benevity, then save. End on `/donors` with Spreadsheet, Zeffy and Benevity in one donor's **Sources** | Nothing saves until a person confirms. Re-importing the same file adds zero gifts | Three-source import into one donor table, dedupe, round-robin to the member with the fewest donors |
| 0:40–1:03 | Donor record | Open the merged donor → **Owner** panel (show reassign) → **Timeline**: All, Gifts, Communications → **Log text** appears on the timeline → **Draft thank-you** | | Timeline, donor owner, outreach logged against the record |
| 1:03–1:35 | Debrief to action | Same donor: voice or text note "not ready to give, still learning the mission" → structured contact record, next step "Invite to Day of Compute" dated from CIC's Google Calendar, drafted follow-up. Then paste a Gemini or Google Meet note → same output | The drafted follow-up waits for approval | Debrief to action, meeting notes in, events-aware next steps |
| 1:35–2:15 | Follow-ups | `/outreach` **Next steps** grouped Overdue, This week, Later, including the debrief step → **Approve and send**: approve the thank-you → **Send from my email** opens the person's mail app → confirm sent → **Send history**. Edit an approved draft and show the approval is removed. **Quarterly touch** → draft updates → open one LLM-drafted update based on gift history and program outcomes → approve | Cadence never sends. A person approves, then sends from their own email or phone | Follow-up reminders, quarterly touch, system drafts and a human sends, templated thank-you, send history, AI-drafted donor updates |
| 2:15–2:35 | Retention and radar | `/retention` segments (new, reactivated, increased, flat, decreased, lapsed) → **Activation and churn by year** → **Lapsed** → **Draft nudge** | Nudges are drafts too | Year-over-year retention, churn and activation patterns, lapsed-donor radar |
| 2:35–2:48 | Funder packet | `/funders` → choose a funder → gift history with **Funded outcomes** → **Export CSV**. Grant deadline tracker builds the packet as the deadline approaches | Admin only; every export is audited | One-click funder export, grant deadline tracker |
| 2:48–3:03 | Read API | `/api` → issue a key (shown once) → **Try a request** grouped by program, then owner, then month → show the README API section | Key stored only as a hash; aggregates only, no donor names; CIC can connect its dashboard without the team | Key-authenticated read API by period, program and board member; documentation |
| 3:03–3:21 | Ask Cadence | "Who gave to AI Academy but not summer camp?" then one follow-up question | Answers cover only donors you're allowed to see | Natural-language donor questions |
| 3:21–3:43 | Role switch | Sign out → board-member sign-in → donor list shows only their donors → paste another member's donor URL → not found → Import, Funders and API missing from the sidebar → `/funders` redirects | Least privilege; the database enforces it, not only the screen | Role-based access, least privilege |
| 3:43–3:55 | Close | Tab through the log-contact form with focus visible → Lighthouse accessibility score → README and DEPLOY | We store only name, contact details and gifts. Hosting fits OHack's budget. CIC can run it from the README | Accessibility, data minimization, hosting, README |

## Must work live before recording

| Beat | Live capability needed |
|---|---|
| Sign-in | Invite-only Clerk, admin MFA |
| Import | Live upload, duplicate review and atomic commit through `/api/v1/imports`; CSV and authorized XLSX (#94); exact re-import adds zero gifts |
| Donor record | Live gifts and communications timeline, reassignment, outreach logging |
| Debrief | Voice or text note and Gemini/Meet notes processed by an LLM into a contact record, next step and draft; Google Calendar event dates; human review before saving or sending |
| Follow-ups | Live next steps, quarterly touches, LLM-drafted updates, approvals, manual-send confirmation and send history |
| Retention | Server-backed year-over-year retention; lapsed nudge drafts persist |
| Funders | Server-audited packet export; grant deadline tracker |
| Read API | Live key issue and revoke; summary and activity work with a real key and reject a bad one |
| Ask Cadence | LLM turns a question into authorized, allowlisted filters; respects board-member visibility |
| Role switch | Board member sees only owned donors; foreign donor URL returns not found; admin-only routes are blocked |
| Close | Lighthouse accessibility ≥95 measured on the deployed app; hosting cost confirmed within $20/month plus $250 setup |

## Model boundary

- Drafting, debrief extraction, meeting-note summaries and natural-language questions use an LLM.
- Jev / System One is only for structured data processing, such as import column mapping.
- No message is sent automatically. A person approves and sends every message.

## Order of work

P0 must pass the live gate first. P1 and P2 screens in this script are built afterwards: debrief, meeting notes, calendar dates, AI-drafted updates, lapsed radar persistence, grant deadlines, then Ask Cadence.
