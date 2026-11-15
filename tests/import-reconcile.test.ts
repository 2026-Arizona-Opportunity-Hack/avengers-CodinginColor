import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planDonorMatches, planGiftChanges } from '../tools/import-reconcile.ts';
import { previewCsv } from '../tools/import-preview.ts';

const org = '550e8400-e29b-41d4-a716-446655440000';
const id = '550e8400-e29b-41d4-a716-446655440001';
const other = '550e8400-e29b-41d4-a716-446655440002';
const batch = '550e8400-e29b-41d4-a716-446655440003';
const donor = { name: 'Avery Smith', email: 'avery@example.com', phone: '6025551000', consent: 'unknown', metadata: {} };
const storedDonor = { ...donor, id, org_id: org, owner_id: null, archived_at: null };
const gift = { donor_id: id, campaign_id: null, amount_cents: 1000, refund_cents: 0,
  currency: 'USD', occurred_at: '2026-11-14T09:00:00-07:00', status: 'settled', source: 'zeffy', external_id: 'gift-001' };
const storedGift = { ...gift, id: other, org_id: org };

test('unique email links only with corroboration, preserving existing ownership', () => {
  const draft = { ...donor, name: '  AVERY   SMITH ', email: 'AVERY@example.com' };
  const result = planDonorMatches(org, [draft], [storedDonor]);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.rows[0].action, 'link');
  assert.deepEqual(result.rows[0].existingIds, [id]);
  assert.equal(storedDonor.owner_id, null);
  for (const change of [{ name: 'Different Person' }, { phone: '6025559999' }]) {
    assert.equal(planDonorMatches(org, [{ ...donor, ...change }], [storedDonor]).rows[0].action, 'review');
  }
});

test('shared email, archived donor, phone-only and name-only candidates require review', () => {
  for (const records of [[storedDonor, { ...storedDonor, id: other }],
    [{ ...storedDonor, archived_at: '2026-11-01T00:00:00Z' }],
    [{ ...storedDonor, email: 'other@example.com' }]]) {
    assert.equal(planDonorMatches(org, [donor], records).rows[0].action, 'review');
  }
  assert.equal(planDonorMatches(org, [{ ...donor, email: null, phone: null }], [storedDonor]).rows[0].action, 'review');
  assert.equal(planDonorMatches(org, [{ ...donor, email: null, phone: null }], []).rows[0].action, 'review');
});

test('conflicting incoming identities and repeated new-donor drafts are reviewed together', () => {
  const conflict = planDonorMatches(org, [donor, { ...donor, name: 'Another Person' }], [storedDonor]);
  assert.ok(conflict.rows.every(row => row.action === 'review'));
  const repeated = planDonorMatches(org, [donor, donor], []);
  assert.ok(repeated.rows.every(row => row.action === 'review'));
  assert.deepEqual(repeated.rows[0].matchingRows, [1]);
  assert.equal(planDonorMatches(org, [donor], []).rows[0].action, 'new');
});

test('invalid drafts remain review rows; invalid, duplicate or mixed-org snapshots fail closed', () => {
  assert.equal(planDonorMatches(org, [{ ...donor, org_id: other }], []).rows[0].reason, 'invalid_donor');
  assert.equal(planGiftChanges(org, [{ ...gift, currency: undefined }], []).rows[0].reason, 'invalid_gift');
  for (const records of [[{ ...storedDonor, org_id: other }], [storedDonor, storedDonor], [{}]]) {
    assert.throws(() => planDonorMatches(org, [donor], records));
  }
  assert.throws(() => planGiftChanges(org, [gift], [{ ...storedGift, org_id: other }]));
  assert.throws(() => planGiftChanges(org, [gift], [storedGift, { ...storedGift, id: batch }]));
  assert.throws(() => planGiftChanges('not-an-org', [gift], []));
});

test('exact transaction replay uses timestamp instants and ignores new batch provenance', () => {
  const replay = { ...gift, occurred_at: '2026-11-14T16:00:00Z', source_row: { batch_id: batch, row_key: '2' } };
  const result = planGiftChanges(org, [replay], [storedGift]);
  assert.equal(result.rows[0].action, 'duplicate');
  assert.deepEqual(result.rows[0].existingIds, [other]);
  assert.deepEqual(planGiftChanges(org, [replay], [storedGift]), result);
});

test('same transaction with changed financial facts or donor is a reviewed update', () => {
  for (const change of [{ refund_cents: 500 }, { status: 'void' }, { amount_cents: 2000 },
    { donor_id: other }, { currency: 'EUR' }, { campaign_id: batch }]) {
    const row = planGiftChanges(org, [{ ...gift, ...change }], [storedGift]).rows[0];
    assert.equal(row.action, 'review');
    assert.equal(row.reason, 'changed_transaction');
  }
});

test('replay comparison preserves sub-millisecond timestamp precision', () => {
  const precise = { ...storedGift, occurred_at: '2026-11-14T16:00:00.0001Z' };
  const changed = { ...gift, occurred_at: '2026-11-14T09:00:00.0002-07:00' };
  assert.equal(planGiftChanges(org, [changed], [precise]).rows[0].action, 'review');
  const same = { ...gift, occurred_at: '2026-11-14T09:00:00.000100-07:00' };
  assert.equal(planGiftChanges(org, [same], [precise]).rows[0].action, 'duplicate');
});

test('conflicting duplicate transaction IDs flag all incoming occurrences', () => {
  const result = planGiftChanges(org, [gift, { ...gift, refund_cents: 1000 }], []);
  assert.ok(result.rows.every(row => row.reason === 'conflicting_batch_transaction'));
  const repeated = planGiftChanges(org, [gift, gift], []);
  assert.deepEqual(repeated.rows.map(row => row.action), ['insert', 'duplicate']);
});

test('distinct same-source IDs preserve legitimate repeated gifts; cross-source overlap needs review', () => {
  const repeated = planGiftChanges(org, [gift, { ...gift, external_id: 'gift-002' }], []);
  assert.deepEqual(repeated.rows.map(row => row.action), ['insert', 'insert']);
  const overlap = planGiftChanges(org, [gift, { ...gift, source: 'benevity' }], []);
  assert.ok(overlap.rows.every(row => row.reason === 'cross_source_candidate'));
  assert.equal(planGiftChanges(org, [{ ...gift, source: 'benevity' }], [storedGift])
    .rows[0].reason, 'cross_source_candidate');
});

test('missing transaction identity never silently drops a similar gift', () => {
  const noId = { ...gift, external_id: null };
  const result = planGiftChanges(org, [noId, noId], [storedGift]);
  assert.ok(result.rows.every(row => row.action === 'review' && row.reason === 'missing_transaction_identity'));
  assert.deepEqual(result.rows[0].existingIds, [other]);
  assert.equal(result.rows.length, 2);
});

test('batch/row provenance supports replay without IDs; edited replay stays in review', () => {
  const noId = { ...gift, external_id: null, source_row: { batch_id: batch, row_key: 'record-2' } };
  const existing = { ...noId, id: other, org_id: org };
  assert.equal(planGiftChanges(org, [noId], [existing]).rows[0].action, 'duplicate');
  assert.equal(planGiftChanges(org, [{ ...noId, amount_cents: 500 }], [existing]).rows[0].action, 'review');
});

test('re-exported files with new batch provenance cannot auto-insert no-ID gifts again', () => {
  // Byte changes such as CRLF or BOM give a re-saved export a new file hash and batch ID.
  const stored = { ...gift, external_id: null, source_row: { batch_id: batch, row_key: '2' }, id: other, org_id: org };
  const reupload = { ...gift, external_id: null, source_row: { batch_id: id, row_key: '2' } };
  const row = planGiftChanges(org, [reupload], [stored]).rows[0];
  assert.equal(row.action, 'review');
  assert.equal(row.reason, 'possible_file_replay');
  assert.deepEqual(row.existingIds, [other]);
  assert.equal(planGiftChanges(org, [{ ...reupload, amount_cents: 1001 }], [stored]).rows[0].action, 'insert');
});

test('all 210 source rows can enter donor reconciliation without mutating input or leaking contacts in decisions', () => {
  const drafts = ['cic_donor_spreadsheet.csv', 'zeffy_export.csv', 'benevity_export.csv'].flatMap((name, i) => {
    const source = ['spreadsheet', 'zeffy', 'benevity'][i];
    return previewCsv(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'), source, name).rows
      .map(({ values }) => ({ name: [values.first_name, values.last_name].filter(Boolean).join(' '),
        email: values.email, phone: values.phone, consent: 'unknown', metadata: {} }));
  });
  const before = structuredClone(drafts), result = planDonorMatches(org, drafts, []);
  assert.equal(result.rows.length, 210);
  assert.deepEqual(drafts, before);
  assert.ok(result.rows.some(row => row.action === 'review'));
  assert.doesNotMatch(JSON.stringify(result), /@|555|Avery/);
});

const provenance = { batch_id: batch, row_key: '2' };
const third = '550e8400-e29b-41d4-a716-446655440004';
const sourced = { ...gift, source_row: provenance, id: other, org_id: org };

test('source-row provenance identifies a gift even when only the stored side has an external ID', () => {
  const replay = { ...gift, external_id: null, source_row: provenance };
  const result = planGiftChanges(org, [replay], [sourced]);
  assert.equal(result.rows[0].action, 'duplicate');
  assert.deepEqual(result.rows[0].existingIds, [other]);
});

test('conflicting external IDs on one source row need review, changed facts too', () => {
  const conflict = planGiftChanges(org, [{ ...gift, external_id: 'tx-b', source_row: provenance }], [sourced]).rows[0];
  assert.equal(conflict.action, 'review');
  assert.equal(conflict.reason, 'conflicting_identity');
  assert.deepEqual(conflict.existingIds, [other]);
  const changed = planGiftChanges(org, [{ ...gift, external_id: null, source_row: provenance, amount_cents: 500 }],
    [sourced]).rows[0];
  assert.equal(changed.action, 'review');
});

test('external ID and source row naming different stored gifts fail closed with both IDs', () => {
  const byRow = { ...gift, external_id: 'tx-old', source_row: provenance, id: third, org_id: org };
  const row = planGiftChanges(org, [{ ...gift, source_row: provenance }], [storedGift, byRow]).rows[0];
  assert.equal(row.action, 'review');
  assert.equal(row.reason, 'conflicting_identity');
  assert.deepEqual([...row.existingIds].sort(), [other, third].sort());
});

test('incoming rows sharing one source row but not one identity all need review', () => {
  const ids = planGiftChanges(org, [{ ...gift, external_id: 'tx-a', source_row: provenance },
    { ...gift, external_id: 'tx-b', source_row: provenance }], []);
  assert.ok(ids.rows.every(row => row.action === 'review' && row.reason === 'conflicting_batch_transaction'));
  const facts = planGiftChanges(org, [{ ...gift, external_id: null, source_row: provenance },
    { ...gift, external_id: null, source_row: provenance, amount_cents: 2000 }], []);
  assert.ok(facts.rows.every(row => row.reason === 'conflicting_batch_transaction'));
});

test('ambiguous stored provenance is rejected while distinct identities still insert independently', () => {
  assert.throws(() => planGiftChanges(org, [gift], [sourced, { ...sourced, external_id: 'gift-002', id: third }]));
  const distinct = planGiftChanges(org, [{ ...gift, external_id: 'tx-c', source_row: { ...provenance, row_key: '3' } },
    { ...gift, external_id: 'tx-d', source_row: { ...provenance, row_key: '4' } }], [sourced]);
  assert.deepEqual(distinct.rows.map(row => row.action), ['insert', 'insert']);
});
