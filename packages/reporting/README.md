# Reporting calculations

Pure, dependency-free reporting logic (Person 5). There's no database or HTTP code
here. The API layer runs an authorized, org-scoped query and passes the rows in.

## Retention (`retention.ts`, issue #27)

`retentionReport(gifts, windows)` classifies each donor by **net** giving
(settled `amount_cents - refund_cents`; pending and void count zero) in the
current window against the prior window. It does this **separately per currency**,
so amounts are never summed across currencies.

| Segment | Prior / current net |
|---|---|
| `new` | 0 / > 0, no earlier settled giving |
| `reactivated` | 0 / > 0, earlier settled giving exists |
| `increased` | > 0 / greater than prior |
| `flat` | > 0 / same |
| `decreased` | > 0 / lower but > 0 |
| `lapsed` | > 0 / 0 |

Donors with no net giving in either window are left out. Windows are half-open
`[from, to)`, and the prior window must end at or before the current one starts.
`ytdWindows('2026-11-14', '-07:00')` builds year-to-date against prior
year-to-date at midnight Phoenix time; on Feb 29 the prior window ends after
Feb 28. The output contains per-donor rows, per-segment counts and cents,
`retention: { retained_donors, prior_donors }` (the caller computes the rate),
and totals. Invalid amounts, timestamps or windows throw instead of being miscounted.
Timestamps must be real calendar instants with an explicit `Z` or `±HH:MM` offset and
at most 6 fractional digits. They're compared at microsecond precision. Any donor,
segment or report sum that would leave the safe-integer range throws instead of rounding.

```powershell
npm ci
node --test packages/reporting/*.test.ts
npx tsc -p packages/reporting
```

## Funder packet (`funder-packet.ts`, issue #28)

`buildFunderPacket({ funder, program, period, gifts, outcomes })` takes one funder's
gifts (already scoped by an authorized query) and returns:

- **gifts** in the half-open period, labeled `program` (the gift funds the chosen
  program) or `unattributed` (no program). Gifts for other programs are left out.
- **totals** per attribution and per currency: gift count, gross, refunds and net,
  in integer cents. Pending and void gifts are listed but add nothing.
- **outcomes**: only **approved** rows for that program whose period overlaps. A
  `null` value is `not_reported`, which is never the same as a reported `0`.
  `outcomes_status: 'unavailable'` when nothing approved applies.

`packetCsv(packet)` writes a spreadsheet-safe CSV (header, gifts, totals, outcomes).
Every cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` (CSV/formula
injection), and fields are quoted per RFC 4180. Money uses `formatCents` (exact
`1234.56`, no floating point). Exporting is admin-only; enforce that in the route.

## Summary and activity API core (`summary.ts`, issue #29)

This is the pure core behind `GET /api/v1/summary` and `GET /api/v1/activity`. The
route and the `api_keys` table come in a later slice.

- **Keys:** `generateApiKey()` returns `cic_live_` plus 32 random bytes (base64url).
  Show the key once and store only `hashApiKey(key)` (SHA-256 hex) and the `hint`.
  `keyMatches` compares in constant time. `readApiKey(headers)` accepts
  `Authorization: Bearer <key>` **or** `X-API-Key: <key>` (never both). Anything else
  throws `ApiKeyError`, which maps to 401.
- **Query:** `parseSummaryQuery({from, to, groupBy}, '-07:00')` takes CIC-local days
  (`to` exclusive), an allowlisted `groupBy` of `month` (default), `program` or
  `owner`, and at most a 5-year range. Unknown parameters throw `QueryError`, which
  maps to 400.
- **Summary:** `summarize(gifts, query, {offset, minDonors})` gives net cents and gift
  counts **per currency**, plus distinct donor counts, for each group and in total.
  Void gifts are ignored; pending gifts count as gifts with 0 net. A group, or the
  totals, with fewer than `minDonors` donors is returned as `{ key, suppressed: true }`
  with no numbers. Missing program or owner values show as `unattributed` and
  `unassigned`.
- **Activity:** `recentActivity(gifts, {limit 1-100, offset, programTitles})` returns
  the newest non-void gifts as `{date, program, source, status, currency, net_cents}`,
  with **no donor or owner identifiers**. Exact amounts and dates can still hint at
  identity in a small org, so only expose this feed to the dashboard key.

## Dashboard API for CIC's org dashboard (#29)

Two read-only endpoints for CIC's own dashboard. They need **no sign-in**, only an API
key, and return **aggregates only**: no donor names, contact details or IDs.

**Issue a key** (a person, on their machine, with `MIGRATION_DATABASE_URL` and `CIC_ORG_ID` set):

```powershell
node --env-file-if-exists=.env db/api-key.ts create "Org dashboard" user_<admin's Clerk ID>
node --env-file-if-exists=.env db/api-key.ts list
node --env-file-if-exists=.env db/api-key.ts revoke cic_live_AbCd   # by the 13-character hint
```

The full key is printed **once**; only its SHA-256 hash is stored. Keep it in the
dashboard's secret settings, never in code or chat.

**Call it** with `Authorization: Bearer <key>` (or `X-API-Key: <key>`, but not both):

```bash
curl -H "Authorization: Bearer $CIC_DASHBOARD_KEY" \
  "https://<host>/api/v1/summary?from=2026-01-01&to=2026-11-15&groupBy=program"
curl -H "Authorization: Bearer $CIC_DASHBOARD_KEY" "https://<host>/api/v1/activity?limit=20"
```

| Endpoint | Query | Returns |
|---|---|---|
| `GET /api/v1/summary` | `from`, `to`: CIC-local `YYYY-MM-DD` (`to` exclusive, ≤ 5 years); `groupBy`: `month` (default), `program` or `owner` | `{window, groupBy, totals, groups: [{key, label, suppressed, donors?, currencies?}], retention: {windows: {current, prior}, byCurrency: {[currency]: {suppressed, retained_donors?, prior_donors?}}}}` |
| `GET /api/v1/activity` | `limit` 1-100 (default 20) | `{items: [{date, program, source, status, currency, net_cents}]}`, newest first |

- Amounts are integer cents, kept separate per currency.
- Any group, or the totals, with fewer than **3** donors comes back as
  `{key, label, suppressed: true}` with no numbers.
- `owner` keys are membership IDs.
- Retention compares positive settled net giving in the selected window with the immediately
  matching calendar window one year earlier, independently of `groupBy`. Each currency is separate;
  prior cohorts below **3**, or nonzero retained, lapsed or current-only cohorts below **3**,
  return only `{suppressed: true}`. Donor identities and individual segments are never returned.
- **Errors:** `401` for a missing, malformed, unknown or revoked key; `400` for a bad
  query; `429` after 60 requests per minute per key (honor `Retry-After`); `503` if
  the database is unavailable.
- Summary and activity share one PostgreSQL quota per valid key across app instances.
  Counters reset on database calendar-minute boundaries; rejected requests also count.
  Unknown or revoked keys do not allocate counters. Quota failures return `503`.

### Aggregate access audit rollout

Migration `019_aggregate_access_audit.sql` prepares append-only service-key audit storage.
Apply the reviewed migration before deploying the dependent API integration; the schema
alone does not record requests. Events contain only organization/key IDs, fixed route,
200/429 status, event ID and timestamp. No credentials, hashes, queries or donor data are stored.
Only organization admins can read events through the runtime role. Unknown/revoked keys
cannot append events, and application roles cannot update/delete history.

The dependent dashboard integration records authenticated 200/429 outcomes in the
same transaction as quota consumption, before returning data or a retry response.
Aggregation, serialization or audit failures return no aggregates and roll back both.
Other failure statuses are outside this initial audit scope.

Rollback the calling application first and retain the table/history. There is no automatic
purge or cascading deletion. CIC's operator must confirm retention and review event volume;
this migration does not authorize a retention job, production execution or rollout.
