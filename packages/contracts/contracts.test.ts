import assert from 'node:assert/strict';
import test from 'node:test';
import { DonorSchema, DonorWriteSchema, GiftSchema, GiftWriteSchema } from './index.ts';

const id = '550e8400-e29b-41d4-a716-446655440000';
const donor = { name: 'Alex Rivera', consent: 'unknown', metadata: {} };
const gift = {
  donor_id: id, campaign_id: null, amount_cents: 1234, refund_cents: 0,
  currency: 'USD', occurred_at: '2026-11-14T09:00:00-07:00',
  status: 'settled', source: 'manual',
};

test('donor records preserve Unicode and optional contacts with validated JSON metadata', () => {
  assert.equal(DonorSchema.parse({ ...donor, name: '  Zoë 李  ', id, org_id: id, owner_id: null, archived_at: null }).name, 'Zoë 李');
  for (const change of [{ name: ' ' }, { email: 'invalid' }, { metadata: { value: undefined } }, { consent: 'yes' }]) {
    assert.equal(DonorWriteSchema.safeParse({ ...donor, ...change }).success, false);
  }
});

test('write contracts reject injected organization, identity, ownership and privileged fields', () => {
  for (const field of ['id', 'org_id', 'owner_id', 'role', 'archived_at']) {
    assert.equal(DonorWriteSchema.safeParse({ ...donor, [field]: id }).success, false);
    assert.equal(GiftWriteSchema.safeParse({ ...gift, [field]: id }).success, false);
  }
});

test('gift validation preserves exact money and accepts full refunds', () => {
  assert.equal(GiftWriteSchema.parse(gift).amount_cents, 1234);
  assert.equal(GiftSchema.safeParse({ ...gift, id, org_id: id, refund_cents: 1234 }).success, true);
  for (const change of [
    { amount_cents: 1.5 }, { amount_cents: -1 }, { amount_cents: Number.MAX_SAFE_INTEGER + 1 },
    { refund_cents: -1 }, { refund_cents: 1235 }, { currency: 'usd' }, { currency: 'ZZZ' },
    { occurred_at: '2026-11-14' }, { occurred_at: '2026-02-30T00:00:00Z' },
    { donor_id: 'not-a-uuid' }, { status: 'sent' }, { source: '' },
    { source_row: { batch_id: id, row_key: '' } },
  ]) {
    assert.equal(GiftWriteSchema.safeParse({ ...gift, ...change }).success, false, JSON.stringify(change));
  }
});

test('missing financial facts are rejected rather than defaulted', () => {
  for (const field of ['amount_cents', 'refund_cents', 'currency', 'occurred_at', 'status']) {
    const incomplete: Record<string, unknown> = { ...gift };
    delete incomplete[field];
    assert.equal(GiftWriteSchema.safeParse(incomplete).success, false, field);
  }
  assert.equal(GiftWriteSchema.safeParse({ ...gift, source_row: { batch_id: id, row_key: 'record-2' } }).success, true);
});
