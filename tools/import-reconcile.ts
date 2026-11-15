// Pure planning stage compares canonical drafts with org-scoped snapshots; it never writes.
// Ambiguous donor or gift identity remains for human review instead of being guessed.
import { z } from 'zod';
import { DonorSchema, DonorWriteSchema, GiftSchema, GiftWriteSchema, IdSchema } from '../packages/contracts/index.ts';
import type { DonorWrite, GiftWrite } from '../packages/contracts/index.ts';

type Decision = { row: number; action: 'new' | 'link' | 'insert' | 'duplicate' | 'review';
  reason: string; existingIds: string[]; matchingRows: number[] };

function snapshot<T extends { id: string; org_id: string }>(schema: z.ZodType<T>, values: unknown[], orgId: string) {
  IdSchema.parse(orgId);
  if (!Array.isArray(values)) throw new Error('Existing records must be an array');
  const ids = new Set<string>();
  return values.map(value => {
    const parsed = schema.safeParse(value);
    if (!parsed.success || parsed.data.org_id !== orgId || ids.has(parsed.data.id)) {
      throw new Error('Existing records must be valid, unique and scoped to the selected organization');
    }
    ids.add(parsed.data.id);
    return parsed.data;
  });
}

function index<T>(rows: T[], keys: (row: T) => (string | null)[]) {
  const result = new Map<string, T[]>();
  for (const row of rows) for (const key of keys(row)) {
    if (key !== null) {
      const group = result.get(key);
      if (group) group.push(row);
      else result.set(key, [row]);
    }
  }
  return result;
}

const nameKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const emailKey = (value?: string | null) => value ? `email:${value.trim().toLowerCase()}` : null;
const phoneKey = (value?: string | null) => value && /^\+?[\d().\s-]+$/.test(value)
  ? `phone:${value.replace(/[().\s-]/g, '')}` : null;
const donorKeys = (donor: DonorWrite) => [emailKey(donor.email), phoneKey(donor.phone), `name:${nameKey(donor.name)}`];

/** Plan donor create/link/review outcomes; only a unique corroborated email can link. */
export function planDonorMatches(orgId: string, drafts: unknown[], existing: unknown[]) {
  const donors = snapshot(DonorSchema, existing, orgId);
  if (!Array.isArray(drafts)) throw new Error('Drafts must be an array');
  const parsed = drafts.map(draft => DonorWriteSchema.safeParse(draft));
  const valid = parsed.flatMap((result, row) => result.success ? [{ ...result.data, row }] : []);
  const stored = index(donors, donorKeys), incoming = index(valid, donorKeys);
  const rows = parsed.map((result, row): Decision => {
    if (!result.success) return { row, action: 'review', reason: 'invalid_donor', existingIds: [], matchingRows: [] };
    const donor = result.data, keys = donorKeys(donor), email = emailKey(donor.email);
    const candidates = [...new Set(keys.flatMap(key => key === null ? [] : stored.get(key) ?? []))];
    const peers = [...new Set(keys.flatMap(key => key === null ? [] : incoming.get(key) ?? []))]
      .filter(peer => peer.row !== row);
    const existingIds = candidates.map(candidate => candidate.id), matchingRows = peers.map(peer => peer.row);
    const emailMatches = email === null ? [] : stored.get(email) ?? [];
    const match = emailMatches.length === 1 ? emailMatches[0] : undefined;
    const agrees = (other: DonorWrite) => nameKey(donor.name) === nameKey(other.name) &&
      (!phoneKey(donor.phone) || !phoneKey(other.phone) || phoneKey(donor.phone) === phoneKey(other.phone));
    if (match && !match.archived_at && agrees(match) && peers.every(agrees) &&
        candidates.every(candidate => candidate.id === match.id)) {
      return { row, action: 'link', reason: 'unique_corroborated_email', existingIds: [match.id], matchingRows };
    }
    // Phone verification is absent from the shared contract, so phone-only matches stay in review.
    const review = candidates.length > 0 || peers.length > 0 || (!email && !phoneKey(donor.phone));
    return { row, action: review ? 'review' : 'new', reason: review ? 'identity_needs_review' : 'no_match',
      existingIds, matchingRows };
  });
  return { status: 'needs_review' as const, rows };
}

// Transaction and provenance identities are independent; either can match a stored gift.
const externalKey = (gift: GiftWrite) => gift.external_id
  ? JSON.stringify(['external', gift.source, gift.external_id]) : null;
const rowKey = (gift: GiftWrite) => gift.source_row
  ? JSON.stringify(['row', gift.source, gift.source_row.batch_id, gift.source_row.row_key]) : null;
// A gift has up to two identities: source + external transaction ID, and source + batch/row
// provenance (the fallback when an export has no transaction ID).
const giftKeys = (gift: GiftWrite) => [externalKey(gift), rowKey(gift)];

// The shared contract allows more fractional digits than Date preserves. Date.parse keeps only
// milliseconds, so the extra digits are compared separately; otherwise two gifts 0.0001s apart
// would look like the same gift.
const instant = (value: string) => [Date.parse(value),
  (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? '').slice(3).replace(/0+$/, '')];
const similarGift = (gift: GiftWrite) => JSON.stringify([
  gift.donor_id, gift.amount_cents, gift.currency, instant(gift.occurred_at),
]);
const giftFacts = (gift: GiftWrite) => JSON.stringify([
  gift.donor_id, gift.campaign_id, gift.amount_cents, gift.refund_cents,
  gift.currency, instant(gift.occurred_at), gift.status,
]);

/** Plan gift insert/duplicate/review outcomes using transaction and provenance identities. */
export function planGiftChanges(orgId: string, drafts: unknown[], existing: unknown[]) {
  const gifts = snapshot(GiftSchema, existing, orgId);
  if (!Array.isArray(drafts)) throw new Error('Drafts must be an array');
  const parsed = drafts.map(draft => GiftWriteSchema.safeParse(draft));
  const valid = parsed.flatMap((result, row) => result.success ? [{ ...result.data, row }] : []);
  const stored = index(gifts, giftKeys), incoming = index(valid, giftKeys);
  const storedSimilar = index(gifts, gift => [similarGift(gift)]), incomingSimilar = index(valid, gift => [similarGift(gift)]);
  if ([...stored.values()].some(group => group.length > 1)) throw new Error('Existing gift identities are not unique');
  const rows = parsed.map((result, row): Decision => {
    if (!result.success) return { row, action: 'review', reason: 'invalid_gift', existingIds: [], matchingRows: [] };
    const gift = result.data, keys = giftKeys(gift);
    // Match on either identity, so one can never mask the other.
    const candidates = (key: string | null) => key === null ? [] : stored.get(key) ?? [];
    const matches = [...new Set(keys.flatMap(candidates))];
    const peers = [...new Set(keys.flatMap(key => key === null ? [] : incoming.get(key) ?? []))]
      .filter(peer => peer.row !== row);
    const existingIds = matches.map(match => match.id), matchingRows = peers.map(peer => peer.row);
    if (peers.some(peer => giftFacts(peer) !== giftFacts(gift) || peer.external_id !== gift.external_id)) {
      return { row, action: 'review', reason: 'conflicting_batch_transaction', existingIds, matchingRows };
    }
    if (matches.length) {
      if (matches.some(match => giftFacts(match) !== giftFacts(gift))) {
        return { row, action: 'review', reason: 'changed_transaction', existingIds, matchingRows };
      }
      // Two identities naming one stored gift must also agree on its external ID.
      const targets = keys.map(key => candidates(key)[0]?.id ?? null);
      const conflict = (targets[0] !== null && targets[1] !== null && targets[0] !== targets[1]) ||
        matches.some(match => gift.external_id && match.external_id !== gift.external_id);
      return { row, action: conflict ? 'review' : 'duplicate',
        reason: conflict ? 'conflicting_identity' : 'exact_replay', existingIds, matchingRows };
    }
    const possible = storedSimilar.get(similarGift(gift)) ?? [];
    const possibleRows = (incomingSimilar.get(similarGift(gift)) ?? []).filter(peer => peer.row !== row);
    const identity = keys.every(key => key === null);
    if (identity || possible.some(other => other.source !== gift.source) ||
        possibleRows.some(other => other.source !== gift.source)) {
      return { row, action: 'review', reason: identity ? 'missing_transaction_identity' : 'cross_source_candidate',
        existingIds: possible.map(other => other.id), matchingRows: possibleRows.map(other => other.row) };
    }
    // Row provenance is batch-scoped, so a re-exported file would otherwise insert every no-ID gift again.
    if (!gift.external_id && possible.length) {
      return { row, action: 'review', reason: 'possible_file_replay', existingIds: possible.map(other => other.id), matchingRows };
    }
    const previous = peers.find(peer => peer.row < row);
    return { row, action: previous ? 'duplicate' : 'insert',
      reason: previous ? 'repeated_batch_transaction' : 'new_transaction', existingIds, matchingRows };
  });
  return { status: 'needs_review' as const, rows };
}
