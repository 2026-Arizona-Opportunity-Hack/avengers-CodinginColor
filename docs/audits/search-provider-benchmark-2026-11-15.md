# Donor-search provider benchmark, November 15, 2026

Measured at 17:51:33 UTC against source main `cf88ea2`. Model:
`gemini-3.5-flash-lite`, provider origin `https://generativelanguage.googleapis.com`.
This is loopback HTTP with synthetic identities and a disposable PGlite database,
not a deployed Vercel, network, Neon or Clerk acceptance measurement.

Run from the repository root with existing provider configuration:

```sh
node --env-file=.env tools/benchmark-search.ts
```

The script requires a configured HTTPS provider and makes 16 provider requests.
It never connects to DATABASE_URL. Only allowlisted filters reach the model;
questions, donor rows and credentials are not printed or sent as model input.
Assertions check expected filters, donor IDs, clarification, privacy and fixture counts.
Missing configuration fails before setup or provider access.

The corpus contains eight supported searches and four unsupported/ambiguous questions,
each repeated twice. Supported cases cover own/admin scope, strict USD thresholds
with a partial refund, EUR isolation, lapsed donors and pending gifts. Clarification
cases cover a personal name, a currency without gift criteria, SQL injection wording
and an ambiguous pending-gift threshold. Expected answers are literal fixture facts,
independent of the intent parser. This small fixed corpus does not establish broad
natural-language accuracy, every reporting boundary or a model comparison.

| Measurement | Result |
|---|---:|
| Expected filters and donor results | 16/16 |
| Expected clarifications, without provider calls | 8/8 |
| Provider responses matching filter meaning | 16/16 |
| Advice accepted by current production comparison | 0/16 |
| Deterministic fallbacks | 16/16 |
| Provider unavailable / invalid schema / changed meaning | 0 / 0 / 0 |
| Supported HTTP p50 / p95 | 701.79 / 1228.26 ms |
| All HTTP p50 / p95 | 639.47 / 932.84 ms |
| Provider p50 / p95 | 680.15 / 933.63 ms |

Percentiles use nearest rank. Timings include body parsing and local scoped queries;
HTTP measurement excludes database/server setup and real identity verification.

The zero accepted-advice count is significant: `ask-data.ts` compares JSON strings.
Its locally constructed filter object's property order differs from the Zod-parsed
response's order. All 16 semantically correct responses were therefore rejected for
ordering, and local filters supplied every correct answer. This benchmark does not
claim AI interpretation success from correct fallback results. The script reports
ordering mismatches separately from genuinely changed filters. A preceding pilot
also passed 24/24, with 15 semantic echoes and one unavailable response; it is not
included in the table above.

Issue #109 remains open for deployed P0 acceptance, broader evaluation and disposition
of the ineffective optional-advice comparison. No donor data or real-account changes
were made. The script creates only disposable synthetic records locally.
