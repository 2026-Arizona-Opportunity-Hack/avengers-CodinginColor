import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewPlan, resolveReview } from '../tools/import-review.ts';

const org = '550e8400-e29b-41d4-a716-446655440000';
const otherOrg = '550e8400-e29b-41d4-a716-446655440009';
const donorId = '550e8400-e29b-41d4-a716-446655440001';
const batch = '550e8400-e29b-41d4-a716-446655440003';
const priorBatch = '550e8400-e29b-41d4-a716-446655440004';
const reviewer = '550e8400-e29b-41d4-a716-446655440005';
const emptySha = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const fileSha = `sha256:${'a'.repeat(64)}`;

const donor = { name: 'Avery Smith', email: 'avery@example.com', phone: null, consent: 'unknown', metadata: {} };
const storedDonor = { ...donor, id: donorId, org_id: org, owner_id: null, archived_at: null };
const gift = { donor_id: donorId, campaign_id: null, amount_cents: 1000, refund_cents: 0, currency: 'USD',
  occurred_at: '2026-11-14T09:00:00-07:00', status: 'settled', source: 'zeffy', external_id: 'gift-001',
  source_row: { batch_id: batch, row_key: '2' } };
const storedGift = { ...gift, id: '550e8400-e29b-41d4-a716-446655440002', org_id: org,
  source_row: { batch_id: priorBatch, row_key: '2' } };

const plan = (overrides: Record<string, unknown> = {}) => createReviewPlan({ org_id: org, batch_id: batch,
  file_sha256: fileSha, donors: [], gifts: [], existing_donors: [], existing_gifts: [], ...overrides });
const decide = (p: { plan_hash: string }, kind: string, row: number, action: string, extra = {}) =>
  ({ plan_hash: p.plan_hash, kind, row, action, reviewer_id: reviewer, ...extra });
const opsOf = (result: ReturnType<typeof resolveReview>) => {
  assert.equal(result.status, 'ready');
  return result.status === 'ready' ? result.operations : [];
};
const phase1 = (donors: unknown[], existing_donors: unknown[] = [],
  decisions: (p: { plan_hash: string }) => unknown[] = () => []) => {
  const first = plan({ donors, existing_donors });
  const ready = resolveReview(first, decisions(first));
  assert.equal(ready.status, 'ready');
  return ready;
};
const giftFor = (donor_row: number, overrides: Record<string, unknown> = {}) => {
  const { donor_id: _linked, ...rest } = gift;
  return { ...rest, donor_row, ...overrides };
};
const phase2 = (donor_resolution: unknown, gifts: unknown[], overrides: Record<string, unknown> = {}) =>
  plan({ donor_resolution, gifts, ...overrides });
const opShape = (op: unknown) => {
  const { draft, ...shape } = op as { draft: Record<string, unknown> };
  return { shape, draft };
};

test('a gift row links to the donor resolved in phase one and dedupes against its stored gifts', () => {
  const ready = phase1([donor], [storedDonor]);
  assert.deepEqual(opsOf(ready), [{ kind: 'donor', row: 0, op: 'link', donor_id: donorId, reviewer_id: null }]);
  const p = phase2(ready, [giftFor(0), giftFor(0, { external_id: 'gift-002', amount_cents: 2400,
    source_row: { batch_id: batch, row_key: '3' } })], { existing_gifts: [storedGift] });
  assert.deepEqual(p.gifts.rows.map(row => row.action), ['duplicate', 'insert']);
  assert.deepEqual(opsOf(resolveReview(p, [])), [{ kind: 'gift', row: 1, op: 'insert', reviewer_id: null,
    draft: { ...gift, external_id: 'gift-002', amount_cents: 2400, source_row: { batch_id: batch, row_key: '3' } } }]);
});

test('gifts for donors created in the same import stay pending on their donor row', () => {
  const ready = phase1([{ ...donor, name: 'New Person', email: 'new@example.com' }]);
  assert.deepEqual(opsOf(ready), [{ kind: 'donor', row: 0, op: 'create', reviewer_id: null,
    draft: { ...donor, name: 'New Person', email: 'new@example.com' } }]);
  const p = phase2(ready, [giftFor(0, { external_id: 'gift-new', amount_cents: 9007199254740991 })],
    { existing_gifts: [storedGift] });
  assert.equal(p.gifts.rows[0].action, 'insert');
  const [op] = opsOf(resolveReview(p, []));
  const { shape, draft } = opShape(op);
  assert.deepEqual(shape, { kind: 'gift', row: 0, op: 'insert', donor_row: 0, reviewer_id: null });
  // donor_row lives on the operation only; the draft keeps every other gift fact exactly.
  const { donor_id: _none, ...withoutDonor } = gift;
  assert.deepEqual(draft, { ...withoutDonor, external_id: 'gift-new', amount_cents: 9007199254740991 });
  // A stored transaction ID claimed by a new donor's gift is a changed transaction, never an insert.
  const claimed = phase2(ready, [giftFor(0)], { existing_gifts: [storedGift] });
  assert.equal(claimed.gifts.rows[0].action, 'review');
  assert.deepEqual(claimed.gifts.rows[0].existingIds, [storedGift.id]);
  assert.throws(() => resolveReview(claimed, [decide(claimed, 'gift', 0, 'insert')]), /not allowed/);
  const corrected = opShape(opsOf(resolveReview(claimed, [decide(claimed, 'gift', 0, 'correct',
    { gift_id: storedGift.id })]))[0]);
  assert.deepEqual(corrected.shape, { kind: 'gift', row: 0, op: 'correct', gift_id: storedGift.id, donor_row: 0,
    reviewer_id: reviewer });
  assert.deepEqual(corrected.draft, withoutDonor);
  // Each created donor keeps its own row; gifts never cross to another new donor.
  const two = phase1([{ ...donor, email: 'one@example.com' }, { ...donor, email: 'two@example.com' }], [],
    p => [decide(p, 'donor', 0, 'new'), decide(p, 'donor', 1, 'new')]);
  const pair = opsOf(resolveReview(phase2(two, [giftFor(1, { external_id: 'gift-a', source_row: { batch_id: batch,
    row_key: '4' } }), giftFor(0, { external_id: 'gift-b', source_row: { batch_id: batch, row_key: '5' } })]), []));
  assert.deepEqual(pair.map(item => [item.row, item.donor_row]), [[0, 1], [1, 0]]);
  const conflict = phase2(ready, [giftFor(0, { amount_cents: 1000 }),
    giftFor(0, { amount_cents: 2000, source_row: { batch_id: batch, row_key: '3' } })]);
  assert.deepEqual(conflict.gifts.rows.map(row => row.reason),
    ['conflicting_batch_transaction', 'conflicting_batch_transaction']);
});

test('gifts whose donor has no phase one operation require a reviewer skip', () => {
  const ready = phase1([donor], [storedDonor], p => [decide(p, 'donor', 0, 'skip')]);
  assert.deepEqual(opsOf(ready), []);
  const p = phase2(ready, [giftFor(0)]);
  assert.equal(p.gifts.rows[0].action, 'review');
  assert.equal(p.gifts.rows[0].reason, 'donor_unresolved');
  assert.throws(() => resolveReview(p, [decide(p, 'gift', 0, 'insert')]), /unresolved|not allowed/);
  assert.deepEqual(opsOf(resolveReview(p, [decide(p, 'gift', 0, 'skip')])), []);
});

test('ambiguous unresolved donor references fail closed', () => {
  const ready = phase1([donor], [storedDonor]);
  // Exactly one of donor_id and donor_row may identify the donor.
  assert.throws(() => phase2(ready, [{ ...gift, donor_row: 0 }]), /donor/);
  assert.throws(() => plan({ gifts: [giftFor(0)] }), /donor/);
  // Phase two plans gifts only, so donor_row cannot point at a second donor list.
  assert.throws(() => phase2(ready, [giftFor(0)], { donors: [donor] }), /donor/);
  // A row outside the resolution is unresolved, never silently linked.
  const outOfRange = phase2(ready, [giftFor(7)]);
  assert.equal(outOfRange.gifts.rows[0].action, 'review');
  assert.equal(outOfRange.gifts.rows[0].reason, 'donor_unresolved');
  // The resolution must describe this exact import.
  assert.throws(() => phase2({ ...ready, org_id: otherOrg }, [giftFor(0)]), /donor resolution|scoped|different/i);
  assert.throws(() => phase2({ ...ready, batch_id: priorBatch }, [giftFor(0)]), /donor resolution|scoped|different/i);
  assert.throws(() => phase2({ ...ready, file_sha256: emptySha }, [giftFor(0)]), /donor resolution|scoped|different/i);
  assert.throws(() => phase2({ ...ready, status: 'needs_review' }, [giftFor(0)]), /ready|donor resolution/i);
});

test('phase two plan hashes bind to the donor resolution', () => {
  const link = phase1([donor], [storedDonor]);
  const create = phase1([{ ...donor, email: 'new@example.com' }]);
  const gifts = [giftFor(0, { external_id: 'gift-900' })];
  assert.equal(phase2(link, gifts).plan_hash, phase2(structuredClone(link), gifts).plan_hash);
  assert.notEqual(phase2(link, gifts).plan_hash, phase2(create, gifts).plan_hash);
});

test('gift drafts with donor_id and no donor resolution keep their existing behavior', () => {
  assert.deepEqual(opsOf(resolveReview(plan({ gifts: [gift] }), [])),
    [{ kind: 'gift', row: 0, op: 'insert', draft: gift, reviewer_id: null }]);
});

test('malformed phase-one operations fail closed instead of selecting an arbitrary donor', () => {
  const ready = phase1([donor], [storedDonor]);
  assert.equal(ready.status, 'ready');
  if (ready.status !== 'ready') return;
  const op = ready.operations[0];
  for (const operations of [
    [op, { ...op, donor_id: otherOrg }],
    [{ ...op, donor_id: undefined }],
    [{ ...op, op: 'insert' }],
    [{ ...op, op: 'create', donor_id: undefined, draft: null }],
    [{ ...op, op: 'create', draft: donor }],
    [{ ...op, gift_id: storedGift.id }],
  ]) {
    assert.throws(() => phase2({ ...ready, operations }, [giftFor(0)]), /donor resolution/i);
  }
});

test('invalid legacy gift drafts can still be reviewed and skipped without crashing', () => {
  const p = plan({ gifts: [null] });
  assert.deepEqual(resolveReview(p, []), { status: 'needs_review', pending: [{ kind: 'gift', row: 0 }] });
  assert.deepEqual(opsOf(resolveReview(p, [decide(p, 'gift', 0, 'skip')])), []);
});

test('unresolved rows preserve later gift indexes and peer conflicts', () => {
  const ready = phase1([donor]);
  const p = phase2(ready, [giftFor(7), giftFor(0), giftFor(0, { amount_cents: 2000,
    source_row: { batch_id: batch, row_key: '3' } })]);
  assert.equal(p.gifts.rows[0].reason, 'donor_unresolved');
  assert.deepEqual(p.gifts.rows.slice(1).map(row => row.matchingRows), [[2], [1]]);
  assert.throws(() => resolveReview(p, [decide(p, 'gift', 0, 'skip'),
    decide(p, 'gift', 1, 'insert'), decide(p, 'gift', 2, 'insert')]), /Conflicting/);
});
