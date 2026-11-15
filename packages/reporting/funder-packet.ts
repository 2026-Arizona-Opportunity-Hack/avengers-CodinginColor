import { add, checkGift, instant, netCents, type RetentionGift, type Window } from './retention.ts';

/** A funder's gift, already filtered to that funder by an authorized query. */
export type PacketGift = RetentionGift & {
  id: string; source: string; external_id?: string | null;
  /** Program the gift's campaign funds; null when the gift isn't attributed to any program. */
  program_id: string | null;
};
/** A program outcome row. Only approved rows are ever shown to a funder. */
export type PacketOutcome = {
  program_id: string; period: Window; metric: string;
  /** null means "not reported", which is different from a reported 0. */
  value: number | null; unit: string; denominator: number | null;
  source: string; approved_at: string | null;
};
export type PacketInput = {
  funder: { name: string }; program: { id: string; title: string }; period: Window;
  gifts: readonly PacketGift[]; outcomes: readonly PacketOutcome[];
};
export type Attribution = 'program' | 'unattributed';
export type PacketTotals = { gifts: number; gross_cents: number; refund_cents: number; net_cents: number };
export type FunderPacket = {
  funder: { name: string }; program: { id: string; title: string }; period: Window;
  gifts: Array<{ id: string; occurred_at: string; attribution: Attribution; status: PacketGift['status'];
    currency: string; amount_cents: number; refund_cents: number; net_cents: number;
    source: string; external_id: string | null }>;
  /** Per attribution, per currency: amounts are never summed across currencies. */
  totals: Record<Attribution, Record<string, PacketTotals>>;
  outcomes: Array<Omit<PacketOutcome, 'approved_at'> & { approved_at: string; status: 'reported' | 'not_reported' }>;
  /** 'unavailable' when no approved outcome covers this program and period. */
  outcomes_status: 'available' | 'unavailable';
};

/** Exact "1234.56" from integer cents; no floating point. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('Expected nonnegative integer cents');
  const b = BigInt(cents);
  return `${b / 100n}.${(b % 100n).toString().padStart(2, '0')}`;
}

function checkWindow(w: Window): [bigint, bigint] {
  const [from, to] = [instant(w.from), instant(w.to)];
  if (from >= to) throw new RangeError('Period start must be before its end');
  return [from, to];
}

export function buildFunderPacket(input: PacketInput): FunderPacket {
  const [from, to] = checkWindow(input.period);
  const totals: FunderPacket['totals'] = { program: {}, unattributed: {} };
  const rows = [];
  for (const g of input.gifts) {
    checkGift(g);
    const t = instant(g.occurred_at);
    if (t < from || t >= to) continue;
    const attribution: Attribution | null = g.program_id === input.program.id ? 'program'
      : g.program_id === null ? 'unattributed' : null;
    if (!attribution) continue;
    const settled = g.status === 'settled';
    const row = {
      id: g.id, occurred_at: g.occurred_at, attribution, status: g.status, currency: g.currency,
      amount_cents: g.amount_cents, refund_cents: g.refund_cents, net_cents: netCents(g),
      source: g.source, external_id: g.external_id ?? null,
    };
    const sum = totals[attribution][g.currency] ??= { gifts: 0, gross_cents: 0, refund_cents: 0, net_cents: 0 };
    sum.gifts++;
    sum.gross_cents = add(sum.gross_cents, settled ? g.amount_cents : 0);
    sum.refund_cents = add(sum.refund_cents, settled ? g.refund_cents : 0);
    sum.net_cents = add(sum.net_cents, row.net_cents);
    rows.push({ t, row });
  }
  rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.row.id < b.row.id ? -1 : 1));

  const outcomes: FunderPacket['outcomes'] = [];
  for (const o of input.outcomes) {
    const finite = (n: number | null) => n === null || Number.isFinite(n);
    if (!finite(o.value) || !finite(o.denominator) || (o.denominator !== null && o.denominator <= 0)) {
      throw new RangeError(`Invalid outcome value for ${o.metric}`);
    }
    const [oFrom, oTo] = checkWindow(o.period);
    if (o.approved_at === null) continue;
    instant(o.approved_at);
    if (o.program_id !== input.program.id || oFrom >= to || oTo <= from) continue;
    outcomes.push({ ...o, approved_at: o.approved_at, status: o.value === null ? 'not_reported' : 'reported' });
  }
  return {
    funder: input.funder, program: input.program, period: input.period,
    gifts: rows.map((r) => r.row), totals, outcomes,
    outcomes_status: outcomes.length > 0 ? 'available' : 'unavailable',
  };
}

/** One CSV cell: neutralize formula triggers (OWASP CSV injection), then RFC 4180 quoting. */
function cell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Spreadsheet-safe CSV of the packet: header, gifts, totals and outcomes sections. */
export function packetCsv(p: FunderPacket): string {
  const rows: Array<Array<string | number | null>> = [
    ['Funder packet'], ['Funder', p.funder.name], ['Program', p.program.title],
    ['Period start', p.period.from], ['Period end (exclusive)', p.period.to], [],
    ['Gifts'], ['Date', 'Attribution', 'Status', 'Currency', 'Amount', 'Refund', 'Net', 'Source', 'External ID'],
    ...p.gifts.map((g) => [g.occurred_at, g.attribution, g.status, g.currency, formatCents(g.amount_cents),
      formatCents(g.refund_cents), formatCents(g.net_cents), g.source, g.external_id]),
    [], ['Totals'], ['Attribution', 'Currency', 'Gifts', 'Gross', 'Refunds', 'Net'],
    ...(['program', 'unattributed'] as const).flatMap((a) => Object.entries(p.totals[a]).map(([cur, t]) =>
      [a, cur, t.gifts, formatCents(t.gross_cents), formatCents(t.refund_cents), formatCents(t.net_cents)])),
    [], ['Program outcomes'],
    ...(p.outcomes_status === 'unavailable'
      ? [['No approved outcome data for this program and period']]
      : [['Metric', 'Value', 'Unit', 'Denominator', 'Period start', 'Period end (exclusive)', 'Source', 'Approved'],
        ...p.outcomes.map((o) => [o.metric, o.value === null ? 'Not reported' : o.value, o.unit,
          o.denominator, o.period.from, o.period.to, o.source, o.approved_at])]),
  ];
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
