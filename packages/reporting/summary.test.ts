import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiKeyError, QueryError, generateApiKey, hashApiKey, keyMatches, parseSummaryQuery, readApiKey,
  recentActivity, summarize, type SummaryGift,
} from './summary.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const AI = uuid(100), CAMP = uuid(101), OWNER_A = uuid(200), OWNER_B = uuid(201);
const gift = (donor: number, occurred_at: string, amount_cents: number, extra: Partial<SummaryGift> = {}): SummaryGift => ({
  donor_id: uuid(donor), occurred_at, amount_cents, refund_cents: 0, currency: 'USD', status: 'settled',
  program_id: AI, owner_id: OWNER_A, source: 'zeffy', ...extra,
});

test('generated API keys are prefixed, random, and only their SHA-256 hash is stored', () => {
  const a = generateApiKey(), b = generateApiKey();
  assert.match(a.key, /^cic_live_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.key, b.key);
  assert.equal(a.hash, hashApiKey(a.key));
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(a.hint, a.key.slice(0, 13));
  assert.ok(keyMatches(a.key, a.hash));
  assert.ok(!keyMatches(b.key, a.hash));
  assert.ok(!keyMatches(a.key, 'not-a-hash'));
});

test('readApiKey accepts a bearer or X-API-Key header and rejects everything else as 401', () => {
  const { key } = generateApiKey();
  assert.equal(readApiKey({ authorization: `Bearer ${key}` }), key);
  assert.equal(readApiKey({ 'x-api-key': key }), key);
  for (const headers of [{}, { authorization: key }, { authorization: 'Bearer ' }, { authorization: 'Basic abc' },
    { 'x-api-key': 'sk_test_clerk' }, { authorization: `Bearer ${key} extra` },
    { authorization: `Bearer ${key}`, 'x-api-key': generateApiKey().key }]) {
    assert.throws(() => readApiKey(headers), ApiKeyError, JSON.stringify(headers));
  }
});

test('summary queries are strictly validated and allowlisted', () => {
  assert.deepEqual(parseSummaryQuery({ from: '2026-01-01', to: '2026-11-15', groupBy: 'program' }, '-07:00'), {
    window: { from: '2026-01-01T00:00:00-07:00', to: '2026-11-15T00:00:00-07:00' }, groupBy: 'program',
  });
  assert.equal(parseSummaryQuery({ from: '2026-01-01', to: '2026-02-01' }, '-07:00').groupBy, 'month');
  for (const bad of [
    { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-03-01', to: '2026-03-01' },
    { from: '2026-03-01', to: '2026-02-01' }, { from: '2020-01-01', to: '2026-01-02' },
    { from: '2026-01-01', to: '2026-02-01', groupBy: 'donor' }, { from: '2026-01-01', to: '2026-02-01', sql: '1' },
    { from: '2026-01-01T00:00:00Z', to: '2026-02-01' }, { to: '2026-02-01' },
  ]) assert.throws(() => parseSummaryQuery(bad, '-07:00'), QueryError, JSON.stringify(bad));
});

const ledger = [
  gift(1, '2026-01-05T19:00:00Z', 10000), gift(2, '2026-01-20T19:00:00Z', 5000),
  gift(3, '2026-01-25T19:00:00Z', 2500, { refund_cents: 500 }),
  gift(4, '2026-02-01T06:30:00Z', 999),                               // Jan 31, 23:30 in Phoenix
  gift(5, '2026-02-10T19:00:00Z', 4000, { program_id: CAMP, owner_id: OWNER_B }),
  gift(1, '2026-02-11T19:00:00Z', 7000, { status: 'pending' }),
  gift(6, '2026-02-12T19:00:00Z', 1000, { program_id: null, owner_id: null }),
  gift(7, '2026-02-13T19:00:00Z', 3000, { currency: 'CAD' }),
  gift(8, '2025-12-31T19:00:00Z', 50000),                              // before window
];
const window = { from: '2026-01-01T00:00:00-07:00', to: '2026-03-01T00:00:00-07:00' };

test('summarize groups net cents by month in the CIC offset and suppresses small cohorts', () => {
  const r = summarize(ledger, { window, groupBy: 'month' }, { offset: '-07:00', minDonors: 3 });
  assert.deepEqual(r.groups, [
    { key: '2026-01', suppressed: false, donors: 4, currencies: { USD: { gifts: 4, net_cents: 17999 } } },
    { key: '2026-02', suppressed: false, donors: 4, currencies: {
      USD: { gifts: 3, net_cents: 5000 }, CAD: { gifts: 1, net_cents: 3000 } } },
  ]);
  assert.deepEqual(r.totals, { suppressed: false, donors: 7, currencies: {
    USD: { gifts: 7, net_cents: 22999 }, CAD: { gifts: 1, net_cents: 3000 } } });
});

test('program and owner groupings label missing values and hide groups under the threshold', () => {
  const byProgram = summarize(ledger, { window, groupBy: 'program' }, { offset: '-07:00', minDonors: 3 });
  assert.deepEqual(byProgram.groups.map((g) => [g.key, g.suppressed]),
    [[AI, false], [CAMP, true], ['unattributed', true]]);
  const hidden = byProgram.groups.find((g) => g.key === CAMP)!;
  assert.deepEqual(hidden, { key: CAMP, suppressed: true });
  const byOwner = summarize(ledger, { window, groupBy: 'owner' }, { offset: '-07:00', minDonors: 1 });
  assert.deepEqual(byOwner.groups.map((g) => g.key), [OWNER_A, OWNER_B, 'unassigned']);
  const tiny = summarize([gift(1, '2026-01-05T19:00:00Z', 100)], { window, groupBy: 'month' }, { offset: '-07:00', minDonors: 3 });
  assert.deepEqual(tiny.totals, { suppressed: true });
});

test('recent activity is newest-first, bounded, and carries no donor identity', () => {
  const items = recentActivity(ledger, { limit: 3, offset: '-07:00', programTitles: { [AI]: 'AI Academy', [CAMP]: 'Summer Camp' } });
  assert.deepEqual(items, [
    { date: '2026-02-13', program: 'AI Academy', source: 'zeffy', status: 'settled', currency: 'CAD', net_cents: 3000 },
    { date: '2026-02-12', program: 'Unattributed', source: 'zeffy', status: 'settled', currency: 'USD', net_cents: 1000 },
    { date: '2026-02-11', program: 'AI Academy', source: 'zeffy', status: 'pending', currency: 'USD', net_cents: 0 },
  ]);
  for (const item of items) assert.ok(!('donor_id' in item) && !('owner_id' in item));
  assert.throws(() => recentActivity(ledger, { limit: 0, offset: '-07:00', programTitles: {} }), QueryError);
  assert.throws(() => recentActivity(ledger, { limit: 101, offset: '-07:00', programTitles: {} }), QueryError);
  assert.equal(recentActivity([gift(1, '2026-01-05T19:00:00Z', 10, { status: 'void' })],
    { limit: 5, offset: '-07:00', programTitles: {} }).length, 0);
});
