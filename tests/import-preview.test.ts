import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('accepts the five review sources and rejects unknown labels', () => {
  for (const source of ['spreadsheet', 'zeffy', 'benevity', 'az_gives', 'united_way']) {
    assert.equal(previewCsv(header, source, 'test.csv').source, source);
  }
  assert.throws(() => previewCsv(header, 'az-gives', 'test.csv'), /Source/);
});

test('maps unambiguous AZ Gives headers and keeps # after normalization', () => {
  const azHeader = 'Donor First,Donor Last,Donor Email Address,Mobile #,Employer Name,Gift Amt,Board Contact,Designation,Donation Date';
  const result = previewCsv(`${azHeader}\nAvery,Rivera,avery.rivera@example.org,602-555-0100,` +
    'Copperline Energy,$150.00,Marcus Bell,AZ Gives 2026,04/07/2026', 'az_gives', 'test.csv');
  assert.deepEqual(result.mapping, ['first_name', 'last_name', 'email', 'phone', 'company',
    'amount_cents', 'contact_person', 'campaign', 'occurred_at']);
  assert.equal(result.rows[0].values.amount_cents, 15000);
  assert.equal(result.rows[0].values.phone, '6025550100');
  assert.equal(result.rows[0].values.occurred_at, null);
  assert.ok(result.issues.some(issue => issue.code === 'invalid_occurred_at'));
});

test('AZ Gives sample rows retain contacts while unconfirmed dates stay in review', () => {
  const path = new URL('../apps/web/public/samples/az_gives_export.csv', import.meta.url);
  const result = previewCsv(readFileSync(path, 'utf8'), 'az_gives', 'az_gives_export.csv');
  assert.equal(result.rows.length, 8);
  const values = result.rows.map(record => record.values);
  assert.deepEqual(values.map(value => value.amount_cents),
    [15000, 7500, 25000, 4000, 10000, 6000, null, 50000]);
  assert.ok(values.every(value => value.first_name && value.last_name && value.email
    && value.phone && value.campaign));
  for (const code of ['missing_donor_name', 'missing_contact', 'unmapped_column']) {
    assert.ok(!result.issues.some(issue => issue.code === code), code);
  }
  assert.equal(result.issues.filter(issue => issue.code === 'invalid_occurred_at').length, 8);
  assert.ok(result.issues.some(issue => issue.code === 'invalid_email' && issue.recordNumber === 7));
});

test('CLI accepts a confirmed date pair anywhere and rejects partial or invalid flags', () => {
  const cli = fileURLToPath(new URL('../tools/import-preview.ts', import.meta.url));
  const file = fileURLToPath(new URL('../apps/web/public/samples/az_gives_export.csv', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'az_gives', file, ...args],
    { encoding: 'utf8' });
  const result = run('--utc-offset', '-07:00', '--date-format', 'MM/DD/YYYY');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rowCount, 8);
  assert.equal(JSON.parse(result.stdout).issueCounts.invalid_occurred_at, undefined);
  assert.doesNotMatch(result.stdout, /avery|@|555/);
  const directory = mkdtempSync(join(tmpdir(), 'cic-dates-'));
  try {
    const json = join(directory, 'mapping.json');
    writeFileSync(json, '{}');
    const mapped = spawnSync(process.execPath,
      [cli, 'az_gives', file, json, '--date-format', 'DD/MM/YYYY', '--utc-offset', '+00:00'],
      { encoding: 'utf8' });
    assert.equal(mapped.status, 0, mapped.stderr);
    assert.equal(JSON.parse(mapped.stdout).issueCounts.invalid_occurred_at, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  for (const args of [['--date-format', 'MM/DD/YYYY'], ['--utc-offset', '-07:00'],
    ['--date-format', 'YY/MM/DD', '--utc-offset', '-07:00'],
    ['--date-format', 'MM/DD/YYYY', '--utc-offset', '-15:00']]) {
    const bad = run(...args);
    assert.equal(bad.status, 1, args.join(' '));
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /date/i);
  }
});

test('CLI argument errors never echo unexpected values or private paths', () => {
  const cli = fileURLToPath(new URL('../tools/import-preview.ts', import.meta.url));
  const file = fileURLToPath(new URL('../apps/web/public/samples/az_gives_export.csv', import.meta.url));
  for (const args of [['--private=avery@example.org'], ['mapping.json', '/private/donor-list.csv']]) {
    const result = spawnSync(process.execPath, [cli, 'az_gives', file, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /avery@example|\/private\/donor-list/);
  }
});
