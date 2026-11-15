import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { GiftWriteSchema, IdSchema } from '../packages/contracts/index.ts';
import type { DonorWrite, GiftWrite } from '../packages/contracts/index.ts';
import { previewCsv } from './import-preview.ts';
import { previewXlsx } from './import-xlsx.ts';
import { createReviewPlan, fingerprintFile, resolveReview } from './import-review.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const FIELDS = ['refund_cents', 'currency', 'occurred_at', 'status'] as const;
type Field = typeof FIELDS[number];
type GiftDraft = { donor_row: number; campaign_id: string | null; amount_cents: number;
  refund_cents?: number; currency?: string; occurred_at?: string; status?: GiftWrite['status'];
  source: string; external_id: string | null; source_row: { batch_id: string; row_key: string } };
type Drafts = { status: 'needs_review'; donors: DonorWrite[]; gifts: GiftDraft[];
  rows: { recordNumber: number; donor_row: number; gift_row: number }[];
  excluded: { recordNumber: number; codes: string[] }[];
  unresolved: { field: string; code: string }[] };

export function buildImportDrafts(preview: ReturnType<typeof previewCsv>,
  { batch_id, values = {}, aliases }: { batch_id: string; values?: Record<string, unknown>;
    aliases?: { campaign: Record<string, string | null>; contact_person: Record<string, string | null> } }): Drafts {
  if (preview.status !== 'needs_review') throw new Error('Preview must need review');
  IdSchema.parse(batch_id);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Batch values must be an object');
  for (const [field, value] of Object.entries(values)) {
    if (!FIELDS.includes(field as Field)) throw new Error(`Unsupported batch value ${field}`);
    if (!GiftWriteSchema.shape[field as Field].safeParse(value).success) throw new Error(`Invalid batch value ${field}`);
    // A mapped field is the sheet's fact; a reviewer value would silently override it.
    if (preview.mapping.includes(field)) throw new Error(`${field} is already mapped`);
  }
  const codes = new Map<number, Set<string>>();
  for (const issue of preview.issues) {
    if (issue.recordNumber === null) continue;
    const { recordNumber, code } = issue;
    codes.set(recordNumber, new Set([...(codes.get(recordNumber) ?? []), code]));
  }
  const donors: DonorWrite[] = [], gifts: GiftDraft[] = [], rows: Drafts['rows'] = [];
  const excluded: Drafts['excluded'] = [], donorRows = new Map<string, number>();
  for (const row of preview.rows) {
    const found = codes.get(row.recordNumber);
    if (found) { excluded.push({ recordNumber: row.recordNumber, codes: [...found].sort() }); continue; }
    const v = row.values;
    if (aliases) {
      const missing = (['campaign', 'contact_person'] as const).filter(field => v[field] && !Object.hasOwn(aliases[field], String(v[field])));
      if (missing.length) { excluded.push({ recordNumber: row.recordNumber, codes: missing.map(f => `unresolved_${f}_alias`) }); continue; }
    }
    const email = (v.email as string | null) ?? null;
    const company = (v.company as string | null) ?? null;
    const donor: DonorWrite = { name: [v.first_name, v.last_name].filter(Boolean).join(' ') || company || '',
      email, phone: (v.phone as string | null) ?? null, consent: 'unknown',
      metadata: { ...(company ? { company } : {}),
        ...(aliases && v.contact_person ? { import_contact_person: String(v.contact_person),
          import_owner_id: aliases.contact_person[String(v.contact_person)] ?? null } : {}) } };
    // Only a corroborated email makes two identical drafts the same donor.
    const key = email === null ? null : JSON.stringify(donor);
    const known = key === null ? undefined : donorRows.get(key);
    const donorRow = known ?? donors.length;
    if (known === undefined) { donors.push(donor); if (key !== null) donorRows.set(key, donorRow); }
    const facts: Partial<Pick<GiftDraft, Field>> = {};
    for (const field of FIELDS) {
      const value = v[field] ?? values[field];
      if (value !== undefined) Object.assign(facts, { [field]: value });
    }
    gifts.push({ donor_row: donorRow, campaign_id: aliases && v.campaign ? aliases.campaign[String(v.campaign)] ?? null : null, amount_cents: v.amount_cents as number, ...facts,
      source: preview.source, external_id: (v.external_id as string | null) ?? null,
      source_row: { batch_id, row_key: String(row.recordNumber) } });
    rows.push({ recordNumber: row.recordNumber, donor_row: donorRow, gift_row: gifts.length - 1 });
  }
  const supplied = new Set(Object.keys(values));
  const unresolved = preview.issues.filter(issue => issue.recordNumber === null &&
    !(issue.code === 'unresolved_gift_metadata' && supplied.has(issue.field)))
    .map(issue => ({ field: issue.field, code: issue.code }));
  for (const field of ['status', 'refund_cents']) {
    if (!supplied.has(field) && !preview.mapping.includes(field)) unresolved.push({ field, code: 'unresolved_gift_metadata' });
  }
  return { status: 'needs_review', donors, gifts, rows, excluded, unresolved };
}

const counts = (items: string[]) => items.reduce<Record<string, number>>(
  (out, item) => ({ ...out, [item]: (out[item] ?? 0) + 1 }), {});

if (import.meta.main) {
  try {
    const [source, file, ...extra] = process.argv.slice(2);
    if (!source || !file || !/\.(csv|xlsx)$/i.test(file)) throw new Error(
      'Usage: node tools/import-drafts.ts <spreadsheet|zeffy|benevity|az_gives|united_way> ' +
      '<file.csv|file.xlsx> [--mapping mapping.json] [--currency USD --status settled --refund-cents 0 ' +
      '--occurred-at 2026-11-14T00:00:00-07:00] [--date-format MM/DD/YYYY --utc-offset ±HH:MM]');
    const flags = new Map([['--currency', 'currency'], ['--status', 'status'],
      ['--refund-cents', 'refund_cents'], ['--occurred-at', 'occurred_at']]);
    const values: Record<string, unknown> = {};
    const dates = new Map<string, string>();
    let mappingFile: string | undefined;
    for (let i = 0; i < extra.length; i += 2) {
      const option = extra[i], dateFlag = option === '--date-format' || option === '--utc-offset';
      const field = flags.get(option);
      if (!field && !dateFlag && option !== '--mapping') throw new Error('Unknown option');
      if (extra[i + 1] === undefined) throw new Error(`Missing value for ${option}`);
      if (option === '--mapping') {
        if (mappingFile) throw new Error('Duplicate mapping option');
        mappingFile = extra[i + 1];
      } else if (dateFlag) {
        if (dates.has(option)) throw new Error(`Duplicate option ${option}`);
        dates.set(option, extra[i + 1]);
      } else {
        if (field! in values) throw new Error(`Duplicate option ${option}`);
        values[field!] = extra[i + 1];
      }
    }
    if (dates.size === 1) throw new Error('Both --date-format and --utc-offset are required together');
    const dateOptions = dates.size ? { date_format: dates.get('--date-format')!,
      utc_offset: dates.get('--utc-offset')! } : undefined;
    const refund = values.refund_cents as string | undefined;
    if (refund !== undefined && !/^\d+$/.test(refund)) throw new Error('Refund cents must be a nonnegative integer');
    if (refund !== undefined) values.refund_cents = Number(refund);
    const bytes = await readFile(file);
    if (bytes.length > MAX_BYTES) throw new Error('Import exceeds 5 MiB');
    let mapping: unknown = {};
    if (mappingFile) {
      const content = await readFile(mappingFile, 'utf8');
      if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Mapping exceeds 5 MiB');
      try { mapping = JSON.parse(content); } catch { throw new Error('Mapping file must contain valid JSON'); }
    }
    const preview = file.toLowerCase().endsWith('.xlsx')
      ? await previewXlsx(bytes, source, basename(file), mapping, dateOptions)
      : previewCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes), source,
        basename(file), mapping, dateOptions);
    const batch_id = randomUUID();
    const drafts = buildImportDrafts(preview, { batch_id, values });
    const base = { org_id: '00000000-0000-4000-8000-000000000000', batch_id,
      file_sha256: fingerprintFile(bytes), existing_donors: [], existing_gifts: [] };
    const donorReview = createReviewPlan({ ...base, donors: drafts.donors, gifts: [] });
    const resolution = resolveReview(donorReview, []);
    const giftPlan = resolution.status === 'ready'
      ? counts(createReviewPlan({ ...base, donors: [], gifts: drafts.gifts, donor_resolution: resolution })
        .gifts.rows.map(row => row.reason))
      : null;
    console.log(JSON.stringify({ source, rowCount: preview.rows.length, donorDrafts: drafts.donors.length,
      giftDrafts: drafts.gifts.length, excludedRows: drafts.excluded.length,
      excludedCodes: counts(drafts.excluded.flatMap(row => row.codes)),
      unresolved: [...new Set(drafts.unresolved.map(issue => issue.code))].sort(),
      donorPlan: counts(donorReview.donors.rows.map(row => row.action)), giftPlan }, null, 2));
  } catch (error) {
    // Filesystem errors may contain private paths; only validation messages are safe to display.
    console.error(error instanceof Error && !('code' in error) ? error.message : 'Unable to read CSV file');
    process.exitCode = 1;
  }
}
