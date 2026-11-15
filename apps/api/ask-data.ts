import express from 'express';
import { z } from 'zod';
import { withMember, type Database } from './db.ts';
import { HttpError, type Env } from './env.ts';
import type { Identity } from './auth.ts';
import { proposeJson } from './ai.ts';
import { RateLimiter } from './rate-limit.ts';
import { retentionReport, ytdWindows, type RetentionGift } from '../../packages/reporting/retention.ts';

const Filters = z.strictObject({ scope: z.enum(['visible', 'mine']), currency: z.string().regex(/^[A-Z]{3}$/),
  period: z.enum(['this_year', 'last_year']), segment: z.enum(['new', 'reactivated', 'increased', 'flat', 'decreased', 'lapsed', 'retained']).nullable(),
  minimum_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  status: z.enum(['settled', 'pending', 'void']).nullable() });
type Filter = z.infer<typeof Filters>;
const Body = z.strictObject({ question: z.string().trim().min(1).max(500) });
const clarify = { needs_clarification: true, explanation: 'Choose a retention segment, gift status, or giving threshold. You can add a currency and this year or last year. Try “show my lapsed donors” or “donors giving over $100 this year in USD”.', donors: [] };
const segments = ['new', 'reactivated', 'increased', 'flat', 'decreased', 'lapsed', 'retained'] as const;

/** An intentionally small grammar. Unrecognized or personal text never becomes a broad query. */
export function interpretQuestion(question: string): Filter | null {
  if (!/\b(?:donors?|supporters?)\b/i.test(question)) return null;
  let text = question.toLowerCase().replace(/[?!.,](?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  const currencies = [...new Set(text.match(/\b(?:usd|eur|gbp|cad|aud|jpy)\b/g) ?? [])];
  const selected = segments.filter(s => new RegExp(`\\b${s}\\b`).test(text));
  const statuses = (['settled', 'pending', 'void'] as const).filter(s => new RegExp(`\\b${s}\\b`).test(text));
  if (currencies.length > 1 || selected.length > 1 || statuses.length > 1 || (/\bthis year\b/.test(text) && /\blast year\b/.test(text))) return null;
  const amounts = [...text.matchAll(/\b(?:over|above|more than)\s*\$?(\d+(?:\.\d{1,2})?)(?![\d.])/g)];
  if (amounts.length > 1) return null;
  let minimum: number | null = null;
  if (amounts[0]) {
    const [whole, fraction = ''] = amounts[0][1].split('.');
    const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    minimum = Number(value); text = text.replace(amounts[0][0], ' ');
  }
  const result: Filter = { scope: /\bmy\b/.test(text) ? 'mine' : 'visible', currency: (currencies[0] ?? 'usd').toUpperCase(),
    period: /\blast year\b/.test(text) ? 'last_year' : 'this_year', segment: selected[0] ?? null,
    status: statuses[0] ?? null, minimum_cents: minimum };
  text = text.replace(/\b(?:this year|last year)\b/g, ' ').replace(/\b(?:show|find|list|me|my|all|visible|authorized|donors|donor|supporters|supporter|who|with|gifts|gift|giving|gave|have|has|are|the|in|and|please|usd|eur|gbp|cad|aud|jpy|new|reactivated|increased|flat|decreased|lapsed|retained|settled|pending|void)\b/g, ' ').trim();
  if (text || (minimum !== null && result.status && result.status !== 'settled')) return null;
  // Currency and period alone do not say which gift activity should qualify a donor.
  if (!result.segment && !result.status && minimum === null &&
    (currencies.length || /\b(?:this year|last year|gifts?|giving|gave)\b/i.test(question))) return null;
  return result;
}

export function askData(env: Env, db: Database, verify: (h: string | undefined) => Promise<Identity>, model = proposeJson) {
  const router = express.Router(), limiter = new RateLimiter({ limit: 20, windowMs: 60_000, maxEntries: 1000 });
  router.post('/', express.json({ limit: '4kb' }), async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const body = Body.safeParse(req.body); if (!body.success) throw new HttpError(400);
    let filters = interpretQuestion(body.data.question);
    await withMember(db, env.CIC_ORG_ID, identity, async (_client, member) => {
      if (!limiter.hit(member.id).ok) throw new HttpError(429);
    });
    if (!filters) { res.json(clarify); return; }
    try {
      // External input contains only recognized nonpersonal intent; never the question or donor facts.
      const checked = Filters.safeParse(await model({ purpose: 'Extract the supplied donor-search intent as the same allowlisted filters. Do not add scope, records, SQL, or unmentioned constraints.',
        schema: z.toJSONSchema(Filters), data: filters }));
      if (checked.success && JSON.stringify(checked.data) === JSON.stringify(filters)) filters = checked.data;
    } catch { /* Optional advice cannot block the local interpretation. */ }
    const selected = filters;
    const result = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const filters = selected;
      const owner = filters.scope === 'mine' ? member.id : null;
      const donors = (await client.query(`SELECT id,name,owner_id FROM donors
        WHERE org_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR owner_id=$2) ORDER BY name,id LIMIT 2001`, [env.CIC_ORG_ID, owner])).rows;
      if (donors.length > 2000) return { ...clarify, explanation: 'That search is too large. Ask for your own donors or use the donor list filters.' };
      const today = new Date(Date.now() - 7 * 3600_000).toISOString().slice(0, 10);
      const asOf = filters.period === 'last_year' ? `${Number(today.slice(0, 4)) - 1}-12-31` : today;
      const windows = ytdWindows(asOf, '-07:00');
      const gifts = (await client.query(`SELECT donor_id,amount_cents::text,refund_cents::text,currency,status,
        to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at FROM gifts
        WHERE org_id=$1 AND donor_id=ANY($2::uuid[]) AND currency=$3 AND occurred_at<$4::timestamptz LIMIT 50001`,
      [env.CIC_ORG_ID, donors.map(d => d.id), filters.currency, windows.current.to])).rows
        .map(g => ({ ...g, amount_cents: Number(g.amount_cents), refund_cents: Number(g.refund_cents) })) as RetentionGift[];
      if (gifts.length > 50000) return { ...clarify, explanation: 'That history is too large for this search. Use the retention report filters.' };
      const report = retentionReport(gifts, windows).byCurrency[filters.currency];
      const facts = new Map((report?.donors ?? []).map(d => [d.donor_id, d]));
      const matches = donors.filter(d => {
        const fact = facts.get(String(d.id));
        if (filters.segment === 'retained' ? !fact || !['increased', 'flat', 'decreased'].includes(fact.segment)
          : filters.segment && fact?.segment !== filters.segment) return false;
        if (filters.minimum_cents !== null && (fact?.current_cents ?? 0) <= filters.minimum_cents) return false;
        return !filters.status || gifts.some(g => g.donor_id === d.id && g.status === filters.status
          && Date.parse(g.occurred_at) >= Date.parse(windows.current.from));
      });
      return { needs_clarification: false, filters, donors: matches.slice(0, 50), total: matches.length,
        explanation: `Active donors ${filters.scope === 'mine' ? 'assigned to you' : 'visible to your account'}${filters.segment ? `, ${filters.segment} giving` : ''}${filters.minimum_cents !== null ? `, net settled giving over ${(filters.minimum_cents / 100).toFixed(2)}` : ''}${filters.status ? `, with ${filters.status} gifts` : ''}. Gift filters use ${filters.currency} for ${filters.period === 'last_year' ? 'last calendar year' : 'this year through today'}. Showing up to 50 matches.` };
    });
    res.json(result);
  });
  return router;
}
