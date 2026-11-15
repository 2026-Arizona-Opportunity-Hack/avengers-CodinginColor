import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const aliases = new Map([
  ['first name', 'first_name'], ['last name', 'last_name'],
  ['email', 'email'], ['email address', 'email'],
  ['phone', 'phone'], ['phone number', 'phone'], ['company', 'company'],
  ['donation amount', 'amount_cents'], ['contact person', 'contact_person'],
  ['campaign', 'campaign'],
]);
const sources = ['spreadsheet', 'zeffy', 'benevity'];
const MAX_BYTES = 5 * 1024 * 1024;
type Issue = { recordNumber: number | null; field: string; code: string };

export function parseCsv(text: string): string[][] {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('CSV exceeds 5 MiB');
  if (text.includes('\0')) throw new Error('CSV contains a NUL character');
  text = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else cell += ch;
      continue;
    }
    if (closed && ch !== ',' && ch !== '\r' && ch !== '\n') {
      throw new Error(`Unexpected text after quote at record ${records.length + 1}`);
    }
    if (ch === '"') {
      if (cell) throw new Error(`Unexpected quote at record ${records.length + 1}`);
      quoted = true;
    } else if (ch === ',' || ch === '\r' || ch === '\n') {
      row.push(cell); cell = ''; closed = false;
      if (ch !== ',') {
        records.push(row); row = [];
        if (ch === '\r' && text[i + 1] === '\n') i++;
      }
    } else cell += ch;
  }
  if (quoted) throw new Error(`Unclosed quote at record ${records.length + 1}`);
  if (row.length || cell || closed) records.push([...row, cell]);
  return records;
}

export function parseAmountCents(value: string): number | null {
  const text = value.trim();
  if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.replace(/^\$/, '').replaceAll(',', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

export function previewCsv(text: string, source: string, file: string) {
  if (!sources.includes(source)) throw new Error('Source must be spreadsheet, zeffy or benevity');
  const [headers, ...records] = parseCsv(text);
  if (!headers || headers.every(header => !header.trim())) throw new Error('CSV header is missing');
  const normalized = headers.map(header => header.trim().toLowerCase().replace(/[_-]/g, ' '));
  if (normalized.some(header => !header) || new Set(normalized).size !== headers.length) {
    throw new Error('CSV has blank or duplicate headers');
  }
  const mapping = normalized.map(header => aliases.get(header) ?? null);
  const mapped = mapping.filter(field => field !== null);
  if (new Set(mapped).size !== mapped.length) throw new Error('Multiple columns map to the same field');
  const issues: Issue[] = [];
  mapping.forEach((field, i) => {
    if (!field) issues.push({ recordNumber: null, field: headers[i], code: 'unmapped_column' });
  });
  if (!mapping.includes('amount_cents')) {
    issues.push({ recordNumber: null, field: 'amount_cents', code: 'missing_column' });
  }
  // shortcut: sample exports lack gift metadata; add source adapters after real export contracts are agreed.
  for (const field of ['occurred_at', 'currency']) {
    issues.push({ recordNumber: null, field, code: 'unresolved_gift_metadata' });
  }
  if (!records.length) issues.push({ recordNumber: null, field: 'rows', code: 'empty_file' });
  const rows = records.map((raw, index) => {
    const recordNumber = index + 2;
    const issue = (field: string, code: string) => issues.push({ recordNumber, field, code });
    if (raw.length !== headers.length) issue('row', 'column_count_mismatch');
    const values: Record<string, string | number | null> = {};
    mapping.forEach((field, i) => {
      if (!field) return;
      const value = (raw[i] ?? '').trim();
      values[field] = value || null;
      if (field !== 'phone' && field !== 'amount_cents' && /^[=+@-]/.test(value)) {
        issue(field, 'spreadsheet_formula');
      }
      if (field === 'amount_cents') {
        values[field] = parseAmountCents(value);
        if (values[field] === null) issue(field, value ? 'invalid_amount' : 'missing_amount');
        else if (values[field] === 0) issue(field, 'non_positive_amount');
      }
      if (field === 'email' && value) {
        values[field] = value.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) issue(field, 'invalid_email');
      }
      if (field === 'phone' && value) {
        const digits = value.replace(/\D/g, '');
        if (!/^\+?[\d().\s-]+$/.test(value) || digits.length < 7 || digits.length > 15) {
          issue(field, 'invalid_phone');
        } else values[field] = (value.startsWith('+') ? '+' : '') + digits;
      }
    });
    if (!values.first_name && !values.last_name && !values.company) issue('name', 'missing_donor_name');
    if (!values.email && !values.phone) issue('contact', 'missing_contact');
    return { recordNumber, raw, values };
  });
  return { source, file, status: 'needs_review' as const, headers, mapping, rows, issues };
}

if (import.meta.main) {
  try {
    const [source, file, ...extra] = process.argv.slice(2);
    if (!source || !file || extra.length || !file.toLowerCase().endsWith('.csv')) {
      throw new Error('Usage: node tools/import-preview.ts <spreadsheet|zeffy|benevity> <file.csv>');
    }
    const bytes = await readFile(file);
    if (bytes.length > MAX_BYTES) throw new Error('CSV exceeds 5 MiB');
    const preview = previewCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes), source, basename(file));
    const issueCounts: Record<string, number> = {};
    for (const issue of preview.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
    console.log(JSON.stringify({ source, file: preview.file, status: preview.status,
      rowCount: preview.rows.length, issueCounts }, null, 2));
  } catch (error) {
    // Filesystem errors may contain private paths; only validation messages are safe to display.
    console.error(error instanceof Error && !('code' in error) ? error.message : 'Unable to read CSV file');
    process.exitCode = 1;
  }
}
