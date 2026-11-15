import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Zip, ZipPassThrough, zipSync } from 'fflate';
import { previewCsv } from '../tools/import-preview.ts';
import { previewXlsx } from '../tools/import-xlsx.ts';
import { buildImportDrafts } from '../tools/import-drafts.ts';

type Cell = string | { n: string } | { raw: string } | null;
type Sheet = { name: string; state?: string };
const esc = (s: string) => s.replace(/[&<>]/g, c => `&#${c.charCodeAt(0)};`);
const col = (i: number) => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
const cellXml = (ref: string, c: Cell) => c === null ? '' : typeof c === 'object' && 'n' in c
  ? `<c r="${ref}"><v>${c.n}</v></c>` : typeof c === 'object' ? c.raw
  : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(c)}</t></is></c>`;
const sheetXml = (rows: Cell[][], numbers = rows.map((_, i) => i + 1)) =>
  `<worksheet><sheetData>${rows.map((row, r) => `<row r="${numbers[r]}">` +
    row.map((c, i) => cellXml(`${col(i)}${numbers[r]}`, c)).join('') + '</row>').join('')}</sheetData></worksheet>`;
const workbook = (sheets: Sheet[]) => `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) =>
  `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const rels = (sheets = 1, styles = false) => `<Relationships>` + Array.from({ length: sheets }, (_, i) =>
  `<Relationship Id="rId${i + 1}" Type="${rel}worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
  (styles ? `<Relationship Id="rId99" Type="${rel}styles" Target="styles.xml"/>` : '') + `</Relationships>`;
function xlsx(rows: Cell[][], o: { sheets?: Sheet[]; sheet?: string; numbers?: number[]; styles?: string; extra?: Record<string, string> } = {}) {
  const sheets = o.sheets ?? [{ name: 'Sheet1' }];
  const files: Record<string, string> = { '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': workbook(sheets),
    'xl/_rels/workbook.xml.rels': rels(sheets.length, !!o.styles),
    'xl/worksheets/sheet1.xml': o.sheet ?? sheetXml(rows, o.numbers), ...o.extra };
  if (o.styles) files['xl/styles.xml'] = o.styles;
  for (let i = 2; i <= sheets.length; i++) files[`xl/worksheets/sheet${i}.xml`] = sheetXml([['unused']]);
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])));
}
const preview = (bytes: Uint8Array, mapping: unknown = {}, options?: unknown) =>
  previewXlsx(bytes, 'spreadsheet', 'test.xlsx', mapping, options);
const header = ['first name', 'last name', 'email', 'phone', 'company', 'donation amount', 'contact person', 'campaign'];
const data = ['Avery', 'Smith', 'avery@example.org', '6025551000', 'Example', '10.25', 'Jordan', 'AI Academy'];

test('matches the canonical CSV preview, exact cents and raw text cells', async () => {
  const rows: Cell[][] = [header,
    [' Avery ', 'Smith', ' AVERY@example.com ', '(602) 555-1000', 'Example', { n: '90071992547409.91' }, 'Jordan', 'AI Academy'],
    ['Zoë', 'O\'Brien, "Z"', 'zoe@example.org', '+44 20 7946 0958', 'Café Ltd', { n: '1.2345678901234567E+15' }, 'Renée', 'München']];
  const csv = [header, [' Avery ', 'Smith', ' AVERY@example.com ', '(602) 555-1000', 'Example',
    '90071992547409.91', 'Jordan', 'AI Academy'], ['Zoë', 'O\'Brien, "Z"', 'zoe@example.org',
    '+44 20 7946 0958', 'Café Ltd', '1.2345678901234567E+15', 'Renée', 'München']]
    .map(row => row.map(v => /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v).join(',')).join('\n');
  const result = await preview(xlsx(rows));
  const expected = previewCsv(csv, 'spreadsheet', 'test.xlsx');
  assert.deepEqual({ headers: result.headers, mapping: result.mapping, rows: result.rows, issues: result.issues },
    { headers: expected.headers, mapping: expected.mapping, rows: expected.rows, issues: expected.issues });
  assert.equal(result.rows[0].values.amount_cents, Number.MAX_SAFE_INTEGER);
  assert.equal(result.rows[1].raw[1], 'O\'Brien, "Z"');
  assert.equal(result.rows[1].raw[5], '1.2345678901234567E+15');
  assert.ok(result.issues.some(issue => issue.code === 'invalid_amount' && issue.recordNumber === 3));
});

test('rejects formula XML and cached formula values but reviews literal formulas', async () => {
  const cached: Cell[][] = [header, ['A', 'B', 'a@b.co', '6025551000', 'C',
    { raw: '<c r="F2"><f>SUM(1,2)</f><v>999.99</v></c>' }, 'D', 'E']];
  await assert.rejects(preview(xlsx(cached)), /formula/i);
  const literal = await preview(xlsx([header, ['=Avery', 'B', 'a@b.co', '6025551000', 'C', '10', 'D', 'E']]));
  assert.ok(literal.issues.some(issue => issue.code === 'spreadsheet_formula'));
});

test('rejects date-formatted numeric cells and never invents dates', async () => {
  const withDate = [...header, 'donation date'];
  const base: Cell[] = ['A', 'B', 'a@b.co', '6025551000', 'C', '10', 'D', 'E'];
  const styled: Cell[][] = [withDate, [...base, { raw: '<c r="I2" s="1"><v>46119</v></c>' }]];
  const styles = '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
  await assert.rejects(preview(xlsx(styled, { styles })), /date/i);
  const text: Cell[][] = [withDate, [...base, '04/07/2026']];
  const plain = await preview(xlsx(text));
  assert.equal(plain.rows[0].values.occurred_at, null);
  assert.ok(plain.issues.some(issue => issue.code === 'invalid_occurred_at'));
  const confirmed = await preview(xlsx(text), {}, { date_format: 'MM/DD/YYYY', utc_offset: '-07:00' });
  assert.equal(confirmed.rows[0].values.occurred_at, '2026-04-07T00:00:00-07:00');
});

test('preserves physical row gaps without mutating input bytes', async () => {
  const bytes = xlsx([header, data], { numbers: [1, 3] });
  const before = Uint8Array.from(bytes);
  const result = await preview(bytes);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].recordNumber, 2);
  assert.equal(result.rows[1].recordNumber, 3);
  assert.deepEqual(result.rows[0].raw, header.map(() => ''));
  assert.deepEqual(bytes, before);
  const drafts = buildImportDrafts(result, { batch_id: '550e8400-e29b-41d4-a716-446655440003',
    values: { currency: 'USD', status: 'settled', refund_cents: 0, occurred_at: '2026-11-15T12:00:00Z' } });
  assert.deepEqual(drafts.excluded.map(row => row.recordNumber), [2]);
  assert.equal(drafts.gifts[0].source_row.row_key, '3');
});

test('fails closed on empty, leading-blank, multiple and hidden sheets', async () => {
  await assert.rejects(preview(xlsx([])), /header/i);
  await assert.rejects(preview(xlsx([[], data])), /header/i);
  await assert.rejects(preview(xlsx([header], { sheets: [{ name: 'One' }, { name: 'Two' }] })), /worksheet/i);
  await assert.rejects(preview(xlsx([header], { sheets: [{ name: 'One' }, { name: 'Two', state: 'hidden' }] })), /worksheet/i);
  await assert.rejects(preview(xlsx([header], { sheets: [{ name: 'One', state: 'hidden' }] })), /visible|worksheet/i);
});

test('bounds archive expansion, worksheet coordinates and malformed structures', async () => {
  await assert.rejects(preview(xlsx([header], {
    sheet: '<worksheet><sheetData><row r="1e309"><c r="A1"><v>1</v></c></row></sheetData></worksheet>' })), /invalid|limit/i);
  await assert.rejects(preview(xlsx([header], {
    sheet: '<worksheet><sheetData><row r="20002"><c r="A1"><v>1</v></c></row></sheetData></worksheet>' })), /limit/i);
  await assert.rejects(preview(xlsx([header], {
    sheet: '<worksheet><sheetData><row r="50000"/></sheetData></worksheet>' })), /limit/i);
  const complete = xlsx([header]);
  await assert.rejects(preview(complete.slice(0, -10)), /invalid|missing/i);
  await assert.rejects(preview(xlsx([header], { sheet: '<worksheet><sheetData><row r="1">' })), /XLSX contains invalid XML/i);
  await assert.rejects(preview(xlsx([header], {
    extra: { 'xl/sharedStrings.xml': `<sst>${'A'.repeat(9 * 1024 * 1024)}</sst>` } })), /limit/i);
  await assert.rejects(preview(xlsx([header], {
    sheet: '<worksheet><sheetData><row r="1"><c r="XFD1048576"><v>1</v></c></row></sheetData></worksheet>' })), /limit/i);
  await assert.rejects(preview(xlsx([header], {
    sheet: '<worksheet><dimension ref="A1:GR20002"/><sheetData/></worksheet>' })), /limit/i);
  await assert.rejects(preview(xlsx([header], {
    sheet: '<worksheet><dimension ref="A1:IW1"/><sheetData/></worksheet>' })), /limit/i);
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk, final) => {
    if (error) throw error;
    chunks.push(chunk);
    assert.ok(final || chunk);
  });
  for (const name of ['a.xml', 'a.xml']) {
    const file = new ZipPassThrough(name);
    zip.add(file);
    file.push(new TextEncoder().encode('<a/>'), true);
  }
  zip.end();
  await assert.rejects(preview(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))), /invalid/i);
  await assert.rejects(preview(xlsx([header]).slice(0, 50)), /invalid|missing/i);
  await assert.rejects(preview(new Uint8Array([0x50, 0x4b, 3])), /invalid|missing/i);
  await assert.rejects(preview(xlsx([header], {
    sheet: '<!DOCTYPE x><worksheet><sheetData/></worksheet>' })), /unsupported XML/i);
});

test('rejects a compressed bomb before a large inflated buffer is allocated', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cic-xlsx-bomb-'));
  try {
    const file = join(directory, 'bomb.xlsx');
    writeFileSync(file, xlsx([header], { extra: { 'xl/sharedStrings.xml': `<sst>${'A'.repeat(80 * 1024 * 1024)}</sst>` } }));
    const module = fileURLToPath(new URL('../tools/import-xlsx.ts', import.meta.url));
    const script = `import { readFileSync } from 'node:fs';
      const { previewXlsx } = await import(process.argv[1]);
      try { await previewXlsx(readFileSync(process.argv[2]), 'spreadsheet', 'bomb.xlsx'); process.exitCode = 2; }
      catch (error) { if (!/safety limits/.test(error.message)) process.exitCode = 3; }
      console.log(process.resourceUsage().maxRSS);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, module, file],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Number(result.stdout.trim()) < 120_000, `peak RSS exceeded 120 MiB: ${result.stdout.trim()} KiB`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('reports generic private errors without leaking content', async () => {
  const broken = xlsx([header, ['Avery', 'Smith', 'avery@example.org', '6025551000', 'C', '10', 'D', 'E']]).slice(0, 60);
  await assert.rejects(preview(broken), (error: Error) => {
    assert.match(error.message, /XLSX/);
    assert.doesNotMatch(error.message, /Avery|avery@|555/);
    return true;
  });
});

test('CLI prints only counts and fails safely on a missing file', () => {
  const cli = fileURLToPath(new URL('../tools/import-xlsx.ts', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'cic-xlsx-'));
  try {
    const file = join(directory, 'donors.xlsx');
    writeFileSync(file, xlsx([[...header, 'donation date'], [...data.slice(0, 7), 'AI Academy', '04/07/2026']]));
    const ok = spawnSync(process.execPath, [cli, 'spreadsheet', file,
      '--date-format', 'MM/DD/YYYY', '--utc-offset', '-07:00'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).rowCount, 1);
    assert.equal('file' in JSON.parse(ok.stdout), false);
    assert.equal(JSON.parse(ok.stdout).issueCounts.invalid_occurred_at, undefined);
    assert.doesNotMatch(ok.stdout, /Avery|avery@|555/);
    const missing = spawnSync(process.execPath, [cli, 'spreadsheet', join(directory, 'secret.xlsx')],
      { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.doesNotMatch(missing.stderr, /secret/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
