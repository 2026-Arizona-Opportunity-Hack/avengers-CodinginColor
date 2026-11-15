import type { ApiRetention } from './api';
import { SEGMENTS, type RetentionResult, type Segment } from './retention';

/** Read contract of GET /api/v1/reports/funder-packet. Amounts are integer cents. */
export interface ApiFunderPacket {
  funder: { name: string }; program: { id: string; title: string }; period: { from: string; to: string };
  gifts: Array<{ id: string; occurred_at: string; attribution: 'program' | 'unattributed'; status: string;
    currency: string; amount_cents: number; refund_cents: number; net_cents: number; source: string; external_id: string | null }>;
  totals: Record<'program' | 'unattributed', Record<string, { gifts: number; gross_cents: number; refund_cents: number; net_cents: number }>>;
  outcomes_status: 'available' | 'unavailable';
  outcomes: Array<{ metric: string; value: number | null; unit: string; denominator: number | null;
    period: { from: string; to: string }; source: string; approved_at: string }>;
}

/** Server currency report in the page's shape. Segment rules are identical; see core/retention.ts. */
export function retentionFromServer(report: ApiRetention, currency: string): RetentionResult {
  const c = report.byCurrency[currency];
  const counts = Object.fromEntries(SEGMENTS.map((s) => [s, c?.segments[s]?.donors ?? 0])) as RetentionResult['counts'];
  const cents = Object.fromEntries(SEGMENTS.map((s) => [s, { prior: c?.segments[s]?.prior_cents ?? 0, current: c?.segments[s]?.current_cents ?? 0 }])) as RetentionResult['cents'];
  return {
    windows: report.windows, counts, cents,
    donors: (c?.donors ?? []).filter((d): d is typeof d & { segment: Segment } => (SEGMENTS as readonly string[]).includes(d.segment)),
    retained: c?.retention.retained_donors ?? 0, priorDonors: c?.retention.prior_donors ?? 0,
    totals: { prior: c?.totals.prior_cents ?? 0, current: c?.totals.current_cents ?? 0 },
  };
}

