import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { GiftWriteSchema } from '../packages/contracts/index.ts';

const aliases = new Map([
  ['first name', 'first_name'], ['last name', 'last_name'],
  ['email', 'email'], ['email address', 'email'],
  ['phone', 'phone'], ['phone number', 'phone'], ['company', 'company'],
  ['donation amount', 'amount_cents'], ['contact person', 'contact_person'],
  ['campaign', 'campaign'], ['amount cents', 'amount_cents'],
  ['occurred at', 'occurred_at'], ['currency', 'currency'], ['external id', 'external_id'],
]);
const mappingTargets = new Set([...aliases.values(), 'amount_decimal']);
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

export function previewCsv(text: string, source: string, file: string, columnMapping: unknown = {}) {
  if (!sources.includes(source)) throw new Error('Source must be spreadsheet, zeffy or benevity');
  const [headers, ...records] = parseCsv(text);
  if (!headers || headers.every(header => !header.trim())) throw new Error('CSV header is missing');
  const normalized = headers.map(header => header.trim().toLowerCase().replace(/[_-]/g, ' '));
  if (normalized.some(header => !header) || new Set(normalized).size !== headers.length) {
    throw new Error('CSV has blank or duplicate headers');
  }
  if (!columnMapping || typeof columnMapping !== 'object' || Array.isArray(columnMapping)) {
    throw new Error('Column mapping must be a JSON object');
  }
  const chosen = new Map<string, string | null>();
  for (const [header, target] of Object.entries(columnMapping)) {
    if (!headers.includes(header) || (target !== null &&
        (typeof target !== 'string' || !mappingTargets.has(target)))) {
      throw new Error('Mapping must reference existing headers and supported fields');
    }
    chosen.set(header, target);
  }
  const mapping = normalized.map((header, i) => {
    const target = chosen.has(headers[i]) ? chosen.get(headers[i]) : aliases.get(header);
    return target === 'amount_decimal' ? 'amount_cents' : target ?? null;
  });
  const mapped = mapping.filter(field => field !== null);
  if (new Set(mapped).size !== mapped.length) throw new Error('Multiple columns map to the same field');
  const issues: Issue[] = [];
  mapping.forEach((field, i) => {
    if (!field && !chosen.has(headers[i])) {
      issues.push({ recordNumber: null, field: headers[i], code: 'unmapped_column' });
    }
  });
  if (!mapping.includes('amount_cents')) {
    issues.push({ recordNumber: null, field: 'amount_cents', code: 'missing_column' });
  }
  for (const field of ['occurred_at', 'currency']) {
    if (!mapping.includes(field)) issues.push({ recordNumber: null, field, code: 'unresolved_gift_metadata' });
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
        const alreadyCents = chosen.has(headers[i])
          ? chosen.get(headers[i]) === 'amount_cents' : normalized[i] === 'amount cents';
        if (alreadyCents) {
          const cents = /^\d+$/.test(value) ? Number(value) : NaN;
          values[field] = GiftWriteSchema.shape.amount_cents.safeParse(cents).success ? cents : null;
        } else values[field] = parseAmountCents(value);
        if (values[field] === null) issue(field, value ? 'invalid_amount' : 'missing_amount');
        else if (values[field] === 0) issue(field, 'non_positive_amount');
      }
      if (field === 'occurred_at' || field === 'currency' || field === 'external_id') {
        const input = field === 'currency' ? value.toUpperCase() : value || null;
        const parsed = GiftWriteSchema.shape[field].safeParse(input);
        if (parsed.success) values[field] = parsed.data ?? null;
        else {
          values[field] = null;
          issue(field, value ? `invalid_${field}` : 'missing_gift_metadata');
        }
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
    const [source, file, mappingFile, ...extra] = process.argv.slice(2);
    if (!source || !file || extra.length || !file.toLowerCase().endsWith('.csv') ||
        (mappingFile && !mappingFile.toLowerCase().endsWith('.json'))) {
      throw new Error('Usage: node tools/import-preview.ts <spreadsheet|zeffy|benevity> <file.csv> [mapping.json]');
    }
    const bytes = await readFile(file);
    if (bytes.length > MAX_BYTES) throw new Error('CSV exceeds 5 MiB');
    let columnMapping: unknown = {};
    if (mappingFile) {
      const content = await readFile(mappingFile, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('Mapping exceeds 5 MiB');
      try { columnMapping = JSON.parse(content); }
      catch { throw new Error('Mapping file must contain valid JSON'); }
    }
    const preview = previewCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      source, basename(file), columnMapping);
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
