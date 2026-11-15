import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { importFixture } from './import-fixture.ts';
import { fingerprintFile } from '../../tools/import-review.ts';

const headers = { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'X-Import-Source': 'zeffy', 'X-Import-Filename': 'synthetic.xlsx' };
const layout = { mapping: {}, batch_values: { currency: 'USD', occurred_at: '2026-11-01T12:00:00-07:00',
  status: 'settled', refund_cents: 0 } };
function workbook(extra: Record<string, string> = {}, rows = [
  ['first name', 'last name', 'email', 'donation amount', 'external id'],
  ['Avery', 'Example, "CIC"', 'avery@example.org', '12.34', 'tx-xlsx']]) {
  const files = { '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Donors" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) =>
      `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`,
    ...extra };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, xml]) => [path, Buffer.from(xml)]))));
}

test('Zeffy summary columns stage intact and retain financial review blockers', async t => {
  const { call, sql } = await importFixture(t);
  const columns = ['First name', 'Last name', 'Email', 'Secondary email', 'Amount',
    'First payment date (America/Phoenix)', 'Last payment date (America/Phoenix)',
    'Language', 'Address', 'City', 'Postal code', 'Country', 'Region', 'Phone', 'Company name',
    'Notes', 'Manual lists', 'Unsubscribed', 'Interested in volunteering?', 'Notes'];
  const row = ['Avery', 'Example', 'avery@example.org', '', '12.34', '11/01/2026, 1:05 PM',
    '11/01/2026, 1:05 PM', 'en', '', '', '', '', '', '', 'Example company', 'First note', '', 'No', '', 'Second note'];
  const bytes = workbook({}, [columns, row]);
  const uploaded = await call('POST', '', bytes, 'admin', headers);
  assert.equal(uploaded.status, 201);
  const batch = await uploaded.json() as { batch_id: string; preview: { headers: string[] } };
  assert.equal(batch.preview.headers.at(-1), 'Notes (2)');
  const unreviewed = await (await call('POST', `/${batch.batch_id}/donors/plan`)).json() as { unresolved: { field: string }[] };
  for (const field of ['currency', 'occurred_at', 'status', 'refund_cents'])
    assert.ok(unreviewed.unresolved.some(i => i.field === field), field);
  const mapping: Record<string, string | null> = Object.fromEntries(batch.preview.headers.map(h => [h, null]));
  Object.assign(mapping, { 'First name': 'first_name', 'Last name': 'last_name', Email: 'email',
    Amount: 'amount_decimal', 'Company name': 'company', 'Last payment date (America/Phoenix)': 'occurred_at' });
  const applied = await call('POST', `/${batch.batch_id}/layout`, { mapping,
    date_format: 'MM/DD/YYYY, h:mm A', utc_offset: '-07:00',
    batch_values: { currency: 'USD', status: 'settled', refund_cents: 0 } });
  assert.equal(applied.status, 200);
  const result = await applied.json() as { preview: { issues: unknown[]; counts: { rows: number; excluded: number } } };
  assert.deepEqual(result.preview.issues, []);
  assert.equal(result.preview.counts.rows, 1);
  assert.equal(result.preview.counts.excluded, 0);
  const drafts = await (await call('GET', `/${batch.batch_id}/rows?kind=gift`)).json() as {
    items: { amount_cents: number; occurred_at: string }[] };
  assert.equal(drafts.items[0].amount_cents, 1234);
  assert.equal(drafts.items[0].occurred_at, '2026-11-01T13:05:00-07:00');
  const previewRows = await (await call('GET', `/${batch.batch_id}/rows`)).json() as { items: { raw: string[] }[] };
  assert.equal(previewRows.items[0].raw[15], 'First note');
  assert.equal(previewRows.items[0].raw[19], 'Second note');
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.equal((await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM donors')).rows[0].n, 0);
  assert.equal((await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM gifts')).rows[0].n, 0);
});

test('XLSX uploads retain original fingerprints, reuse review/commit, replay safely and purge private cells', async t => {
  const { call, sql } = await importFixture(t);
  const bytes = workbook();
  const uploaded = await call('POST', '', bytes, 'admin', headers);
  assert.equal(uploaded.status, 201);
  const batch = await uploaded.json() as { batch_id: string; file_sha256: string };
  assert.equal(batch.file_sha256, fingerprintFile(bytes));
  const id = batch.batch_id;
  assert.equal((await call('POST', `/${id}/layout`, layout)).status, 200);
  const rows = await (await call('GET', `/${id}/rows?kind=preview`)).json() as { items: { raw: string[] }[] };
  assert.equal(rows.items[0].raw[1], 'Example, "CIC"');
  const donor = await (await call('POST', `/${id}/donors/plan`)).json() as { plan_hash: string };
  assert.equal((await call('POST', `/${id}/donors/review`, { plan_hash: donor.plan_hash, decisions: [] })).status, 200);
  const gift = await (await call('POST', `/${id}/gifts/plan`)).json() as { plan_hash: string };
  const hashes = { donor_plan_hash: donor.plan_hash, plan_hash: gift.plan_hash };
  assert.equal((await call('POST', `/${id}/gifts/review`, { ...hashes, decisions: [] })).status, 200);
  const committed = await call('POST', `/${id}/commit`, hashes);
  assert.equal(committed.status, 200);
  assert.equal((await committed.json() as { counts: { gifts_inserted: number } }).counts.gifts_inserted, 1);
  const replay = await call('POST', '', bytes, 'admin', headers);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
  assert.equal((await call('POST', '', bytes, 'admin', { ...headers, 'X-Import-Source': 'benevity' })).status, 409);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  const stored = (await sql.query<{ raw_csv: unknown; file_sha256: string; status: string }>(
    'SELECT raw_csv,file_sha256,status FROM import_batches WHERE id=$1', [id])).rows[0];
  assert.deepEqual(stored, { raw_csv: null, file_sha256: fingerprintFile(bytes), status: 'committed' });
  assert.equal((await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM gifts')).rows[0].n, 1);
});

test('XLSX auth, MIME, extension and unsafe workbooks fail without staged data', async t => {
  const { call, sql } = await importFixture(t);
  const bytes = workbook();
  for (const [who, status] of [[null, 401], ['board', 403], ['foreign', 403], ['admin-no-mfa', 403]] as const)
    assert.equal((await call('POST', '', bytes, who, headers)).status, status);
  assert.equal((await call('POST', '', bytes, 'admin', { ...headers, 'X-Import-Filename': 'macro.xlsm' })).status, 415);
  assert.equal((await call('POST', '', bytes, 'admin', { ...headers, 'Content-Type': 'application/octet-stream' })).status, 415);
  for (const unsafe of [Buffer.from('not a workbook'), workbook({ 'xl/vbaProject.bin': 'macro' }),
    workbook({ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>' })]) {
    const response = await call('POST', '', unsafe, 'admin', headers);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_xlsx' });
  }
  assert.equal((await call('POST', '', Buffer.alloc(4194305), 'admin', headers)).status, 413);
  const expanded = workbook({ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>email</t></is></c></row>' +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>${'a'.repeat(4194305)}</t></is></c></row></sheetData></worksheet>` });
  assert.ok(expanded.length < 4194304);
  assert.equal((await call('POST', '', expanded, 'admin', headers)).status, 413);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.equal((await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM import_batches')).rows[0].n, 1);
  assert.equal((await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM donors')).rows[0].n, 0);
});

test('XLSX staging and audit roll back together', async t => {
  const { call, sql } = await importFixture(t);
  await sql.exec(`SET SESSION AUTHORIZATION postgres; RESET ROLE;
    CREATE FUNCTION reject_stage_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'unavailable'; END $$;
    CREATE TRIGGER reject_stage_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_stage_audit();
    SET SESSION AUTHORIZATION import_login;`);
  assert.equal((await call('POST', '', workbook(), 'admin', headers)).status, 503);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.equal((await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM import_batches')).rows[0].n, 1);
});
