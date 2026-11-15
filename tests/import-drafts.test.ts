import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GiftWriteSchema } from '../packages/contracts/index.ts';
import { buildImportDrafts } from '../tools/import-drafts.ts';
import { previewCsv } from '../tools/import-preview.ts';
import { createReviewPlan, resolveReview } from '../tools/import-review.ts';

const org = '550e8400-e29b-41d4-a716-446655440000';
const batch = '550e8400-e29b-41d4-a716-446655440003';
const placeholder = '550e8400-e29b-41d4-a716-4466554400ff';
const fileSha = `sha256:${'a'.repeat(64)}`;
const reviewed = { currency: 'USD', status: 'settled', refund_cents: 0, occurred_at: '2026-11-14T00:00:00-07:00' };
const header = 'first name,last name,email,phone,company,donation amount,contact person,campaign';
const csv = (...rows: string[]) => [header, ...rows].join('\n');
const preview = (text: string) => previewCsv(text, 'zeffy', 'gifts.csv');

const ready = (result: ReturnType<typeof resolveReview>) => {
  assert.equal(result.status, 'ready');
  return result.status === 'ready' ? result : assert.fail('not ready');
};

test('identical donor rows share one draft and every gift keeps its row provenance', () => {
  const drafts = buildImportDrafts(preview(csv(
    'Avery,Smith,Avery@Example.com,602-555-1000,Honeywell,250,Diana Lee,Giving Tuesday',
    'Avery,Smith,avery@example.com,602-555-1000,Honeywell,"90,071,992,547,409.91",Diana Lee,Spring',
    'Sam,Lee,sam@example.com,,,12.34,,')), { batch_id: batch, values: reviewed });
  assert.equal(drafts.status, 'needs_review');
  assert.deepEqual(drafts.donors, [
    { name: 'Avery Smith', email: 'avery@example.com', phone: '6025551000', consent: 'unknown', metadata: { company: 'Honeywell' } },
    { name: 'Sam Lee', email: 'sam@example.com', phone: null, consent: 'unknown', metadata: {} }]);
  assert.deepEqual(drafts.gifts.map(gift => [gift.donor_row, gift.amount_cents, gift.source_row]), [
    [0, 25000, { batch_id: batch, row_key: '2' }],
    [0, 9007199254740991, { batch_id: batch, row_key: '3' }],
    [1, 1234, { batch_id: batch, row_key: '4' }]]);
  // Contact person and campaign names are never turned into owners or campaign IDs.
  assert.deepEqual(drafts.gifts[0], { donor_row: 0, campaign_id: null, amount_cents: 25000, refund_cents: 0,
    currency: 'USD', occurred_at: reviewed.occurred_at, status: 'settled', source: 'zeffy', external_id: null,
    source_row: { batch_id: batch, row_key: '2' } });
  assert.deepEqual(drafts.rows, [{ recordNumber: 2, donor_row: 0, gift_row: 0 },
    { recordNumber: 3, donor_row: 0, gift_row: 1 }, { recordNumber: 4, donor_row: 1, gift_row: 2 }]);
  assert.deepEqual(drafts.excluded, []);
  assert.deepEqual(drafts.unresolved, []);

  // The drafts run through both review phases with no human decisions needed.
  const base = { org_id: org, batch_id: batch, file_sha256: fileSha, existing_donors: [], existing_gifts: [] };
  const donors = ready(resolveReview(createReviewPlan({ ...base, donors: drafts.donors, gifts: [] }) , []));
  assert.deepEqual(donors.operations.map(op => op.op), ['create', 'create']);
  const gifts = ready(resolveReview(createReviewPlan({ ...base, donors: [], gifts: drafts.gifts,
    donor_resolution: donors }), []));
  assert.deepEqual(gifts.operations.map(op => [op.op, op.donor_row]), [['insert', 0], ['insert', 0], ['insert', 1]]);
});

test('donor rows that differ in any contact detail stay separate and go to review', () => {
  const drafts = buildImportDrafts(preview(csv(
    'Avery,Smith,avery@example.com,602-555-1000,Honeywell,10,,',
    'Avery,Smith,avery@example.com,602-555-9999,Honeywell,20,,',
    'Jo,Park,,602-555-1234,,30,,',
    'Jo,Park,,602-555-1234,,40,,')), { batch_id: batch, values: reviewed });
  // Without an email there is no corroborated identity, so even identical rows are not merged.
  assert.deepEqual(drafts.gifts.map(gift => gift.donor_row), [0, 1, 2, 3]);
  const rows = createReviewPlan({ org_id: org, batch_id: batch, file_sha256: fileSha, donors: drafts.donors,
    gifts: [], existing_donors: [], existing_gifts: [] }).donors.rows;
  assert.ok(rows.every(row => row.action === 'review'));
});

test('reviewer batch values fill only unmapped gift facts and are validated', () => {
  const dated = previewCsv(`${header},occurred at,currency\nAvery,Smith,a@example.com,,,10,,,2026-01-02T03:04:05Z,usd`,
    'zeffy', 'dated.csv');
  const drafts = buildImportDrafts(dated, { batch_id: batch, values: { status: 'pending', refund_cents: 0 } });
  assert.equal(drafts.gifts[0].currency, 'USD');
  assert.equal(drafts.gifts[0].occurred_at, '2026-01-02T03:04:05Z');
  assert.equal(drafts.gifts[0].status, 'pending');
  assert.throws(() => buildImportDrafts(dated, { batch_id: batch, values: { ...reviewed } }), /mapped/);
  const plain = preview(csv('Avery,Smith,a@example.com,,,10,,'));
  for (const values of [{ currency: 'usd' }, { currency: 'ZZZ' }, { occurred_at: '2026-11-14' },
    { status: 'done' }, { refund_cents: -1 }, { refund_cents: 1.5 }, { amount_cents: 100 }, { donor_id: placeholder }]) {
    assert.throws(() => buildImportDrafts(plain, { batch_id: batch, values }), Error, JSON.stringify(values));
  }
  assert.throws(() => buildImportDrafts(plain, { batch_id: 'batch-1', values: reviewed }));
  assert.throws(() => buildImportDrafts({ ...plain, status: 'ready' } as never, { batch_id: batch }));
});

test('missing gift facts are left out, reported and never defaulted', () => {
  const drafts = buildImportDrafts(preview(csv('Avery,Smith,a@example.com,,,10,,')), { batch_id: batch });
  const gift = drafts.gifts[0] as Record<string, unknown>;
  for (const field of ['currency', 'occurred_at', 'status', 'refund_cents']) assert.equal(field in gift, false, field);
  assert.deepEqual(drafts.unresolved.map(issue => issue.field).sort(), ['currency', 'occurred_at', 'refund_cents', 'status']);
  const plan = createReviewPlan({ org_id: org, batch_id: batch, file_sha256: fileSha, donors: [],
    gifts: drafts.gifts, existing_donors: [], existing_gifts: [],
    donor_resolution: ready(resolveReview(createReviewPlan({ org_id: org, batch_id: batch, file_sha256: fileSha,
      donors: drafts.donors, gifts: [], existing_donors: [], existing_gifts: [] }), [])) });
  assert.equal(plan.gifts.rows[0].reason, 'invalid_gift');
});

test('rows with preview issues are excluded by record number, never silently dropped', () => {
  const p = preview(csv(
    'Avery,Smith,not-an-email,,,10,,',
    '=SUM(1),Smith,b@example.com,,,10,,',
    'Cam,Diaz,c@example.com,,,,,',
    'Dee,Ng,d@example.com,,,0,,',
    'Eve,Ola,e@example.com,,,15,,'));
  const drafts = buildImportDrafts(p, { batch_id: batch, values: reviewed });
  assert.deepEqual(drafts.excluded, [
    { recordNumber: 2, codes: ['invalid_email'] },
    { recordNumber: 3, codes: ['spreadsheet_formula'] },
    { recordNumber: 4, codes: ['missing_amount'] },
    { recordNumber: 5, codes: ['non_positive_amount'] }]);
  assert.deepEqual(drafts.rows, [{ recordNumber: 6, donor_row: 0, gift_row: 0 }]);
  assert.equal(drafts.rows.length + drafts.excluded.length, p.rows.length);
  assert.doesNotMatch(JSON.stringify(drafts.excluded), /SUM|not-an-email/);
});

test('all supplied sample files reach valid drafts without losing a record', () => {
  for (const [source, file] of [['spreadsheet', 'cic_donor_spreadsheet.csv'], ['zeffy', 'zeffy_export.csv'],
    ['benevity', 'benevity_export.csv']]) {
    const text = readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8');
    const p = previewCsv(text, source, file);
    const drafts = buildImportDrafts(p, { batch_id: batch, values: reviewed });
    assert.equal(drafts.rows.length + drafts.excluded.length, p.rows.length, file);
    assert.equal(new Set(drafts.gifts.map(gift => gift.source_row.row_key)).size, drafts.gifts.length, file);
    assert.ok(drafts.donors.length <= drafts.gifts.length, file);
    for (const { donor_row, ...gift } of drafts.gifts) {
      assert.ok(donor_row >= 0 && donor_row < drafts.donors.length, file);
      assert.equal(GiftWriteSchema.safeParse({ ...gift, donor_id: placeholder }).success, true, file);
    }
  }
});

test('dry-run CLI prints plan counts only and rejects incomplete reviewer values', () => {
  const cli = fileURLToPath(new URL('../tools/import-drafts.ts', import.meta.url));
  const file = fileURLToPath(new URL('../data/zeffy_export.csv', import.meta.url));
  const args = ['--currency', 'USD', '--status', 'settled', '--refund-cents', '0', '--occurred-at', reviewed.occurred_at];
  const result = spawnSync(process.execPath, [cli, 'zeffy', file, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.rowCount, 75);
  assert.equal(summary.rowCount, summary.giftDrafts + summary.excludedRows);
  assert.equal(typeof summary.excludedCodes, 'object');
  assert.equal(typeof summary.donorPlan, 'object');
  assert.doesNotMatch(result.stdout, /@|602-555/);
  for (const bad of [['--currency'], ['--currency', 'usd'], ['--colour', 'red']]) {
    const failed = spawnSync(process.execPath, [cli, 'zeffy', file, ...bad], { encoding: 'utf8' });
    assert.equal(failed.status, 1, bad.join(' '));
    assert.equal(failed.stdout, '');
  }
});

test('dry-run CLI argument errors never echo private input', () => {
  const cli = fileURLToPath(new URL('../tools/import-drafts.ts', import.meta.url));
  const file = fileURLToPath(new URL('../data/zeffy_export.csv', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'zeffy', file, '--avery@example.org'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /avery@example/);
});

test('drafts CLI forwards confirmed dates without guessing or losing excluded rows', () => {
  const cli = fileURLToPath(new URL('../tools/import-drafts.ts', import.meta.url));
  const file = fileURLToPath(new URL('../apps/web/public/samples/az_gives_export.csv', import.meta.url));
  const run = (...flags: string[]) => spawnSync(process.execPath, [cli, 'az_gives', file,
    '--currency', 'USD', '--status', 'settled', '--refund-cents', '0', ...flags], { encoding: 'utf8' });
  const unconfirmed = run();
  assert.equal(unconfirmed.status, 0, unconfirmed.stderr);
  const before = JSON.parse(unconfirmed.stdout);
  assert.equal(before.giftDrafts, 0);
  assert.equal(before.excludedRows, 8);
  assert.equal(before.excludedCodes.invalid_occurred_at, 8);
  const confirmed = run('--date-format', 'MM/DD/YYYY', '--utc-offset', '-07:00');
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const after = JSON.parse(confirmed.stdout);
  assert.equal(after.rowCount, 8);
  assert.equal(after.giftDrafts, 6);
  assert.equal(after.excludedRows, 2);
  assert.deepEqual(after.excludedCodes, { invalid_email: 1, invalid_amount: 1 });
  assert.doesNotMatch(confirmed.stdout + confirmed.stderr, /@|555|Avery|Copperline/);
  for (const flags of [
    ['--date-format', 'MM/DD/YYYY'],
    ['--utc-offset', '-07:00'],
    ['--date-format', 'MM/DD/YYYY', '--utc-offset', '-15:00'],
    ['--date-format', 'MM/DD/YYYY', '--date-format', 'DD/MM/YYYY', '--utc-offset', '-07:00'],
  ]) {
    const bad = run(...flags);
    assert.equal(bad.status, 1, flags.join(' '));
    assert.equal(bad.stdout, '');
  }
});
