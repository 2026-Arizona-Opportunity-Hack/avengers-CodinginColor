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
