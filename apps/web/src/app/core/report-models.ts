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
