import type { Gift } from '../contracts/index.ts';

/** The gift fields retention needs; rows come from an authorized, org-scoped query. */
export type RetentionGift = Pick<Gift,
  'donor_id' | 'amount_cents' | 'refund_cents' | 'currency' | 'occurred_at' | 'status'>;
/** Half-open window [from, to) as ISO timestamps with an offset. */
export type Window = { from: string; to: string };
export type RetentionWindows = { current: Window; prior: Window };

export const SEGMENTS = ['new', 'reactivated', 'increased', 'flat', 'decreased', 'lapsed'] as const;
export type Segment = typeof SEGMENTS[number];
export type SegmentTotals = { donors: number; prior_cents: number; current_cents: number };
export type DonorRetention = { donor_id: string; segment: Segment; prior_cents: number; current_cents: number };
export type CurrencyRetention = {
  donors: DonorRetention[];
  segments: Record<Segment, SegmentTotals>;
  /** Retained = increased + flat + decreased; rate is left to the caller to avoid float drift. */
  retention: { retained_donors: number; prior_donors: number };
  totals: { prior_cents: number; current_cents: number };
};
export type RetentionReport = { byCurrency: Record<string, CurrencyRetention> };

/** Settled giving net of refunds; pending and void gifts count zero. */
export function netCents(gift: RetentionGift): number {
  return gift.status === 'settled' ? gift.amount_cents - gift.refund_cents : 0;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const isoDay = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Year-to-date through `asOf` (inclusive day) versus the same span a year earlier,
 * both as half-open windows at midnight in a fixed UTC offset (CIC: Phoenix, -07:00).
 */
export function ytdWindows(asOf: string, offset: string): RetentionWindows {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  if (!day || !/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset)) throw new RangeError('Expected YYYY-MM-DD and ±HH:MM');
  const [y, m, d] = day.slice(1).map(Number);
  if (m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) throw new RangeError('Not a calendar date');
  const at = (date: string) => `${date}T00:00:00${offset}`;
  const priorDay = Math.min(d, daysIn(y - 1, m));
  return {
    current: { from: at(`${pad(y, 4)}-01-01`), to: at(isoDay(y, m, d + 1)) },
    prior: { from: at(`${pad(y - 1, 4)}-01-01`), to: at(isoDay(y - 1, m, priorDay + 1)) },
  };
}

// Real calendar date, explicit Z or ±HH:MM offset, up to microseconds (PostgreSQL's precision).
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

/** Exact instant in microseconds since the epoch; rejects anything Date.parse would normalize. */
function instant(value: string): bigint {
  const m = STAMP.exec(value);
  const [y, mo, d, h, mi, s] = (m?.slice(1, 7) ?? []).map(Number);
  if (!m || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59) {
    throw new RangeError(`Invalid timestamp: ${value}`);
  }
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[8]}`);
  return BigInt(ms) * 1000n + BigInt((m[7] ?? '').padEnd(6, '0'));
}

/** Cents addition that refuses to leave the exact integer range instead of rounding. */
function add(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError('Cents total exceeds the safe integer range');
  return sum;
}

function checkGift(g: RetentionGift): void {
  const cents = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!cents(g.amount_cents) || !cents(g.refund_cents) || g.refund_cents > g.amount_cents) {
    throw new RangeError('Gift amounts must be nonnegative integer cents with refund <= amount');
  }
  if (!/^[A-Z]{3}$/.test(g.currency)) throw new RangeError('Invalid currency');
  if (!['settled', 'pending', 'void'].includes(g.status)) throw new RangeError('Invalid gift status');
}

function segmentOf(prior: number, current: number, earlier: boolean): Segment | null {
  if (prior === 0) return current === 0 ? null : earlier ? 'reactivated' : 'new';
  if (current === 0) return 'lapsed';
  return current > prior ? 'increased' : current < prior ? 'decreased' : 'flat';
}

/**
 * Classify each donor by net giving in the current window against the prior window,
 * separately per currency. Donors with no net giving in either window are omitted.
 */
export function retentionReport(gifts: readonly RetentionGift[], windows: RetentionWindows): RetentionReport {
  const [cFrom, cTo, pFrom, pTo] = [windows.current.from, windows.current.to, windows.prior.from, windows.prior.to].map(instant);
  if (cFrom >= cTo || pFrom >= pTo) throw new RangeError('Window start must be before its end');
  if (pTo > cFrom) throw new RangeError('Prior window must not overlap the current window');

  // currency -> donor -> running sums
  const sums = new Map<string, Map<string, { prior: number; current: number; earlier: boolean }>>();
  for (const g of gifts) {
    checkGift(g);
    const t = instant(g.occurred_at);
    const net = netCents(g);
    if (net === 0 || t >= cTo) continue;
    const byDonor = sums.get(g.currency) ?? sums.set(g.currency, new Map()).get(g.currency)!;
    const s = byDonor.get(g.donor_id) ?? byDonor.set(g.donor_id, { prior: 0, current: 0, earlier: false }).get(g.donor_id)!;
    if (t >= cFrom) s.current = add(s.current, net);
    else {
      s.earlier = true;
      if (t >= pFrom && t < pTo) s.prior = add(s.prior, net);
    }
  }

  const byCurrency: Record<string, CurrencyRetention> = {};
  for (const [currency, byDonor] of sums) {
    const segments = Object.fromEntries(SEGMENTS.map((k) => [k, { donors: 0, prior_cents: 0, current_cents: 0 }])) as Record<Segment, SegmentTotals>;
    const donors: DonorRetention[] = [];
    for (const [donor_id, s] of [...byDonor].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const segment = segmentOf(s.prior, s.current, s.earlier);
      if (!segment) continue;
      donors.push({ donor_id, segment, prior_cents: s.prior, current_cents: s.current });
      const total = segments[segment];
      total.donors++;
      total.prior_cents = add(total.prior_cents, s.prior);
      total.current_cents = add(total.current_cents, s.current);
    }
    if (donors.length === 0) continue;
    const retained = segments.increased.donors + segments.flat.donors + segments.decreased.donors;
    byCurrency[currency] = {
      donors, segments,
      retention: { retained_donors: retained, prior_donors: retained + segments.lapsed.donors },
      totals: {
        prior_cents: donors.reduce((n, d) => add(n, d.prior_cents), 0),
        current_cents: donors.reduce((n, d) => add(n, d.current_cents), 0),
      },
    };
  }
  return { byCurrency };
}
