import { Gift } from './models';

/**
 * Segment rules match packages/reporting/retention.ts (issue #27): net settled cents,
 * current window against prior window, half-open [from, to). When the reporting route
 * (GET /api/v1/reports/retention) is deployed, the page reads its output instead.
 */
export const SEGMENTS = ['new', 'reactivated', 'increased', 'flat', 'decreased', 'lapsed'] as const;
export type Segment = (typeof SEGMENTS)[number];
export type Window = { from: string; to: string };

export const SEGMENT_COPY: Record<Segment, { label: string; rule: string }> = {
  new: { label: 'New', rule: 'First settled gift ever falls in this period.' },
  reactivated: { label: 'Reactivated', rule: 'Gave before, skipped last period, gave again now.' },
  increased: { label: 'Increased', rule: 'Gave in both periods; more this period.' },
  flat: { label: 'Flat', rule: 'Gave the same net amount in both periods.' },
  decreased: { label: 'Decreased', rule: 'Gave in both periods; less this period.' },
  lapsed: { label: 'Lapsed', rule: 'Gave last period, nothing yet this period.' },
};

export interface DonorSegment { donor_id: string; segment: Segment; prior_cents: number; current_cents: number; }
export interface RetentionResult {
  windows: { current: Window; prior: Window };
  donors: DonorSegment[];
  counts: Record<Segment, number>;
  cents: Record<Segment, { prior: number; current: number }>;
  retained: number;
  priorDonors: number;
  totals: { prior: number; current: number };
}

const net = (g: Gift) => (g.status === 'settled' ? g.amount_cents - g.refund_cents : 0);
const inWindow = (at: string, w: Window) => Date.parse(at) >= Date.parse(w.from) && Date.parse(at) < Date.parse(w.to);

export function ytdWindows(asOf: string): { current: Window; prior: Window } {
  const y = Number(asOf.slice(0, 4));
  const next = new Date(`${asOf}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  const end = next.toISOString().slice(5, 10);
  const priorEnd = end === '02-29' ? '03-01' : end;
  return {
    current: { from: `${y}-01-01T00:00:00-07:00`, to: `${next.toISOString().slice(0, 10)}T00:00:00-07:00` },
    prior: { from: `${y - 1}-01-01T00:00:00-07:00`, to: `${end === '01-01' ? y : y - 1}-${priorEnd}T00:00:00-07:00` },
  };
}

export function yearWindows(year: number): { current: Window; prior: Window } {
  return {
    current: { from: `${year}-01-01T00:00:00-07:00`, to: `${year + 1}-01-01T00:00:00-07:00` },
    prior: { from: `${year - 1}-01-01T00:00:00-07:00`, to: `${year}-01-01T00:00:00-07:00` },
  };
}

export function retention(gifts: Gift[], windows: { current: Window; prior: Window }): RetentionResult {
  const byDonor = new Map<string, { prior: number; current: number; earlier: number }>();
  for (const g of gifts) {
    const n = net(g);
    if (n <= 0) continue;
    const row = byDonor.get(g.donor_id) ?? { prior: 0, current: 0, earlier: 0 };
    if (inWindow(g.occurred_at, windows.current)) row.current += n;
    else if (inWindow(g.occurred_at, windows.prior)) row.prior += n;
    else if (Date.parse(g.occurred_at) < Date.parse(windows.prior.from)) row.earlier += n;
    byDonor.set(g.donor_id, row);
  }
  const counts = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<Segment, number>;
  const cents = Object.fromEntries(SEGMENTS.map((s) => [s, { prior: 0, current: 0 }])) as RetentionResult['cents'];
  const donors: DonorSegment[] = [];
  let priorDonors = 0, retained = 0, tp = 0, tc = 0;
  for (const [donor_id, v] of byDonor) {
    let segment: Segment | null = null;
    if (v.prior === 0 && v.current > 0) segment = v.earlier > 0 ? 'reactivated' : 'new';
    else if (v.prior > 0 && v.current === 0) segment = 'lapsed';
    else if (v.prior > 0 && v.current > 0) segment = v.current > v.prior ? 'increased' : v.current < v.prior ? 'decreased' : 'flat';
    if (!segment) continue;
    if (v.prior > 0) priorDonors++;
    if (segment === 'increased' || segment === 'flat' || segment === 'decreased') retained++;
    counts[segment]++;
    cents[segment].prior += v.prior; cents[segment].current += v.current;
    tp += v.prior; tc += v.current;
    donors.push({ donor_id, segment, prior_cents: v.prior, current_cents: v.current });
  }
  return { windows, donors, counts, cents, retained, priorDonors, totals: { prior: tp, current: tc } };
}
