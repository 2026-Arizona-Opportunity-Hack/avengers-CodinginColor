import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAmountCents, parseCsv, previewCsv } from '../tools/import-preview.ts';

const header = 'first name,last name,email,phone,company,donation amount,contact person,campaign';
const row = ' Avery ,Smith, AVERY@example.com ,(602) 555-1000,Example,10.25,Jordan,AI Academy';
const preview = (body: string) => previewCsv(`${header}\n${body}`, 'spreadsheet', 'test.csv');

test('parses BOM, CRLF, quotes, commas, multiline cells and trailing empty cells', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b,c\r\n"a,b","say ""hi""",\r\n"two\nlines",x,y'), [
    ['a', 'b', 'c'], ['a,b', 'say "hi"', ''], ['two\nlines', 'x', 'y'],
  ]);
  assert.deepEqual(parseCsv('a,b\r1,2\r'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n"",'), [['a', 'b'], ['', '']]);
});

test('rejects malformed CSV rather than guessing or dropping data', () => {
  for (const input of ['a\n"unclosed', 'a\n"closed"oops', 'a\nnot"quoted', 'a\0b']) {
    assert.throws(() => parseCsv(input));
  }
  assert.throws(() => parseCsv('x'.repeat(5 * 1024 * 1024 + 1)), /5 MiB/);
});

test('converts decimal amounts exactly and rejects ambiguous or unsafe amounts', () => {
  for (const [input, expected] of [['0.29', 29], ['10.5', 1050], ['$1,234.56', 123456], ['0', 0]] as const) {
    assert.equal(parseAmountCents(input), expected);
  }
  for (const input of ['', '1,23', '-10', '(10)', '1.234', '1e3', 'NaN', 'Infinity', '12 USD', '90071992547409.92']) {
    assert.equal(parseAmountCents(input), null, input);
  }
  assert.equal(parseAmountCents('90071992547409.91'), Number.MAX_SAFE_INTEGER);
});

test('normalizes fields while retaining raw source cells, provenance and review blockers', () => {
  const result = preview(row);
  assert.equal(result.source, 'spreadsheet');
  assert.equal(result.file, 'test.csv');
  assert.equal(result.status, 'needs_review');
  assert.equal(result.rows[0].recordNumber, 2);
  assert.equal(result.rows[0].raw[2], ' AVERY@example.com ');
  assert.deepEqual(result.rows[0].values, { first_name: 'Avery', last_name: 'Smith', email: 'avery@example.com',
    phone: '6025551000', company: 'Example', amount_cents: 1025, contact_person: 'Jordan', campaign: 'AI Academy' });
  assert.deepEqual(result.issues.filter(issue => issue.code === 'unresolved_gift_metadata')
    .map(issue => issue.field), ['occurred_at', 'currency']);
  assert.ok(!('external_id' in result.rows[0].values));
  assert.ok(!('owner_id' in result.rows[0].values));
});

test('reports invalid values, formulas and row width without losing records', () => {
  const result = preview(',,bad-email,abc,=SUM(A1),-10,,\n\nName,,,+16025551000,Example,0,,,extra');
  assert.equal(result.rows.length, 3);
  const codes = result.issues.map(issue => issue.code);
  for (const code of ['invalid_email', 'invalid_phone', 'spreadsheet_formula', 'invalid_amount',
    'column_count_mismatch', 'missing_amount', 'missing_donor_name', 'missing_contact', 'non_positive_amount']) {
    assert.ok(codes.includes(code), code);
  }
  assert.equal(result.rows[2].values.phone, '+16025551000');
  assert.equal(result.rows[2].raw.at(-1), 'extra');
});

test('maps safe aliases and leaves semantic ambiguity for review', () => {
  const result = previewCsv('First_Name,EMAIL ADDRESS,Contribution Value\nAvery,a@example.com,12', 'zeffy', 'test.csv');
  assert.deepEqual(result.mapping, ['first_name', 'email', null]);
  assert.equal(result.rows[0].raw[2], '12');
  assert.ok(result.issues.some(issue => issue.code === 'unmapped_column'));
  assert.ok(result.issues.some(issue => issue.code === 'missing_column'));
});

test('rejects missing, duplicate and colliding headers and unsupported sources', () => {
  for (const input of ['', '\n', 'email, EMAIL\na,b', 'email,email address\na,b', 'email,\na,b']) {
    assert.throws(() => previewCsv(input, 'spreadsheet', 'test.csv'));
  }
  assert.throws(() => previewCsv(header, 'unknown', 'test.csv'), /Source/);
  assert.ok(preview('').issues.some(issue => issue.code === 'empty_file'));
});

test('all three sample files retain every row and remain repeatable without mutation', () => {
  for (const [source, name, count] of [
    ['spreadsheet', 'cic_donor_spreadsheet.csv', 75], ['zeffy', 'zeffy_export.csv', 75],
    ['benevity', 'benevity_export.csv', 60],
  ] as const) {
    const path = new URL(`../data/${name}`, import.meta.url);
    const original = readFileSync(path, 'utf8');
    const result = previewCsv(original, source, name);
    assert.equal(result.rows.length, count);
    assert.deepEqual(previewCsv(original, source, name), result);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.ok(result.rows.every(record => record.raw.length === 8));
  }
});

test('CLI prints counts without donor contact details and fails visibly on bad input', () => {
  const cli = fileURLToPath(new URL('../tools/import-preview.ts', import.meta.url));
  const file = fileURLToPath(new URL('../data/cic_donor_spreadsheet.csv', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'spreadsheet', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rowCount, 75);
  assert.doesNotMatch(result.stdout, /@|555|Avery/);
  const bad = spawnSync(process.execPath, [cli, 'spreadsheet', '/missing/private.csv'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.trim(), 'Unable to read CSV file');
  assert.equal(bad.stdout, '');
});
