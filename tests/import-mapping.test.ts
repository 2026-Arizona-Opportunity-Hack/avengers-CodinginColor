import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { previewCsv } from '../tools/import-preview.ts';

const header = 'first name,email,Contribution Value,When Received,Money Code,Receipt,Unused';
const row = 'Avery,a@example.com,12.34,2026-11-14T09:00:00-07:00,usd,gift-001,retained';
const mapping = { 'Contribution Value': 'amount_decimal', 'When Received': 'occurred_at',
  'Money Code': 'currency', Receipt: 'external_id', Unused: null };
const preview = (body = row, choices: unknown = mapping) =>
  previewCsv(`${header}\n${body}`, 'spreadsheet', 'mapped.csv', choices);

test('explicit mappings validate gift facts through shared schemas and retain ignored cells', () => {
  const result = preview();
  assert.deepEqual(result.issues, []);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.rows[0].recordNumber, 2);
  assert.equal(result.rows[0].values.amount_cents, 1234);
  assert.equal(result.rows[0].values.currency, 'USD');
  assert.equal(result.rows[0].values.occurred_at, '2026-11-14T09:00:00-07:00');
  assert.equal(result.rows[0].values.external_id, 'gift-001');
  assert.equal(result.rows[0].raw.at(-1), 'retained');
  assert.ok(!('Unused' in result.rows[0].values));
  for (const field of ['donor_id', 'org_id', 'owner_id', 'refund_cents', 'status']) {
    assert.ok(!(field in result.rows[0].values), field);
  }
});

test('unknown headers stay unresolved until explicit choices are provided', () => {
  const result = preview(row, {});
  assert.equal(result.issues.filter(issue => issue.code === 'unmapped_column').length, 5);
  assert.ok(result.issues.some(issue => issue.code === 'unresolved_gift_metadata'));
  assert.equal(result.rows[0].raw[2], '12.34');
});

test('mapping choices reject invalid shapes, unknown headers/targets and collisions', () => {
  for (const choices of [null, [], 'mapping', 2, { absent: 'email' },
    { Receipt: 'org_id' }, { Receipt: 2 }, { Receipt: {} }, { Receipt: 'email' },
    { Receipt: 'amount_cents', 'Contribution Value': 'amount_decimal' }]) {
    assert.throws(() => preview(row, choices));
  }
  const ignored = preview(row, { ...mapping, 'Contribution Value': null });
  assert.ok(ignored.issues.some(issue => issue.code === 'missing_column'));
});

test('money mappings distinguish decimal units from integer cents', () => {
  const input = 'first name,email,Value\nAvery,a@example.com,100';
  const mapped = (target: string) => previewCsv(input, 'zeffy', 'test.csv', { Value: target });
  assert.equal(mapped('amount_decimal').rows[0].values.amount_cents, 10000);
  assert.equal(mapped('amount_cents').rows[0].values.amount_cents, 100);
  assert.equal(previewCsv(input.replace('Value', 'amount_cents'), 'zeffy', 'test.csv')
    .rows[0].values.amount_cents, 100);
  for (const value of ['1.25', '1e3', '-1', '9007199254740992']) {
    const result = previewCsv(input.replace(/100$/, value), 'zeffy', 'test.csv', { Value: 'amount_cents' });
    assert.equal(result.rows[0].values.amount_cents, null);
    assert.ok(result.issues.some(issue => issue.code === 'invalid_amount'));
  }
});

test('invalid calendar dates, ambiguous dates and missing timezones remain in review', () => {
  for (const date of ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '11/14/2026',
    '2026-11-14', '2026-11-14T09:00:00', '2026-11-14T25:00:00Z']) {
    const result = preview(row.replace('2026-11-14T09:00:00-07:00', date));
    assert.equal(result.rows[0].values.occurred_at, null, date);
    assert.ok(result.issues.some(issue => issue.code === 'invalid_occurred_at'), date);
  }
  const leap = preview(row.replace('2026-11-14T09:00:00-07:00', '2024-02-29T09:00:00Z'));
  assert.equal(leap.rows[0].values.occurred_at, '2024-02-29T09:00:00Z');
});

test('invalid currency and long external IDs are rejected; missing external ID is optional', () => {
  for (const currency of ['ZZZ', '$', 'US', 'US dollars']) {
    const result = preview(row.replace(',usd,', `,${currency},`));
    assert.equal(result.rows[0].values.currency, null);
    assert.ok(result.issues.some(issue => issue.code === 'invalid_currency'));
  }
  assert.ok(preview(row.replace('gift-001', 'x'.repeat(301))).issues
    .some(issue => issue.code === 'invalid_external_id'));
  const absent = preview(row.replace('gift-001', ''));
  assert.equal(absent.rows[0].values.external_id, null);
  assert.deepEqual(absent.issues, []);
});

test('mapped columns with missing gift facts report each row without filling defaults', () => {
  const result = preview('Avery,a@example.com,12.34,,,,retained');
  assert.deepEqual(result.issues.map(issue => [issue.recordNumber, issue.field, issue.code]), [
    [2, 'occurred_at', 'missing_gift_metadata'], [2, 'currency', 'missing_gift_metadata'],
  ]);
  assert.equal(result.rows[0].raw.length, 7);
});

test('mapping CLI applies choices and redacts malformed JSON contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cic-mapping-'));
  try {
    const csv = join(directory, 'input.csv'), json = join(directory, 'mapping.json');
    const cli = new URL('../tools/import-preview.ts', import.meta.url).pathname;
    writeFileSync(csv, `${header}\n${row}`);
    writeFileSync(json, JSON.stringify(mapping));
    const run = () => spawnSync(process.execPath, [cli, 'spreadsheet', csv, json], { encoding: 'utf8' });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).issueCounts, {});
    assert.doesNotMatch(result.stdout, /Avery|a@example|gift-001/);
    writeFileSync(json, '{"private@example.com":');
    const malformed = run();
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stderr.trim(), 'Mapping file must contain valid JSON');
    assert.equal(malformed.stdout, '');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
