# Service acceptance, 15 November 2026

These results distinguish implementation, local browser acceptance and deployed acceptance. The deployed frontend remains a release blocker.

## Actual Clerk browser check

A temporary verified `+clerk_test` account completed password sign-in, device verification and the instance-required authenticator enrollment through the normal local sign-in component. After the pending-session fix in PR #216, the same session became active and entered the board dashboard with the spotlight tour. Donors, Follow-ups, Retention, Ask your data and Account opened without session errors. Requests for membership, donors, gifts, communications, follow-ups, drafts, catalog and retention returned 200.

The test account had no assigned donor records. Its Clerk user and database membership were removed afterward. No real user's credentials, security settings or donor records changed. This validates the local board session/task flow, not a real user's Google sign-in, admin authenticator, or the production origin. Clerk currently requires MFA setup at the instance level; the application's board role itself does not require MFA.

## Actual Neon permission and migration checks

Reviewed PR #211 was applied after its exact-head PostgreSQL 17 rehearsal and application CI passed. It corrected twelve function ACLs and adopted the equivalent already-installed invitation functions into the canonical 013/018 migration history. It did not replay migration 018 or alter donor rows or function bodies. A second invocation returned `already_applied`.

Independent read-only verification found 18 applied migrations, no checksum mismatches, no pending migration, and zero public-executable functions among the thirteen public SECURITY DEFINER functions. Function definitions, owners, configuration, managed role memberships and schema grants remained unchanged.

A read-only synthetic-auth harness against the real restricted Neon connection verified 26 admin-visible donors; two board members each saw their own disjoint 13 donors and 26/27 gifts. Cross-owner donor reads returned 404. Retention results contained owned donor IDs only. Board access to member administration and the separate donor feed returned 403. Admin access without MFA returned 403, while board sessions without MFA remained valid at the application layer. This harness verifies database and route boundaries; it is separate from Clerk browser acceptance.

## Configured-provider Ask your data benchmark

At 17:53 UTC, eight labeled synthetic questions ran against the actual Neon connection and `gemini-3.5-flash-lite` through the application's normal Ask route. Transactions were read-only; authentication was a synthetic harness. All eight produced the expected filters or clarification. The four recognized questions made four provider calls, all with exact valid filter output. Clarification cases made no provider call.

| Measurement | Result |
| --- | --- |
| Labeled intent/clarification cases | 8/8 correct |
| Provider semantically matching structured output | 4/4 correct |
| Answered request p50 (nearest rank) | 1,594 ms |
| Answered request p95 | 2,966 ms |
| Clarification p50 (nearest rank) | 380 ms |
| Provider request duration | 585–927 ms |

With only four answered requests, p95 is the sample maximum. This is one small functional benchmark, not a general accuracy estimate, load test, production latency guarantee, or a claim that the free tier will always cover usage. The model received only validated, nonpersonal filter objects; the raw questions and donor records were not sent. Raw sanitized results and expected filters are in [the benchmark artifact](ask-data-benchmark-2026-11-15.json).

This pilot checks semantic equality of provider output but does not instrument whether the route selects it. The separate [corpus benchmark](search-provider-benchmark-2026-11-15.md) found that valid model output was rejected by the route's JSON property-order comparison. Therefore correct final filters and schema-valid responses are not evidence of accepted AI interpretation; deterministic fallback remains part of these measurements.

## Desktop tour and release limits

The anchored board-member tour passed its focused geometry, nested scrolling, navigation, Escape and focus checks, synthetic browser verification, independent screenshot review, and the integrated frontend suite (111 tests before the later session regression was added). PR #202 merged with all CI checks passing. The [desktop screenshot](board-tour-desktop.png) uses synthetic data. Mobile polish is not a release gate per the user's later instruction.

At the latest public check, `https://cadence-cic.vercel.app` passed health, unauthenticated API rejection, foreign-origin rejection and API 404 checks, but `/`, `/donors` and `/config.json` returned JSON 404s: 4/7 deployment smoke checks. PR #214 adds a frontend-serving fallback; actual Vercel asset/builder verification remains in progress. Do not describe production as fully working until the deployed smoke and browser checks pass.
