// Preview parses CSV into mapped row values and review issues; it performs no writes.
// Missing or invalid gift facts (amount, date, currency) become review issues; nothing is guessed.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { GiftWriteSchema } from '../packages/contracts/index.ts';

const aliases = new Map([
  ['first name', 'first_name'], ['last name', 'last_name'],
  ['email', 'email'], ['email address', 'email'],
  ['phone', 'phone'], ['phone number', 'phone'], ['company', 'company'], ['company name', 'company'],
  ['donation amount', 'amount_cents'], ['amount', 'amount_cents'], ['contact person', 'contact_person'],
  ['campaign', 'campaign'], ['amount cents', 'amount_cents'],
  ['occurred at', 'occurred_at'], ['currency', 'currency'], ['external id', 'external_id'],
  ['donor first', 'first_name'], ['donor last', 'last_name'],
  ['donor email address', 'email'], ['mobile #', 'phone'], ['employer name', 'company'],
  ['gift amt', 'amount_cents'], ['board contact', 'contact_person'],
  ['designation', 'campaign'], ['donation date', 'occurred_at'],
  ['status', 'status'], ['payment status', 'status'],
  ['refund amount', 'refund_cents'], ['refunded amount', 'refund_cents'], ['refund cents', 'refund_cents'],
]);
const mappingTargets = new Set([...aliases.values(), 'amount_decimal', 'refund_decimal']);
const sources = ['spreadsheet', 'zeffy', 'benevity', 'az_gives', 'united_way'];
const MAX_BYTES = 5 * 1024 * 1024;
const dateFormats = {
  'MM/DD/YYYY': /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  'MM/DD/YYYY, h:mm A': /^(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2}) (AM|PM)$/,
  'DD/MM/YYYY': /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  'YYYY-MM-DD': /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
};
type DateOptions = { format: string; offset: string };
type Issue = { recordNumber: number | null; field: string; code: string };

/** Parse bounded CSV while preserving records and rejecting malformed quoting. */
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

/** Convert decimal major units to safe integer cents without floating-point arithmetic. */
export function parseAmountCents(value: string): number | null {
  const text = value.trim();
  if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.replace(/^\$/, '').replaceAll(',', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function checkDateOptions(options: unknown): DateOptions | null {
  if (options === undefined) return null;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Date options must be an object');
  }
  const { date_format: format, utc_offset: offset, ...rest } = options as Record<string, unknown>;
  if (Object.keys(rest).length) throw new Error('Unknown date option');
  const zone = typeof offset === 'string' ? /^([+-])(\d{2}):(\d{2})$/.exec(offset) : null;
  if (typeof format !== 'string' || !Object.hasOwn(dateFormats, format) || !zone ||
      Number(zone[2]) > 14 || Number(zone[3]) > 59 || (Number(zone[2]) === 14 && Number(zone[3]))) {
    throw new Error('date_format and utc_offset must be a supported pair within ±14:00');
  }
  return { format, offset: offset as string };
}

function confirmedDate(value: string, { format, offset }: DateOptions): string | null {
  const match = dateFormats[format as keyof typeof dateFormats].exec(value);
  if (!match) return null;
  const [year, month, day] = format === 'YYYY-MM-DD' ? [match[1], match[2], match[3]]
    : format.startsWith('MM/DD/YYYY') ? [match[3], match[1], match[2]] : [match[3], match[2], match[1]];
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // Date rolls impossible days over, so a changed day means it was never a calendar date.
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 ||
      date.getUTCDate() !== Number(day)) return null;
  let time = '00:00';
  if (format === 'MM/DD/YYYY, h:mm A') {
    const hour = Number(match[4]), minute = Number(match[5]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    time = `${String(hour % 12 + (match[6] === 'PM' ? 12 : 0)).padStart(2, '0')}:${match[5]}`;
  }
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${time}:00${offset}`;
}

/** Validate mapped CSV facts and return raw rows plus normalized values and review issues. */
export function previewCsv(text: string, source: string, file: string, columnMapping: unknown = {},
  options?: unknown) {
  if (!sources.includes(source)) throw new Error(`Source must be one of ${sources.join(', ')}`);
  const dateOptions = checkDateOptions(options);
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
    return target === 'amount_decimal' ? 'amount_cents' : target === 'refund_decimal' ? 'refund_cents' : target ?? null;
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
    // Header is record 1, so source-row provenance uses the CSV record number starting at 2.
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
      // Explicit cents mappings are integers already; decimal mappings are major currency units.
      if (field === 'amount_cents' || field === 'refund_cents') {
        const alreadyCents = chosen.has(headers[i])
          ? chosen.get(headers[i]) === field : normalized[i] === field.replace('_', ' ');
        if (alreadyCents) {
          const cents = /^\d+$/.test(value) ? Number(value) : NaN;
          values[field] = GiftWriteSchema.shape[field].safeParse(cents).success ? cents : null;
        } else values[field] = parseAmountCents(value);
        if (values[field] === null) issue(field, value ? `invalid_${field === 'amount_cents' ? 'amount' : 'refund'}` : `missing_${field === 'amount_cents' ? 'amount' : 'refund'}`);
        else if (field === 'amount_cents' && values[field] === 0) issue(field, 'non_positive_amount');
      }
      if (field === 'occurred_at' || field === 'currency' || field === 'external_id' || field === 'status') {
        const input = field === 'currency' ? value.toUpperCase()
          : field === 'status' ? value.toLowerCase()
          : field === 'occurred_at' && dateOptions
            ? confirmedDate(value, dateOptions) ?? (value || null) : value || null;
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
    if (typeof values.refund_cents === 'number' && typeof values.amount_cents === 'number' && values.refund_cents > values.amount_cents)
      issue('refund_cents', 'refund_exceeds_amount');
    if (!values.first_name && !values.last_name && !values.company) issue('name', 'missing_donor_name');
    if (!values.email && !values.phone) issue('contact', 'missing_contact');
    return { recordNumber, raw, values };
  });
  return { source, file, status: 'needs_review' as const, headers, mapping, rows, issues };
}

if (import.meta.main) {
  try {
    const [source, file, ...rest] = process.argv.slice(2);
    if (!source || !file || !file.toLowerCase().endsWith('.csv')) {
      throw new Error(`Usage: node tools/import-preview.ts <${sources.join('|')}> <file.csv> ` +
        '[mapping.json] [--date-format MM/DD/YYYY --utc-offset ±HH:MM]');
    }
    let mappingFile: string | undefined;
    const flags = new Map<string, string>();
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--date-format' || arg === '--utc-offset') {
        if (flags.has(arg) || i + 1 >= rest.length) throw new Error(`Missing or repeated value for ${arg}`);
        flags.set(arg, rest[++i]);
      } else if (arg.startsWith('--') || mappingFile) {
        // Unexpected values may be private paths or contacts; never echo them.
        throw new Error('Unexpected argument; see usage');
      } else mappingFile = arg;
    }
    if (mappingFile && !mappingFile.toLowerCase().endsWith('.json')) {
      throw new Error('Mapping file must be a .json file');
    }
    if (flags.size && flags.size !== 2) {
      throw new Error('Both --date-format and --utc-offset are required together');
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
    const dateOptions = flags.size ? { date_format: flags.get('--date-format')!,
      utc_offset: flags.get('--utc-offset')! } : undefined;
    const preview = previewCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      source, basename(file), columnMapping, dateOptions);
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
