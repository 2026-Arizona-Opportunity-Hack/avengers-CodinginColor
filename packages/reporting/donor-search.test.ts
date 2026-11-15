import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretQuestion, searchDonors } from './donor-search.ts';
import type { RetentionGift } from './retention.ts';

test('shared search scopes owners and preserves currency, exact cutoff, refunds and pending status', () => {
  const donors = [{ id: 'a', name: 'Alpha', owner_id: 'me' }, { id: 'b', name: 'Beta', owner_id: 'other' },
    { id: 'c', name: 'Dormant', owner_id: 'me' }, { id: 'd', name: 'Empty', owner_id: 'me' }];
  const settled: RetentionGift = { donor_id: 'a', amount_cents: 10029, refund_cents: 29, currency: 'USD',
    occurred_at: '2026-01-01T07:00:00Z', status: 'settled' };
  const gifts: RetentionGift[] = [settled, { ...settled, currency: 'EUR', refund_cents: 0 },
    { ...settled, donor_id: 'b', amount_cents: 30000 },
    { ...settled, donor_id: 'c', occurred_at: '2025-01-01T07:00:00Z' },
    { ...settled, donor_id: 'c', occurred_at: '2026-11-16T07:00:00Z' },
    { ...settled, donor_id: 'a', status: 'pending', occurred_at: '2026-11-16T06:59:59.999999Z' }];
  const run = (question: string) => searchDonors(interpretQuestion(question)!, donors, gifts, 'me', '2026-11-15');
  const ids = (question: string) => run(question).donors.map(d => d.id);
  assert.deepEqual(ids('my donors'), ['a', 'c', 'd']);
  assert.deepEqual(ids('my donors over $100 in USD'), []);
  assert.deepEqual(ids('my donors over $100 in EUR'), ['a']);
  assert.deepEqual(ids('my lapsed donors'), ['c'], 'future gift must not change a lapsed classification');
  assert.deepEqual(ids('my donors with pending gifts'), ['a'], 'submillisecond before cutoff remains included');
  assert.deepEqual(ids('all donors over $200 in USD'), ['b']);
});

test('shared search retains result caps and oversized-history clarification', () => {
  const donor = { id: 'a', name: 'Alpha', owner_id: 'me' };
  const filters = interpretQuestion('all donors')!;
  const donors = Array.from({ length: 51 }, (_, i) => ({ ...donor, id: String(i) }));
  const result = searchDonors(filters, donors, [], 'me', '2026-11-15');
  assert.equal(result.donors.length, 50); assert.equal('total' in result && result.total, 51);
  assert.equal(searchDonors(filters, Array.from({ length: 2001 }, () => donor), [], 'me', '2026-11-15').needs_clarification, true);
  const gift: RetentionGift = { donor_id: 'a', amount_cents: 1, refund_cents: 0, currency: 'USD',
    occurred_at: '2026-01-01T07:00:00Z', status: 'settled' };
  assert.equal(searchDonors(filters, [donor], Array.from({ length: 50001 }, () => gift), 'me', '2026-11-15').needs_clarification, true);
});
