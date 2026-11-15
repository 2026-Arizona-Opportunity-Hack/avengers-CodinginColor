import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { add, checkGift, instant, netCents, type RetentionGift, type Window } from './retention.ts';

/** 401: missing, malformed or ambiguous API key. Message is safe to return. */
export class ApiKeyError extends Error {}
/** 400: query outside the allowlisted shape. Message is safe to return. */
export class QueryError extends Error {}

const KEY = /^cic_live_[A-Za-z0-9_-]{43}$/;

/** A new dashboard key. Show `key` once; store only `hash` (and `hint` to tell keys apart). */
export function generateApiKey(): { key: string; hash: string; hint: string } {
  const key = `cic_live_${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashApiKey(key), hint: key.slice(0, 13) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented key against a stored SHA-256 hex hash. */
export function keyMatches(presented: string, storedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashApiKey(presented), 'hex'), Buffer.from(storedHash, 'hex'));
}

/** Read the key from `Authorization: Bearer …` or `X-API-Key`, never both, never anything else. */
export function readApiKey(headers: { authorization?: string; 'x-api-key'?: string }): string {
  const bearer = headers.authorization === undefined ? undefined : /^Bearer (\S+)$/.exec(headers.authorization)?.[1] ?? '';
  const header = headers['x-api-key'];
  if (bearer !== undefined && header !== undefined) throw new ApiKeyError('Send the API key in one header only');
  const key = bearer ?? header;
  if (!key || !KEY.test(key)) throw new ApiKeyError('Missing or malformed API key');
  return key;
}

export const GROUP_BY = ['month', 'program', 'owner'] as const;
export type GroupBy = typeof GROUP_BY[number];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const QuerySchema = z.strictObject({ from: day, to: day, groupBy: z.enum(GROUP_BY).default('month') });
const MAX_RANGE_DAYS = 5 * 366;

/** `from`/`to` are CIC-local days; `to` is exclusive. Unknown parameters are rejected. */
export function parseSummaryQuery(params: Record<string, string | undefined>, offset: string): { window: Window; groupBy: GroupBy } {
  const parsed = QuerySchema.safeParse(params);
  if (!parsed.success) throw new QueryError(parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '));
  const window = { from: `${parsed.data.from}T00:00:00${offset}`, to: `${parsed.data.to}T00:00:00${offset}` };
  let from: bigint, to: bigint;
  try { [from, to] = [instant(window.from), instant(window.to)]; } catch { throw new QueryError('from/to must be real calendar dates'); }
  if (from >= to) throw new QueryError('from must be before to');
  if (to - from > BigInt(MAX_RANGE_DAYS) * 86_400_000_000n) throw new QueryError(`Range is limited to ${MAX_RANGE_DAYS} days`);
  return { window, groupBy: parsed.data.groupBy };
}

/** A gift row from an authorized aggregate query: no donor contact fields. */
export type SummaryGift = RetentionGift & { program_id: string | null; owner_id: string | null; source: string };
type Bucket = { donors: Set<string>; currencies: Map<string, { gifts: number; net_cents: number }> };
export type SummaryGroup = { key: string; suppressed: true }
  | { key: string; suppressed: false; donors: number; currencies: Record<string, { gifts: number; net_cents: number }> };
export type Summary = { groups: SummaryGroup[]; totals: Omit<SummaryGroup, 'key'> };

const offsetMs = (offset: string) => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new QueryError('Invalid offset');
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
};
/** CIC-local calendar date (YYYY-MM-DD) of an instant in microseconds. */
const localDay = (t: bigint, offset: string) => new Date(Number(t / 1000n) + offsetMs(offset)).toISOString().slice(0, 10);

function emptyBucket(): Bucket { return { donors: new Set(), currencies: new Map() }; }
function addTo(b: Bucket, g: SummaryGift) {
  b.donors.add(g.donor_id);
  const c = b.currencies.get(g.currency) ?? b.currencies.set(g.currency, { gifts: 0, net_cents: 0 }).get(g.currency)!;
  c.gifts++;
  c.net_cents = add(c.net_cents, netCents(g));
}
function publish(b: Bucket, minDonors: number) {
  if (b.donors.size < minDonors) return { suppressed: true as const };
  return { suppressed: false as const, donors: b.donors.size, currencies: Object.fromEntries(b.currencies) };
}

/**
 * Aggregate non-void gifts in the window by month (CIC-local), program or owner, per currency.
 * Any group, or the totals, with fewer than `minDonors` distinct donors is returned as `suppressed`.
 */
export function summarize(gifts: readonly SummaryGift[], query: { window: Window; groupBy: GroupBy },
  options: { offset: string; minDonors: number }): Summary {
  const [from, to] = [instant(query.window.from), instant(query.window.to)];
  const groups = new Map<string, Bucket>();
  const totals = emptyBucket();
  for (const g of gifts) {
    checkGift(g);
    const t = instant(g.occurred_at);
    if (t < from || t >= to || g.status === 'void') continue;
    const key = query.groupBy === 'month' ? localDay(t, options.offset).slice(0, 7)
      : query.groupBy === 'program' ? g.program_id ?? 'unattributed' : g.owner_id ?? 'unassigned';
    addTo(groups.get(key) ?? groups.set(key, emptyBucket()).get(key)!, g);
    addTo(totals, g);
  }
  return {
    groups: [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, b]) => ({ key, ...publish(b, options.minDonors) })),
    totals: publish(totals, options.minDonors),
  };
}

export type ActivityItem = { date: string; program: string; source: string; status: 'settled' | 'pending'; currency: string; net_cents: number };

/** Newest non-void gifts as donor-free summaries for the dashboard feed. */
export function recentActivity(gifts: readonly SummaryGift[],
  options: { limit: number; offset: string; programTitles: Record<string, string> }): ActivityItem[] {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new QueryError('limit must be 1-100');
  return gifts
    .map((g) => { checkGift(g); return { g, t: instant(g.occurred_at) }; })
    .filter(({ g }) => g.status !== 'void')
    .sort((a, b) => (a.t > b.t ? -1 : a.t < b.t ? 1 : 0))
    .slice(0, options.limit)
    .map(({ g, t }) => ({
      date: localDay(t, options.offset),
      program: g.program_id === null ? 'Unattributed' : options.programTitles[g.program_id] ?? 'Unknown program',
      source: g.source, status: g.status as 'settled' | 'pending', currency: g.currency, net_cents: netCents(g),
    }));
}
