import express from 'express';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { withMember, type Database } from './db.ts';
import { HttpError, type Env } from './env.ts';
import type { Identity } from './auth.ts';
import { proposeJson } from './ai.ts';
import { interpretQuestion, clarify, donorSearchWindows, searchDonors, type SearchDonor } from '../../packages/reporting/donor-search.ts';
export { interpretQuestion } from '../../packages/reporting/donor-search.ts';
import { RateLimiter } from './rate-limit.ts';
import type { RetentionGift } from '../../packages/reporting/retention.ts';

const Filters = z.strictObject({ scope: z.enum(['visible', 'mine']), currency: z.string().regex(/^[A-Z]{3}$/),
  period: z.enum(['this_year', 'last_year']), segment: z.enum(['new', 'reactivated', 'increased', 'flat', 'decreased', 'lapsed', 'retained']).nullable(),
  minimum_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  status: z.enum(['settled', 'pending', 'void']).nullable() });
type Filter = z.infer<typeof Filters>;
const Body = z.strictObject({ question: z.string().trim().min(1).max(500) });


export function selectFilterAdvice(filters: Filter, advice: unknown): Filter {
  const checked = Filters.safeParse(advice);
  return checked.success && isDeepStrictEqual(checked.data, filters) ? checked.data : filters;
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
      filters = selectFilterAdvice(filters, await model({ purpose: 'Extract the supplied donor-search intent as the same allowlisted filters. Do not add scope, records, SQL, or unmentioned constraints.',
        schema: z.toJSONSchema(Filters), data: filters }));
    } catch { /* Optional advice cannot block the local interpretation. */ }
    const selected = filters;
    const result = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const filters = selected;
      const owner = filters.scope === 'mine' ? member.id : null;
      const donors = (await client.query(`SELECT id,name,owner_id FROM donors
        WHERE org_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR owner_id=$2) ORDER BY name,id LIMIT 2001`, [env.CIC_ORG_ID, owner])).rows as unknown as SearchDonor[];
      if (donors.length > 2000) return { ...clarify, explanation: 'That search is too large. Ask for your own donors or use the donor list filters.' };
      const today = new Date(Date.now() - 7 * 3600_000).toISOString().slice(0, 10);
      const windows = donorSearchWindows(filters, today);
      const gifts = (await client.query(`SELECT donor_id,amount_cents::text,refund_cents::text,currency,status,
        to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at FROM gifts
        WHERE org_id=$1 AND donor_id=ANY($2::uuid[]) AND currency=$3 AND occurred_at<$4::timestamptz LIMIT 50001`,
      [env.CIC_ORG_ID, donors.map(d => d.id), filters.currency, windows.current.to])).rows
        .map(g => ({ ...g, amount_cents: Number(g.amount_cents), refund_cents: Number(g.refund_cents) })) as RetentionGift[];
      return searchDonors(filters, donors, gifts, member.id, today);
    });
    res.json(result);
  });
  return router;
}
