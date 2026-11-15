import assert from 'node:assert/strict';
import test from 'node:test';
import { netCents, retentionReport, ytdWindows, type RetentionGift } from './retention.ts';

const donor = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const gift = (n: number, occurred_at: string, amount_cents: number,
  extra: Partial<RetentionGift> = {}): RetentionGift => ({
  donor_id: donor(n), occurred_at, amount_cents, refund_cents: 0,
  currency: 'USD', status: 'settled', ...extra,
});

// Phoenix is UTC-7 all year. Report as of 2026-11-14: current = 2026 YTD, prior = 2025 same window.
const windows = ytdWindows('2026-11-14', '-07:00');

test('ytdWindows builds equal calendar windows with an exclusive end in the given offset', () => {
  assert.deepEqual(windows, {
    current: { from: '2026-01-01T00:00:00-07:00', to: '2026-11-15T00:00:00-07:00' },
    prior: { from: '2025-01-01T00:00:00-07:00', to: '2025-11-15T00:00:00-07:00' },
  });
});

test('ytdWindows maps Feb 29 to the end of Feb 28 in the prior year', () => {
  assert.deepEqual(ytdWindows('2028-02-29', '-07:00').prior,
    { from: '2027-01-01T00:00:00-07:00', to: '2027-03-01T00:00:00-07:00' });
});

test('ytdWindows rejects malformed dates and offsets', () => {
  assert.throws(() => ytdWindows('2026-13-01', '-07:00'));
  assert.throws(() => ytdWindows('2026-02-30', '-07:00'));
  assert.throws(() => ytdWindows('2026-11-14', 'MST'));
});

test('netCents counts only settled giving net of refunds', () => {
  assert.equal(netCents(gift(1, '2026-01-02T00:00:00Z', 5000, { refund_cents: 1500 })), 3500);
  assert.equal(netCents(gift(1, '2026-01-02T00:00:00Z', 5000, { status: 'pending' })), 0);
  assert.equal(netCents(gift(1, '2026-01-02T00:00:00Z', 5000, { status: 'void' })), 0);
  assert.equal(netCents(gift(1, '2026-01-02T00:00:00Z', 5000, { refund_cents: 5000 })), 0);
});

test('known synthetic cohort lands in every segment with exact totals', () => {
  const gifts = [
    gift(1, '2026-03-01T12:00:00Z', 10000),                       // new
    gift(2, '2023-06-01T12:00:00Z', 2500), gift(2, '2026-04-01T12:00:00Z', 5000), // reactivated
    gift(3, '2025-02-01T12:00:00Z', 5000), gift(3, '2026-02-01T12:00:00Z', 7500), // increased
    gift(4, '2025-05-01T12:00:00Z', 2500), gift(4, '2026-05-01T12:00:00Z', 2500), // flat
    gift(5, '2025-06-01T12:00:00Z', 20000), gift(5, '2026-06-01T12:00:00Z', 5000), // decreased
    gift(6, '2025-07-01T12:00:00Z', 15000),                       // lapsed
    gift(7, '2024-07-01T12:00:00Z', 9900),                        // inactive both windows: omitted
    gift(8, '2025-12-01T12:00:00Z', 4000), gift(8, '2026-07-01T12:00:00Z', 1000), // prior window ends Nov 15: new is wrong, reactivated
  ];
  const report = retentionReport(gifts, windows);
  assert.deepEqual(Object.keys(report.byCurrency), ['USD']);
  const usd = report.byCurrency.USD;
  assert.deepEqual(Object.fromEntries(usd.donors.map((d) => [d.donor_id, d.segment])), {
    [donor(1)]: 'new', [donor(2)]: 'reactivated', [donor(3)]: 'increased', [donor(4)]: 'flat',
    [donor(5)]: 'decreased', [donor(6)]: 'lapsed', [donor(8)]: 'reactivated',
  });
  assert.deepEqual(usd.segments, {
    new: { donors: 1, prior_cents: 0, current_cents: 10000 },
    reactivated: { donors: 2, prior_cents: 0, current_cents: 6000 },
    increased: { donors: 1, prior_cents: 5000, current_cents: 7500 },
    flat: { donors: 1, prior_cents: 2500, current_cents: 2500 },
    decreased: { donors: 1, prior_cents: 20000, current_cents: 5000 },
    lapsed: { donors: 1, prior_cents: 15000, current_cents: 0 },
  });
  assert.deepEqual(usd.retention, { retained_donors: 3, prior_donors: 4 });
  assert.deepEqual(usd.totals, { prior_cents: 42500, current_cents: 31000 });
});

test('window boundaries are inclusive at the start and exclusive at the end', () => {
  const report = retentionReport([
    gift(1, '2026-01-01T07:00:00Z', 100),  // exactly current.from (00:00 -07:00)
    gift(2, '2026-11-15T07:00:00Z', 100),  // exactly current.to: outside
    gift(2, '2025-11-15T06:59:59.999Z', 300), // last millisecond of prior window
  ], windows).byCurrency.USD;
  assert.deepEqual(Object.fromEntries(report.donors.map((d) => [d.donor_id, d.segment])),
    { [donor(1)]: 'new', [donor(2)]: 'lapsed' });
});

test('refunds and non-settled gifts change segments rather than counting as giving', () => {
  const report = retentionReport([
    gift(1, '2025-03-01T12:00:00Z', 5000),
    gift(1, '2026-03-01T12:00:00Z', 5000, { refund_cents: 5000 }), // fully refunded: lapsed
    gift(2, '2026-03-01T12:00:00Z', 5000, { status: 'pending' }),  // pending only: omitted
    gift(3, '2025-03-01T12:00:00Z', 4000),
    gift(3, '2026-03-01T12:00:00Z', 6000, { refund_cents: 2000 }), // net 4000: flat
  ], windows).byCurrency.USD;
  assert.deepEqual(Object.fromEntries(report.donors.map((d) => [d.donor_id, d.segment])),
    { [donor(1)]: 'lapsed', [donor(3)]: 'flat' });
});

test('currencies are never summed together', () => {
  const report = retentionReport([
    gift(1, '2025-03-01T12:00:00Z', 5000),
    gift(1, '2026-03-01T12:00:00Z', 9000, { currency: 'CAD' }),
  ], windows);
  assert.deepEqual(Object.keys(report.byCurrency).sort(), ['CAD', 'USD']);
  assert.equal(report.byCurrency.USD.donors[0].segment, 'lapsed');
  assert.equal(report.byCurrency.CAD.donors[0].segment, 'new');
});

test('invalid inputs are rejected instead of silently miscounted', () => {
  assert.throws(() => retentionReport([gift(1, 'not a date', 100)], windows));
  assert.throws(() => retentionReport([gift(1, '2026-03-01T12:00:00Z', 100, { refund_cents: 200 })], windows));
  assert.throws(() => retentionReport([gift(1, '2026-03-01T12:00:00Z', 1.5)], windows));
  assert.throws(() => retentionReport([], {
    current: windows.current, prior: { from: '2025-06-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
  }), /overlap/);
  assert.throws(() => retentionReport([], {
    current: { from: windows.current.to, to: windows.current.from }, prior: windows.prior,
  }));
});

test('sums that leave the safe-integer range are rejected, never rounded', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  // Donor sums: prior MAX+1 vs current MAX+2 used to round to equal ("flat").
  assert.throws(() => retentionReport([
    gift(1, '2025-03-01T12:00:00Z', MAX), gift(1, '2025-04-01T12:00:00Z', 1),
    gift(1, '2026-03-01T12:00:00Z', MAX), gift(1, '2026-04-01T12:00:00Z', 2),
  ], windows), /safe integer/);
  // Segment totals: each donor is safe, the segment sum is not.
  const half = Math.floor(MAX / 2) + 1;
  assert.throws(() => retentionReport([
    gift(1, '2026-03-01T12:00:00Z', half), gift(2, '2026-03-01T12:00:00Z', half),
  ], windows), /safe integer/);
  // Report totals: different segments, combined current total overflows.
  assert.throws(() => retentionReport([
    gift(1, '2026-03-01T12:00:00Z', half),
    gift(2, '2025-03-01T12:00:00Z', 1), gift(2, '2026-03-01T12:00:00Z', half),
  ], windows), /safe integer/);
});

test('timestamps must be real calendar instants with an explicit offset', () => {
  for (const bad of ['2026-02-30T12:00:00Z', '2026-03-01', '2026-03-01T00:00:00',
    '2026-03-01T24:00:00Z', '2026-03-01T12:00:00+25:00', '2026-03-01T12:00:00.1234567Z']) {
    assert.throws(() => retentionReport([gift(1, bad, 100)], windows), /timestamp/, bad);
    assert.throws(() => retentionReport([], {
      current: { from: bad, to: windows.current.to }, prior: windows.prior,
    }), /timestamp/, `window ${bad}`);
  }
  assert.doesNotThrow(() => retentionReport([gift(1, '2028-02-29T12:00:00-07:00', 100)], windows));
});

test('sub-millisecond precision is kept when comparing against window bounds', () => {
  const report = retentionReport([gift(1, '2026-11-15T07:00:00.000400Z', 100)], {
    current: { from: windows.current.from, to: '2026-11-15T07:00:00.000500Z' }, prior: windows.prior,
  }).byCurrency.USD;
  assert.equal(report.donors[0]?.segment, 'new');
});

test('an empty ledger yields an empty report', () => {
  assert.deepEqual(retentionReport([], windows), { byCurrency: {} });
});
