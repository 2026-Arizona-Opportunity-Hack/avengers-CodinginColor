import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFunderPacket, formatCents, packetCsv, type PacketGift, type PacketOutcome } from './funder-packet.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const AI = uuid(100);
const CAMP = uuid(200);
const gift = (n: number, occurred_at: string, amount_cents: number, extra: Partial<PacketGift> = {}): PacketGift => ({
  id: uuid(n), donor_id: uuid(1), occurred_at, amount_cents, refund_cents: 0, currency: 'USD',
  status: 'settled', source: 'zeffy', external_id: `z-${n}`, program_id: AI, ...extra,
});
const outcome = (extra: Partial<PacketOutcome> = {}): PacketOutcome => ({
  program_id: AI, period: { from: '2026-01-01T00:00:00-07:00', to: '2026-07-01T00:00:00-07:00' },
  metric: 'Students completing AI Academy', value: 42, unit: 'students', denominator: 50,
  source: 'Problem 1 aggregate API', approved_at: '2026-07-15T10:00:00-07:00', ...extra,
});
const base = {
  funder: { name: 'Example Foundation' },
  program: { id: AI, title: 'AI Academy' },
  period: { from: '2026-01-01T00:00:00-07:00', to: '2027-01-01T00:00:00-07:00' },
};

test('formatCents renders exact decimal currency without floating point', () => {
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatCents(123456), '1234.56');
  assert.equal(formatCents(Number.MAX_SAFE_INTEGER), '90071992547409.91');
  assert.throws(() => formatCents(1.5));
  assert.throws(() => formatCents(-1));
});

test('packet lists program and unattributed gifts in period with exact net totals', () => {
  const packet = buildFunderPacket({ ...base, outcomes: [outcome()], gifts: [
    gift(1, '2026-02-01T12:00:00Z', 50000),
    gift(2, '2026-03-01T12:00:00Z', 20000, { refund_cents: 5000 }),
    gift(3, '2026-04-01T12:00:00Z', 10000, { status: 'pending' }),   // listed, counts zero
    gift(4, '2026-05-01T12:00:00Z', 7500, { program_id: null }),     // unattributed
    gift(5, '2026-06-01T12:00:00Z', 9999, { program_id: uuid(101) }), // other program: excluded
    gift(6, '2025-12-31T12:00:00Z', 1000),                          // before period: excluded
    gift(7, '2027-01-01T07:00:00Z', 1000),                          // exactly period end: excluded
  ] });
  assert.deepEqual(packet.gifts.map((g) => [g.id, g.attribution, g.net_cents]), [
    [uuid(1), 'program', 50000], [uuid(2), 'program', 15000],
    [uuid(3), 'program', 0], [uuid(4), 'unattributed', 7500],
  ]);
  assert.deepEqual(packet.totals, {
    program: { USD: { gifts: 3, gross_cents: 70000, refund_cents: 5000, net_cents: 65000 } },
    unattributed: { USD: { gifts: 1, gross_cents: 7500, refund_cents: 0, net_cents: 7500 } },
  });
});

test('pending and void gifts add no gross or net; currencies stay separate', () => {
  const packet = buildFunderPacket({ ...base, outcomes: [], gifts: [
    gift(1, '2026-02-01T12:00:00Z', 1000, { status: 'void' }),
    gift(2, '2026-02-01T12:00:00Z', 2000, { currency: 'CAD' }),
  ] });
  assert.deepEqual(packet.totals.program, {
    USD: { gifts: 1, gross_cents: 0, refund_cents: 0, net_cents: 0 },
    CAD: { gifts: 1, gross_cents: 2000, refund_cents: 0, net_cents: 2000 },
  });
});

test('missing outcome data is reported as unavailable, never as zero', () => {
  const none = buildFunderPacket({ ...base, gifts: [], outcomes: [
    outcome({ approved_at: null }),        // not approved: excluded
    outcome({ program_id: uuid(101) }),     // other program: excluded
    outcome({ period: { from: '2025-01-01T00:00:00-07:00', to: '2025-07-01T00:00:00-07:00' } }), // outside period
  ] });
  assert.equal(none.outcomes_status, 'unavailable');
  assert.deepEqual(none.outcomes, []);

  const partial = buildFunderPacket({ ...base, gifts: [], outcomes: [
    outcome(), outcome({ metric: 'Average learning gain', value: null, unit: 'points', denominator: null }),
    outcome({ metric: 'Students who failed', value: 0, denominator: 50 }),
  ] });
  assert.equal(partial.outcomes_status, 'available');
  assert.deepEqual(partial.outcomes.map((o) => [o.metric, o.status, o.value]), [
    ['Students completing AI Academy', 'reported', 42],
    ['Average learning gain', 'not_reported', null],
    ['Students who failed', 'reported', 0],
  ]);
});

test('CSV neutralizes spreadsheet formulas and quotes delimiters', () => {
  const packet = buildFunderPacket({ ...base, funder: { name: '=HYPERLINK("http://x","click")' },
    outcomes: [outcome({ metric: '+SUM(A1:A9)', value: null, unit: 'n', denominator: null })],
    gifts: [gift(1, '2026-02-01T12:00:00Z', 1234, { source: '@cmd', external_id: '-2+3' }),
      gift(2, '2026-02-02T12:00:00Z', 100, { source: 'tab\there', external_id: 'line\nbreak, "q"', program_id: null })] });
  const cells = parseCsv(packetCsv(packet)).flat();
  for (const cell of cells) assert.ok(!/^[=+\-@\t\r]/.test(cell), `unsafe cell: ${JSON.stringify(cell)}`);
  for (const expected of [`'=HYPERLINK("http://x","click")`, "'@cmd", "'-2+3", "'+SUM(A1:A9)",
    'line\nbreak, "q"', '12.34', 'Not reported', 'unattributed']) {
    assert.ok(cells.includes(expected), `missing cell ${JSON.stringify(expected)}`);
  }
});

/** Minimal RFC 4180 reader for the test: quoted fields, doubled quotes, CRLF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [[]];
  let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { rows.at(-1)!.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { rows.at(-1)!.push(cell); cell = ''; rows.push([]); i++; }
    else cell += c;
  }
  rows.at(-1)!.push(cell);
  return rows;
}

test('invalid inputs are rejected', () => {
  assert.throws(() => buildFunderPacket({ ...base, outcomes: [], gifts: [gift(1, '2026-02-30T12:00:00Z', 1)] }), /timestamp/);
  assert.throws(() => buildFunderPacket({ ...base, outcomes: [], gifts: [gift(1, '2026-02-01T12:00:00Z', 1, { refund_cents: 2 })] }));
  assert.throws(() => buildFunderPacket({ ...base, period: { from: base.period.to, to: base.period.from }, outcomes: [], gifts: [] }));
  assert.throws(() => buildFunderPacket({ ...base, gifts: [], outcomes: [outcome({ value: Number.NaN })] }));
  const half = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
  assert.throws(() => buildFunderPacket({ ...base, outcomes: [], gifts: [
    gift(1, '2026-02-01T12:00:00Z', half), gift(2, '2026-02-02T12:00:00Z', half)] }), /safe integer/);
});
