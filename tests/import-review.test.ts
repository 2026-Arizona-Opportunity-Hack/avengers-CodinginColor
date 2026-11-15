import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFileReplay, createReviewPlan, fingerprintFile, resolveReview } from '../tools/import-review.ts';

const org = '550e8400-e29b-41d4-a716-446655440000';
const otherOrg = '550e8400-e29b-41d4-a716-446655440009';
const donorId = '550e8400-e29b-41d4-a716-446655440001';
const giftId = '550e8400-e29b-41d4-a716-446655440002';
const batch = '550e8400-e29b-41d4-a716-446655440003';
const priorBatch = '550e8400-e29b-41d4-a716-446655440004';
const reviewer = '550e8400-e29b-41d4-a716-446655440005';
const otherDonor = '550e8400-e29b-41d4-a716-446655440006';
// SHA-256 of the empty input, from FIPS 180-4 test vectors.
const emptySha = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const fileSha = `sha256:${'a'.repeat(64)}`;

const donor = { name: 'Avery Smith', email: 'avery@example.com', phone: null, consent: 'unknown', metadata: {} };
const storedDonor = { ...donor, id: donorId, org_id: org, owner_id: null, archived_at: null };
const gift = { donor_id: donorId, campaign_id: null, amount_cents: 1000, refund_cents: 0, currency: 'USD',
  occurred_at: '2026-11-14T09:00:00-07:00', status: 'settled', source: 'zeffy', external_id: 'gift-001',
  source_row: { batch_id: batch, row_key: '2' } };
const storedGift = { ...gift, id: giftId, org_id: org, source_row: { batch_id: priorBatch, row_key: '2' } };

const plan = (overrides: Record<string, unknown> = {}) => createReviewPlan({ org_id: org, batch_id: batch,
  file_sha256: fileSha, donors: [], gifts: [], existing_donors: [], existing_gifts: [], ...overrides });
const decide = (p: { plan_hash: string }, kind: string, row: number, action: string, extra = {}) =>
  ({ plan_hash: p.plan_hash, kind, row, action, reviewer_id: reviewer, ...extra });
const opsOf = (result: ReturnType<typeof resolveReview>) => {
  assert.equal(result.status, 'ready');
  return result.status === 'ready' ? result.operations : [];
};

test('file fingerprints hash exact bytes with SHA-256', () => {
  assert.equal(fingerprintFile(new Uint8Array()), emptySha);
  const csv = new TextEncoder().encode('name,amount\nAvery,10.00\n');
  assert.equal(fingerprintFile(csv), fingerprintFile(Uint8Array.from(csv)));
  assert.match(fingerprintFile(csv), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(fingerprintFile(csv), fingerprintFile(new TextEncoder().encode('name,amount\nAvery,10.01\n')));
});

test('file replay blocks committed files, resumes open reviews and stays inside the organization', () => {
  const prior = (status: string, batch_id = priorBatch) => ({ org_id: org, batch_id, file_sha256: fileSha, status });
  assert.deepEqual(checkFileReplay(org, fileSha, []), { action: 'new' });
  assert.deepEqual(checkFileReplay(org, fileSha, [prior('abandoned')]), { action: 'new' });
  assert.deepEqual(checkFileReplay(org, fileSha, [prior('reviewing')]), { action: 'resume', batch_id: priorBatch });
  assert.deepEqual(checkFileReplay(org, fileSha, [prior('reviewing', batch), prior('committed')]),
    { action: 'replay', batch_id: priorBatch });
  assert.deepEqual(checkFileReplay(org, fileSha, [{ ...prior('committed'), file_sha256: emptySha }]), { action: 'new' });
  // Foreign rows signal a caller scope bug; failing closed avoids leaking another org's batch IDs.
  assert.throws(() => checkFileReplay(org, fileSha, [{ ...prior('committed'), org_id: otherOrg }]), /scoped/);
  assert.throws(() => checkFileReplay(org, fileSha, [prior('reviewing'), prior('reviewing', batch)]), /more than one open/);
  assert.throws(() => checkFileReplay(org, 'sha256:short', []));
  assert.throws(() => checkFileReplay(org, fileSha, [{ ...prior('committed'), status: 'approved' }]));
});

test('review plans bind to exact drafts and stay needs_review', () => {
  const first = plan({ donors: [donor], gifts: [gift], existing_donors: [storedDonor] });
  const reordered = plan({ donors: [{ metadata: {}, consent: 'unknown', phone: null, email: donor.email, name: donor.name }],
    gifts: [gift], existing_donors: [storedDonor] });
  assert.equal(first.status, 'needs_review');
  assert.match(first.plan_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.plan_hash, reordered.plan_hash);
  assert.notEqual(first.plan_hash, plan({ donors: [donor], gifts: [{ ...gift, amount_cents: 1001 }],
    existing_donors: [storedDonor] }).plan_hash);
  assert.notEqual(first.plan_hash, plan({ donors: [donor], gifts: [gift] }).plan_hash);
  assert.notEqual(first.plan_hash, plan({ donors: [donor], gifts: [gift], existing_donors: [storedDonor],
    file_sha256: emptySha }).plan_hash);
});

test('gift provenance must belong to the batch under review', () => {
  assert.throws(() => plan({ gifts: [{ ...gift, source_row: { batch_id: priorBatch, row_key: '2' } }] }), /provenance/);
  assert.throws(() => plan({ batch_id: 'not-a-uuid' }));
  assert.throws(() => plan({ file_sha256: 'md5:abc' }));
});

test('automatic rows commit without decisions; exact replays are not written again', () => {
  const p = plan({ donors: [donor, { ...donor, name: 'New Person', email: 'new@example.com' }],
    gifts: [gift, { ...gift, external_id: 'gift-002', amount_cents: 9007199254740991, source_row: { batch_id: batch, row_key: '3' } }],
    existing_donors: [storedDonor], existing_gifts: [{ ...storedGift, source_row: null }] });
  const result = resolveReview(p, []);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.operations, [
    { kind: 'donor', row: 0, op: 'link', donor_id: donorId, reviewer_id: null },
    { kind: 'donor', row: 1, op: 'create', draft: { ...donor, name: 'New Person', email: 'new@example.com' }, reviewer_id: null },
    { kind: 'gift', row: 1, op: 'insert', draft: { ...gift, external_id: 'gift-002', amount_cents: 9007199254740991,
      source_row: { batch_id: batch, row_key: '3' } },
      reviewer_id: null },
  ]);
  assert.equal(result.plan_hash, p.plan_hash);
  assert.equal(result.batch_id, batch);
});

test('review rows block commit until each has a saved human decision', () => {
  const p = plan({ gifts: [{ ...gift, external_id: null, source_row: null }] });
  assert.deepEqual(resolveReview(p, []), { status: 'needs_review', pending: [{ kind: 'gift', row: 0 }] });
  const ready = resolveReview(p, [decide(p, 'gift', 0, 'insert')]);
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.operations, [{ kind: 'gift', row: 0, op: 'insert', draft: { ...gift, external_id: null, source_row: null },
    reviewer_id: reviewer }]);
  assert.deepEqual(resolveReview(p, [decide(p, 'gift', 0, 'skip')]), { status: 'ready', org_id: org, batch_id: batch,
    file_sha256: fileSha, plan_hash: p.plan_hash, operations: [] });
});

test('stale decisions and tampered plans fail closed', () => {
  const p = plan({ gifts: [{ ...gift, external_id: null, source_row: null }] });
  assert.throws(() => resolveReview(p, [{ ...decide(p, 'gift', 0, 'insert'), plan_hash: emptySha }]), /different review plan/);
  const tampered = structuredClone(p);
  (tampered.gifts.drafts[0] as { amount_cents: number }).amount_cents = 1;
  assert.throws(() => resolveReview(tampered, [decide(p, 'gift', 0, 'insert')]), /modified/);
  const rerouted = structuredClone(p);
  rerouted.org_id = otherOrg;
  assert.throws(() => resolveReview(rerouted, [decide(p, 'gift', 0, 'insert')]), /modified/);
});

test('decisions are validated against each planned row', () => {
  const p = plan({ donors: [{ ...donor, email: null }, { name: 'x' }], existing_donors: [storedDonor] });
  assert.equal(p.donors.rows[0].action, 'review');
  const skipInvalid = decide(p, 'donor', 1, 'skip');
  // Links only to a listed candidate; never to arbitrary or foreign donor IDs.
  assert.throws(() => resolveReview(p, [decide(p, 'donor', 0, 'link', { donor_id: otherDonor }), skipInvalid]), /not allowed/);
  assert.equal(resolveReview(p, [decide(p, 'donor', 0, 'link', { donor_id: donorId }), skipInvalid]).status, 'ready');
  // Invalid drafts can only be skipped; fix the mapping and preview again instead.
  assert.throws(() => resolveReview(p, [decide(p, 'donor', 0, 'new'), decide(p, 'donor', 1, 'new')]), /only be skipped/);
  assert.throws(() => resolveReview(p, [skipInvalid, skipInvalid]), /Invalid decision row/);
  assert.throws(() => resolveReview(p, [skipInvalid, decide(p, 'donor', 2, 'skip')]), /Invalid decision row/);
  assert.throws(() => resolveReview(p, [skipInvalid, decide(p, 'donor', 0, 'new', { reviewer_id: 'admin' })]));
  assert.throws(() => resolveReview(p, [skipInvalid, decide(p, 'donor', 0, 'merge')]));
});

test('automatic rows accept only an explicit skip override', () => {
  const p = plan({ donors: [{ ...donor, email: 'fresh@example.com' }] });
  assert.equal(p.donors.rows[0].action, 'new');
  assert.deepEqual(opsOf(resolveReview(p, [decide(p, 'donor', 0, 'skip')])), []);
  assert.throws(() => resolveReview(p, [decide(p, 'donor', 0, 'link', { donor_id: donorId })]), /only a skip/);
});

test('changed transactions require an explicit correction of the matched gift', () => {
  const p = plan({ gifts: [{ ...gift, refund_cents: 400 }], existing_gifts: [storedGift] });
  assert.equal(p.gifts.rows[0].reason, 'changed_transaction');
  // Inserting would duplicate the org/source/external_id identity.
  assert.throws(() => resolveReview(p, [decide(p, 'gift', 0, 'insert')]), /not allowed/);
  assert.throws(() => resolveReview(p, [decide(p, 'gift', 0, 'correct', { gift_id: otherDonor })]), /not allowed/);
  assert.deepEqual(opsOf(resolveReview(p, [decide(p, 'gift', 0, 'correct', { gift_id: giftId })])), [
    { kind: 'gift', row: 0, op: 'correct', gift_id: giftId, draft: { ...gift, refund_cents: 400 }, reviewer_id: reviewer },
  ]);
});

// A human approves the stored records too, so their facts belong in the plan hash.
const donorReview = { ...donor, email: null };
const changedGift = { ...gift, refund_cents: 400 };
const reviewed = plan({ donors: [donorReview], gifts: [changedGift], existing_donors: [storedDonor],
  existing_gifts: [storedGift] });
const reviewedDecisions = [decide(reviewed, 'donor', 0, 'link', { donor_id: donorId }),
  decide(reviewed, 'gift', 0, 'correct', { gift_id: giftId })];
const rebuilt = (overrides: Record<string, unknown>) => plan({ donors: [donorReview], gifts: [changedGift],
  existing_donors: [storedDonor], existing_gifts: [storedGift], ...overrides });

test('changed transaction rows bind the reviewed stored gift facts', () => {
  for (const change of [{ amount_cents: 1200 }, { refund_cents: 200 }, { status: 'pending' }]) {
    const fresh = rebuilt({ existing_gifts: [{ ...storedGift, ...change }] });
    assert.equal(fresh.gifts.rows[0].reason, 'changed_transaction');
    assert.notEqual(fresh.plan_hash, reviewed.plan_hash, JSON.stringify(change));
    // The saved correction described the older financial history.
    assert.throws(() => resolveReview(fresh, reviewedDecisions), /different review plan/);
  }
});

test('donor review rows bind the reviewed stored donor facts', () => {
  for (const change of [{ name: 'Avery Jones' }, { email: 'avery.jones@example.com' },
    { archived_at: '2026-11-15T00:00:00Z' }]) {
    const fresh = rebuilt({ existing_donors: [{ ...storedDonor, ...change }] });
    assert.equal(fresh.donors.rows[0].action, 'review');
    assert.notEqual(fresh.plan_hash, reviewed.plan_hash, JSON.stringify(change));
    assert.throws(() => resolveReview(fresh, reviewedDecisions), /different review plan/);
  }
});

test('snapshot hashing ignores key order and unrelated stored records', () => {
  const reorderedDonor = { archived_at: null, owner_id: null, org_id: org, id: donorId, metadata: donor.metadata,
    consent: donor.consent, phone: null, email: donor.email, name: donor.name };
  const reorderedGift = { org_id: org, id: giftId, source_row: storedGift.source_row, status: storedGift.status,
    external_id: storedGift.external_id, source: storedGift.source, occurred_at: storedGift.occurred_at,
    currency: storedGift.currency, refund_cents: storedGift.refund_cents, amount_cents: storedGift.amount_cents,
    campaign_id: null, donor_id: donorId };
  assert.equal(rebuilt({ existing_donors: [reorderedDonor], existing_gifts: [reorderedGift] }).plan_hash,
    reviewed.plan_hash);
  const unrelatedDonor = { id: otherDonor, org_id: org, owner_id: null, archived_at: null, name: 'Unrelated Person',
    email: 'unrelated@example.com', phone: null, consent: 'granted', metadata: {} };
  const unrelatedGift = { ...storedGift, id: '550e8400-e29b-41d4-a716-446655440007', external_id: 'gift-999',
    amount_cents: 7777, source_row: { batch_id: priorBatch, row_key: '9' } };
  assert.equal(rebuilt({ existing_donors: [storedDonor, unrelatedDonor],
    existing_gifts: [storedGift, unrelatedGift] }).plan_hash, reviewed.plan_hash);
});

test('an unchanged snapshot keeps previously approved decisions ready', () => {
  assert.equal(resolveReview(reviewed, reviewedDecisions).status, 'ready');
  assert.equal(resolveReview(rebuilt({}), reviewedDecisions).status, 'ready');
});

test('conflicting rows for one transaction identity cannot both be written', () => {
  const p = plan({ gifts: [gift, { ...gift, amount_cents: 2000, source_row: { batch_id: batch, row_key: '3' } }] });
  assert.ok(p.gifts.rows.every(row => row.reason === 'conflicting_batch_transaction'));
  assert.throws(() => resolveReview(p, [decide(p, 'gift', 0, 'insert'), decide(p, 'gift', 1, 'insert')]), /Conflicting/);
  const chosen = resolveReview(p, [decide(p, 'gift', 0, 'skip'), decide(p, 'gift', 1, 'insert')]);
  assert.deepEqual(opsOf(chosen).map(op => op.row), [1]);
});

test('conflicting stored identities accept only a skip decision', () => {
  // External ID names one stored gift and source row another, so any write would duplicate an identity.
  const holdsId = { ...storedGift, source_row: null };
  const holdsRow = { ...storedGift, id: '550e8400-e29b-41d4-a716-44665544000a', external_id: null,
    source_row: gift.source_row };
  const split = plan({ gifts: [gift], existing_gifts: [holdsId, holdsRow] });
  // Same stored gift, different transaction ID: rewriting its identity is not a correction.
  const renamed = plan({ gifts: [{ ...gift, external_id: 'gift-002' }],
    existing_gifts: [{ ...storedGift, source_row: gift.source_row }] });
  for (const p of [split, renamed]) {
    const row = p.gifts.rows[0];
    assert.equal(row.reason, 'conflicting_identity');
    assert.throws(() => resolveReview(p, [decide(p, 'gift', 0, 'insert')]), /not allowed/);
    for (const id of row.existingIds) {
      assert.throws(() => resolveReview(p, [decide(p, 'gift', 0, 'correct', { gift_id: id })]), /not allowed/);
    }
    assert.deepEqual(opsOf(resolveReview(p, [decide(p, 'gift', 0, 'skip')])), []);
  }
  assert.deepEqual([...split.gifts.rows[0].existingIds].sort(), [holdsRow.id, giftId].sort());
});
