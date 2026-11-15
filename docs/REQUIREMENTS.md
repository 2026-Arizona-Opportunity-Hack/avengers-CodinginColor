# PDF requirements and acceptance evidence

Source of truth: `CIC_Donor_Platform_Implementation_Plan.pdf` (18 plan pages). Audit date: **2026-11-15**. Source inspection covers integrated snapshot `0bba63e` and the published feature heads cited below. PR states are a dated snapshot, not proof of a deployed release. The human explicitly authorized P1/P2 work alongside remaining P0 integration.

**Code coverage is not live acceptance.** Tests use synthetic fixtures and stub providers unless stated otherwise. The audit did not access credentials, modify a real database, send invitations/messages, or impersonate users. Read the remaining acceptance gates before claiming completion.

## P0 required flows

| PDF requirement | Implementation and published delivery | Test evidence and remaining acceptance |
|---|---|---|
| CSV/XLSX spreadsheet, Zeffy and Benevity intake; mapping, validation and duplicate review | `tools/import-preview.ts`, `tools/import-xlsx.ts`, `tools/import-review.ts`; `apps/api/imports.ts`, `import-plans.ts`, `import-commit.ts`; web `pages/import-live.ts`. PRs #105, #110, #120, #124, #127, #132. | `tests/import-*.test.ts`, API `imports.test.ts`, `import-xlsx.test.ts`, `import-commit.test.ts`, `import-suggestions.test.ts`, `import-aliases.test.ts`; web `import-live.spec.ts`. Independently observed import regression: 133 pass, 1 optional native skip. Still rehearse the complete three-source merge/re-import flow against the release URL. |
| Exact gift facts, reviewed dates/status/refunds/currency, separate donor and gift identity | `packages/contracts/index.ts`, `tools/import-drafts.ts`, `tools/import-reconcile.ts`, migrations 006/008; per-row facts and explicit campaign/contact aliases. | Tests cover mixed status/refunds, currency reconciliation, stale plans, acknowledged skipped rows, provenance conflicts, atomic audit failure and identical-file replay. Real source field meanings and spreadsheet-summary versus itemized-export reconciliation still require CIC's de-identified samples. |
| Manual donor and historical gift entry | API `donors.ts`, `gifts.ts`, migration 011; web `pages/donor-new.ts`, `gift-entry.ts`. PRs #121, #126, #129, #136. | API `manual-donor-replay.test.ts`, `donors.test.ts`, `gifts.test.ts`; web `live-workflows.spec.ts`. Independently observed 4 API tests and 18 frontend tests passing before the subsequent validation correction. Rehearse partial-failure retry and correction on the integrated release. |
| Donor search/filter, contact details, owner and retained history | Web `pages/donors.ts`, `donor-detail.ts`, `donations.ts`; API scoped donor/gift/contact routes. PRs #112, #143, #152. | Web `ledger-history.spec.ts` and API donor/gift/contact tests. Donation-only history, communications and future tasks are separate. Archived financial/contact history stays readable; active assignment counts stay separate. Live board cross-owner denial and archived-history walkthrough remain acceptance checks. |
| Least-loaded active-board assignment, stable round-robin ties, existing owner retained, audited admin override | Migrations 002/003/007/009; API `donors.ts`; reviewed import aliases assign only newly created donors. PR #119 and earlier core assignment delivery. | Assignment tests plus API `owners.test.ts`, `donors.test.ts`, `import-aliases.test.ts`. Review evidence covers zero-donor eligible owners, open-task transfer and preservation of linked-donor owners. Verify a multi-board roster and balanced assignment in the demo environment. |
| Due/overdue next actions and one quarterly task per eligible donor; human-reviewed owner digest | `packages/outreach/queue.ts`, API `outreach.ts`, `outreach-messages.ts`, migration 005; web `pages/outreach.ts`, `owner-digests.ts`. | Queue/message tests, web `owner-digests.spec.ts`, `live-workflows.spec.ts`. Qualifying logged contact closes quarterly tasks; draft creation does not. Rehearse generation, digest review, reassignment and completion. |
| Editable thank-you/update templates; exact-content approval; explicit human send/manual log | `packages/outreach/messages.ts`, API `outreach-messages.ts`, web `core/outreach-live.ts`. | Approval invalidation, recipient/contact changes, consent, duplicate confirmation and failed-audit regressions. Current workflow opens the person's email/SMS composer and confirms a real manual send. This is the supported fallback, not proof of provider delivery. |
| Retention categories, matched prior/current Phoenix windows, cohort/campaign/program/owner filters | `packages/reporting/retention.ts`, API `reporting.ts`, web `core/report-filters.ts`, `pages/retention.ts`, `overview.ts`. PRs #125, #134, #138, #141, #152. | `packages/reporting/retention.test.ts`, API `reporting.test.ts`; web `report-filters.spec.ts`, `retention-live.spec.ts`, `overview-live.spec.ts`. Independent reporting run: 33 API/package tests and 20 focused frontend tests passed. Archived-finance correction was subsequently delivered in #152. Reconcile the known cohort through the deployed screens. |
| Funder gift history plus linked funded-program outcomes, period and provenance; missing distinct from zero | `packages/reporting/funder-packet.ts`, API `reporting.ts`, migration 010; web `pages/funders-live.ts`, `outcomes-upload.ts`. PRs #122, #128, #131. | Packet/API/upload tests cover per-currency attribution, unavailable/null/zero, scoped audited CSV, reviewed aggregate upload and stale sessions. Approved manual aggregate upload is the implemented Problem 1 fallback. Verify real CSV/print output and source approval with CIC. |
| Key-authenticated aggregate read API by period/program/owner; no donor/student PII | `packages/reporting/summary.ts`; API `dashboard.ts`, `api-keys.ts`; web `pages/api-access.ts`. | API dashboard/key tests and package reporting tests cover invalid keys, revocation, query allowlists, bounded limiting and suppression of groups under three. Run live 200/401/revocation and inspect the returned schema without exposing the key. |
| Scoped invite-only sign-in, admin MFA, board isolation; staff access controls | API `auth.ts`, `db.ts`, `members.ts`, `staff-invitations.ts`, `invitation-claim.ts`; migrations 001/012/013; Clerk-managed UI. PRs #144-#148/#154, MFA diagnostics #159/#164. | Auth/membership/invitation tests; web member/invitation/Clerk/session tests. Google SDK correction #146 was published. A real admin must complete their own MFA enrollment and fresh sign-in; no bypass is acceptable. Guided enrollment is being improved separately. Board and external donor roles do not inherit the admin MFA rule. |
| Deployment, documentation, backups, CI and accessibility | `vercel.json`, `src/index.ts`, `deploy/check-env.ts`, `deploy/smoke.ts`, `docs/DEPLOY.md`; PR #133; measured audit below. | Configuration/build/smoke fixture tests are code evidence. A successful hosted deployment, authenticated rehearsal, automatic backup schedule and actual restore are separate gates. At this snapshot the committed GitHub workflow is PR lint; automated typecheck/test gates still need verification or implementation. |

## P1 and P2 extensions

These are published/in-progress extensions, not a claim that P0 live acceptance is finished.

| Priority / requirement | Source and delivery | Evidence / open gate |
|---|---|---|
| P1 lapsed radar and suggested editable outreach | Web `pages/retention.ts`, server template `lapsed_nudge`, `core/outreach-live.ts`; PR #163 (`1194264`). | `lapsed-radar.spec.ts`, API outreach-message and `tests/outreach-live.test.ts` regressions. Reuses role-scoped retention and ordinary approval/send flow. Await integrated acceptance. |
| P1 reviewed text debrief | API `debrief.ts`, migration 016 (`b300659`); review UI is being integrated. | Independently reran `apps/api/debrief.test.ts`: 1/1 pass, including scope, replay, audit rollback and unapproved draft. Saving asserts a real meeting and can close a quarterly touch. The UI must make that assertion explicit; raw transcript extraction is local. Complete the UI rehearsal before marking this flow accepted. |
| P1 grounded AI update drafts with deterministic fallback | API `ai.ts`, `grounded-drafts.ts`; web `pages/grounded-update.ts`; migration 017. PRs #153/#158/#165/#166/#168. | Independent adapter/grounded tests: 3/3 pass at `76eb8f8`. Model receives synthetic fact IDs/categories, while factual wording comes from authorized local data. Recipient-aware retry correction #170 (`762e373`) addresses the review finding. Re-run integrated tests and live model acceptance after configuration. |
| P2 Ask your data | API `ask-data.ts`; web `pages/ask-data.ts`; PR #161 (`104baef`), shared adapter #153/#166. | Actual author checks: 6 API/helper/donor tests, 3 frontend tests, typecheck and production build pass. Supported grammar produces allowlisted owner/retention/status/currency/period/net-threshold filters and explanations. Unknown/personal wording clarifies; no generated SQL, raw question or donor records go to the model. Actual provider latency and broader wording are unverified. |
| P2 private donor impact feed | API `donor-impact.ts`, `donor-impact-admin.ts`, `donor-invitations.ts`; web `pages/donor-impact.ts`; migration 015. PRs #160/#162/#167 (`a8d9f48`, `6684392`, `717432c`). | Published author evidence covers verified-primary-email linkage, explicit opt-in, a separate donor reader role, own gifts and explicitly published current approved outcome versions. Independent integration/security and real invitation/browser acceptance remain required. External donor identity never receives staff permissions. |

## Measured accessibility

On **2026-11-15 12:44:36 UTC**, Lighthouse **13.6.0** audited `http://localhost:4200/sign-in` in a fresh isolated headless Chrome profile with mobile emulation. Accessibility scored **95/100**, meeting the PDF's **>=95** target for this page. Eighteen audits passed, 47 were not applicable, and Lighthouse reported no run warnings. The shared Chrome profile was not accessed or stopped.

One failed audit remains: Clerk's test-instance orange footer text **“Secured by”** has measured contrast **3.04:1**, below **4.5:1**. This result does not certify WCAG conformance or authenticated views. Keyboard/focus behavior, screen-reader operation, 400% zoom, authenticated mobile flows and non-sign-in routes still require manual checks.

The concise machine-readable result is [audits/sign-in-lighthouse-summary.json](audits/sign-in-lighthouse-summary.json). Raw HTML/JSON reports are local ignored artifacts under `.board-state/a11y/` in the audit worktree. The audited development server was a working checkout, not a deployed immutable release.

Reproduce using a **new unique profile path**, never a shared debugging profile:

```powershell
$env:CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$auditProfile = Join-Path $env:TEMP ('cic-a11y-' + [guid]::NewGuid())
npm exec --yes --package=lighthouse@13.6.0 -- lighthouse http://localhost:4200/sign-in --only-categories=accessibility --chrome-flags="--headless=new --disable-gpu --no-sandbox --user-data-dir=$auditProfile" --output=json --output=html --output-path=.board-state/a11y/sign-in-lighthouse --quiet
```

CLI reference: [GoogleChrome Lighthouse documentation](https://github.com/GoogleChrome/lighthouse#using-the-node-cli).

## Remaining release acceptance gates

- Run the full currently integrated test suite after all feature stacks and migrations are combined; earlier branch counts are not a release-wide guarantee.
- Verify the deployed same-origin app/API/config, Clerk sign-in and admin MFA, active board membership, cross-owner denials and external donor separation. Record the release commit and smoke result.
- Rehearse three-source import, repeat-safe gifts, manual-entry retry, ownership override, actual manual-send confirmation, matched retention and audited funder export with synthetic data. Keep real donor/student PII out of demo recordings.
- Apply only reviewed nonconflicting migrations in order with the migration owner; use the restricted runtime role. Never infer that a published migration has run on a real environment.
- Confirm CIC's real source mappings, status/refund/date meanings, contact consent/qualifying-touch policy, program attribution, approved outcome sources and desired current-owner reporting policy.
- Confirm hosting/auth/database/mail/model eligibility, usage caps and actual costs against the PDF's <=$20/month and <=$250 setup targets. No paid AI dependency is required for core flows.
- Verify automated typecheck/tests in CI, a scheduled backup policy, a private restore rehearsal and CIC ownership of accounts/domain. The runbook's backup instructions are not proof that backups/restores ran.
- Complete keyboard, focus, zoom and authenticated responsive checks; retain this sign-in score without presenting it as a site-wide audit.
- Finish the Team Dashboard project story, a demo video **no longer than four minutes**, its link and final **Submit** action. The README still needs the final verified live/demo links. These submission actions were not performed by this audit.

## Suggested roles, non-goals and deliberately deferred work

The PDF suggests fundraising/program staff grants beyond the demo's admin/board roles. The implemented staff boundary is admin/board; program-manager and fundraising-specific grant models must not be claimed complete. The P2 donor reader is separate, not a staff role.

The plan explicitly excludes payment processing, a full CRM replacement, prospect scraping, autonomous sending and likelihood-to-give scoring. Zeffy remains intake. Calendar/event suggestions, grant deadlines, voice uploads, automatic Meet ingestion, OAuth/transcription/MCP integrations, prospect discovery and custom-field configuration are deliberately deferred. Validated optional donor metadata is supported; a metadata editor is not a new role system or arbitrary schema management.

Manual send and approved aggregate outcome upload are specified fallbacks, not missing autonomous-provider features. Historical owner attribution is a future policy choice; the current implementation reports current ownership. The PDF's sample data, screenshots, dates and prices are planning examples, not production facts.
