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

function giftKey(gift: GiftWrite) {
  if (gift.external_id) return JSON.stringify(['external', gift.source, gift.external_id]);
  if (gift.source_row) return JSON.stringify(['row', gift.source, gift.source_row.batch_id, gift.source_row.row_key]);
  return null;
}

// The shared contract allows more fractional digits than Date preserves.
const instant = (value: string) => [Date.parse(value),
  (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? '').slice(3).replace(/0+$/, '')];
const similarGift = (gift: GiftWrite) => JSON.stringify([
  gift.donor_id, gift.amount_cents, gift.currency, instant(gift.occurred_at),
]);
const giftFacts = (gift: GiftWrite) => JSON.stringify([
  gift.donor_id, gift.campaign_id, gift.amount_cents, gift.refund_cents,
  gift.currency, instant(gift.occurred_at), gift.status,
]);

export function planGiftChanges(orgId: string, drafts: unknown[], existing: unknown[]) {
  const gifts = snapshot(GiftSchema, existing, orgId);
  if (!Array.isArray(drafts)) throw new Error('Drafts must be an array');
  const parsed = drafts.map(draft => GiftWriteSchema.safeParse(draft));
  const valid = parsed.flatMap((result, row) => result.success ? [{ ...result.data, row }] : []);
  const stored = index(gifts, gift => [giftKey(gift)]), incoming = index(valid, gift => [giftKey(gift)]);
  const storedSimilar = index(gifts, gift => [similarGift(gift)]), incomingSimilar = index(valid, gift => [similarGift(gift)]);
  if ([...stored.values()].some(group => group.length > 1)) throw new Error('Existing gift identities are not unique');
  const rows = parsed.map((result, row): Decision => {
    if (!result.success) return { row, action: 'review', reason: 'invalid_gift', existingIds: [], matchingRows: [] };
    const gift = result.data, key = giftKey(gift);
    const matches = key === null ? [] : stored.get(key) ?? [];
    const peers = key === null ? [] : incoming.get(key) ?? [];
    const existingIds = matches.map(match => match.id), matchingRows = peers.filter(peer => peer.row !== row).map(peer => peer.row);
    if (peers.some(peer => giftFacts(peer) !== giftFacts(gift))) {
      return { row, action: 'review', reason: 'conflicting_batch_transaction', existingIds, matchingRows };
    }
    if (matches.length) {
      const replay = giftFacts(matches[0]) === giftFacts(gift);
      return { row, action: replay ? 'duplicate' : 'review',
        reason: replay ? 'exact_replay' : 'changed_transaction', existingIds, matchingRows };
    }
    const possible = storedSimilar.get(similarGift(gift)) ?? [];
    const possibleRows = (incomingSimilar.get(similarGift(gift)) ?? []).filter(peer => peer.row !== row);
    if (key === null || possible.some(other => other.source !== gift.source) ||
        possibleRows.some(other => other.source !== gift.source)) {
      return { row, action: 'review', reason: key === null ? 'missing_transaction_identity' : 'cross_source_candidate',
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
