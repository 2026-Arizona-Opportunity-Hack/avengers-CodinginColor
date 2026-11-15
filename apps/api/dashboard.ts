import express from 'express';
import { z } from 'zod';
import {
  ApiKeyError, QueryError, hashApiKey, parseSummaryQuery, readApiKey, recentActivity, summarize, type SummaryGift,
} from '../../packages/reporting/summary.ts';
import { HttpError } from './env.ts';
import type { Client, Database } from './db.ts';
import { RateLimiter } from './rate-limit.ts';
import { checkGift, netCents } from '../../packages/reporting/retention.ts';

export type DashboardOptions = {
  /** CIC reports in Phoenix time: '-07:00'. */
  offset: string;
  /** Groups (and totals) with fewer distinct donors are returned without numbers. */
  minDonors: number;
  /** Requests per key per minute. */
  limitPerMinute: number;
  now?: () => number;
  /** Injectable for tests; defaults to a bounded per-key limiter. */
  limiter?: RateLimiter;
};

// Bigint amounts are read as text and checked by summarize()/recentActivity().
const ROW = `donor_id, program_id, owner_id, amount_cents::text AS amount_cents, refund_cents::text AS refund_cents,
  currency, status, source, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at`;
const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
const toGift = (r: Record<string, unknown>): SummaryGift => ({
  donor_id: String(r.donor_id), program_id: text(r.program_id), owner_id: text(r.owner_id),
  amount_cents: Number(r.amount_cents), refund_cents: Number(r.refund_cents), currency: String(r.currency),
  status: r.status as SummaryGift['status'], source: String(r.source), occurred_at: String(r.occurred_at),
});
const ActivityQuery = z.strictObject({
  limit: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.int().min(1).max(100)).default(20),
});

/** Runtime role with no member context: the key-checking definer functions are its only route to data. */
async function asRuntime<T>(db: Database, action: (client: Client) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let destroy = false;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE cic_runtime');
    const value = await action(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroy = true; }
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new HttpError(401);   // Invalid API key
    if (code === '22023') throw new HttpError(400);   // window or limit out of range
    throw error;
  } finally { client.release(destroy); }
}

/**
 * Key-authenticated dashboard routes for CIC's org dashboard (no Clerk session).
 * Only suppressed aggregates and donor-free activity leave the server.
 */
export function createDashboardRouter(db: Database, options: DashboardOptions) {
  const router = express.Router();
  const limiter = options.limiter ?? new RateLimiter({ limit: options.limitPerMinute, windowMs: 60_000,
    maxEntries: 1000, now: options.now });

  const authenticate = (req: express.Request, res: express.Response) => {
    res.set('Cache-Control', 'no-store');
    const headers: { authorization?: string; 'x-api-key'?: string } = {};
    const authorization = req.get('Authorization'), apiKey = req.get('X-API-Key');
    if (authorization !== undefined) headers.authorization = authorization;
    if (apiKey !== undefined) headers['x-api-key'] = apiKey;
    try { return hashApiKey(readApiKey(headers)); } catch (error) {
      throw error instanceof ApiKeyError ? new HttpError(401) : error;
    }
  };
  const rateLimit = (hash: string, res: express.Response) => {
    const result = limiter.hit(hash);
    if (!result.ok) {
      res.set('Retry-After', String(result.retryAfterSeconds));
      throw new HttpError(429);
    }
  };
  /** Run a key-scoped query; an unknown or revoked key leaves no limiter state behind. */
  const forKey = async <T>(hash: string, action: (client: Client) => Promise<T>) => {
    try { return await asRuntime(db, action); } catch (error) {
      if (error instanceof HttpError && error.status === 401) limiter.forget(hash);
      throw error;
    }
  };

  router.get('/api/v1/summary', async (req, res) => {
    const hash = authenticate(req, res);
    let query;
    try { query = parseSummaryQuery(req.query as Record<string, string>, options.offset); } catch (error) {
      throw error instanceof QueryError ? new HttpError(400) : error;
    }
    rateLimit(hash, res);
    const current = query.window;
    const previousYear = (value: string) => {
      const year = Number(value.slice(0, 4)) - 1;
      if (year < 1) throw new HttpError(400);
      const date = value.slice(5, 10) === '02-29' && new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1
        ? '02-28' : value.slice(5, 10);
      return `${String(year).padStart(4, '0')}-${date}${value.slice(10)}`;
    };
    const lastDay = new Date(`${current.to.slice(0, 10)}T00:00:00Z`);
    lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    const priorLastDay = previousYear(lastDay.toISOString().slice(0, 10) + current.to.slice(10));
    const priorEnd = new Date(`${priorLastDay.slice(0, 10)}T00:00:00Z`);
    priorEnd.setUTCDate(priorEnd.getUTCDate() + 1);
    const prior = { from: previousYear(current.from), to: priorEnd.toISOString().slice(0, 10) + current.to.slice(10) };
    const { gifts, priorGifts, titles } = await forKey(hash, async (client) => ({
      gifts: (await client.query(`SELECT ${ROW} FROM cic_reporting_gifts($1, $2, $3)`,
        [hash, query.window.from, query.window.to])).rows.map(toGift),
      priorGifts: (await client.query(`SELECT ${ROW} FROM cic_reporting_gifts($1, $2, $3)`,
        [hash, prior.from, prior.to])).rows.map(toGift),
      titles: new Map((await client.query('SELECT id, title FROM cic_reporting_programs($1)', [hash])).rows
        .map((r) => [String(r.id), String(r.title)])),
    }));
    const summary = summarize(gifts, query, { offset: options.offset, minDonors: options.minDonors });
    const windows = { current, prior };
    for (const gift of priorGifts) checkGift(gift);
    const currencies = new Set([...priorGifts, ...gifts].filter(g => netCents(g) > 0).map(g => g.currency));
    const byCurrency = Object.fromEntries([...currencies].map(currency => {
      const priorDonors = new Set(priorGifts.filter(g => g.currency === currency && netCents(g) > 0).map(g => g.donor_id));
      const currentDonors = new Set(gifts.filter(g => g.currency === currency && netCents(g) > 0).map(g => g.donor_id));
      const retained = [...priorDonors].filter(id => currentDonors.has(id)).length;
      const lapsed = priorDonors.size - retained;
      const currentOnly = currentDonors.size - retained;
      const small = (n: number) => n > 0 && n < options.minDonors;
      return [currency, priorDonors.size < options.minDonors || small(retained) || small(lapsed) || small(currentOnly)
        ? { suppressed: true } : { suppressed: false, retained_donors: retained, prior_donors: priorDonors.size }];
    }));
    const label = (key: string) => query.groupBy === 'program'
      ? (key === 'unattributed' ? 'Unattributed' : titles.get(key) ?? 'Unknown program')
      : query.groupBy === 'owner' && key === 'unassigned' ? 'Unassigned' : key;
    res.json({
      window: query.window, groupBy: query.groupBy, totals: summary.totals,
      retention: { windows, byCurrency },
      groups: summary.groups.map(({ key, ...rest }) => ({ key, label: label(key), ...rest })),
    });
  });

  router.get('/api/v1/activity', async (req, res) => {
    const hash = authenticate(req, res);
    const parsed = ActivityQuery.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400);
    rateLimit(hash, res);
    const { rows, titles } = await forKey(hash, async (client) => ({
      rows: (await client.query(`SELECT ${ROW} FROM cic_reporting_recent($1, $2)`, [hash, parsed.data.limit])).rows.map(toGift),
      titles: Object.fromEntries((await client.query('SELECT id, title FROM cic_reporting_programs($1)', [hash])).rows
        .map((r) => [String(r.id), String(r.title)])),
    }));
    res.json({ items: recentActivity(rows, { limit: parsed.data.limit, offset: options.offset, programTitles: titles }) });
  });

  return router;
}
