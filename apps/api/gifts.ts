import { Router } from 'express';
import { z } from 'zod';
import { GiftSchema, GiftWriteSchema, IdSchema, type Gift } from '../../packages/contracts/index.ts';
import { HttpError, type Env } from './env.ts';
import { withMember, type Client, type Database } from './db.ts';
import type { Identity } from './auth.ts';

/** Historical gifts are their own ledger: communications and follow-ups are never stored here. */
const MANUAL = 'manual';
// Bigint columns are selected as text and narrowed below; the schema rejects unsafe numbers.
const FIELDS = `id, org_id, donor_id, campaign_id, amount_cents::text AS amount_cents, refund_cents::text AS refund_cents,
  currency, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
  status, source, external_id, source_row`;
const Query = z.strictObject({
  donor_id: IdSchema.optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(100)).default(50),
  offset: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().nonnegative()).default(0),
});
// Manual entry never supplies provenance or identity: source and source_row are server-assigned.
const { source: _source, source_row: _sourceRow, ...manualFields } = GiftWriteSchema.shape;
const Manual = z.strictObject(manualFields);
const Correct = z.strictObject({
  campaign_id: IdSchema.nullable().optional(), amount_cents: z.int().nonnegative().optional(),
  refund_cents: z.int().nonnegative().optional(), currency: GiftWriteSchema.shape.currency.optional(),
  occurred_at: GiftWriteSchema.shape.occurred_at.optional(), status: GiftWriteSchema.shape.status.optional(),
}).refine(value => Object.keys(value).length > 0);

function valid<T>(result: z.ZodSafeParseResult<T>): T {
  if (!result.success) throw new HttpError(400);
  return result.data;
}
function toGift(row: Record<string, unknown>): Gift {
  const amount = Number(row.amount_cents), refund = Number(row.refund_cents);
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(refund)) throw new HttpError(503);
  return GiftSchema.parse({ ...row, amount_cents: amount, refund_cents: refund });
}

export function gifts(env: Env, db: Database, verify: (header: string | undefined) => Promise<Identity>) {
  const router = Router();
  const scoped = async (client: Client, donor: string) => {
    const rows = await client.query('SELECT id FROM donors WHERE org_id=$1 AND id=$2', [env.CIC_ORG_ID, donor]);
    if (!rows.rows.length) throw new HttpError(404);
  };
  router.get('/', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const query = valid(Query.safeParse(req.query));
    const items = await withMember(db, env.CIC_ORG_ID, identity, async client => {
      if (query.donor_id) await scoped(client, query.donor_id);
      const rows = await client.query(`SELECT ${FIELDS} FROM gifts WHERE org_id=$1 AND ($2::uuid IS NULL OR donor_id=$2)
        ORDER BY occurred_at, id LIMIT $3 OFFSET $4`, [env.CIC_ORG_ID, query.donor_id ?? null, query.limit, query.offset]);
      return rows.rows.map(toGift);
    });
    res.json({ items, limit: query.limit, offset: query.offset });
  });
  router.post('/', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const input = valid(GiftWriteSchema.safeParse({ ...valid(Manual.safeParse(req.body)), source: MANUAL, source_row: null }));
    const outcome = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      await scoped(client, input.donor_id);
      if (input.campaign_id !== null) {
        const campaign = await client.query('SELECT id FROM campaigns WHERE org_id=$1 AND id=$2', [env.CIC_ORG_ID, input.campaign_id]);
        if (!campaign.rows.length) throw new HttpError(400);
      }
      const external = input.external_id ?? null;
      const inserted = await client.query(`INSERT INTO gifts (org_id, donor_id, campaign_id, amount_cents, refund_cents, currency, occurred_at, status, source, external_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,'manual',$9) ON CONFLICT DO NOTHING RETURNING ${FIELDS}`,
      [env.CIC_ORG_ID, input.donor_id, input.campaign_id, input.amount_cents, input.refund_cents, input.currency, input.occurred_at, input.status, external]);
      if (inserted.rows.length) {
        const gift = toGift(inserted.rows[0]);
        await client.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,'gift.insert',$3,'success')",
          [env.CIC_ORG_ID, member.id, gift.id]);
        return { gift, created: true };
      }
      // The unique gifts_source_identity index won the race, or another owner/org holds this identity.
      const existing = await client.query(`SELECT ${FIELDS},
        donor_id=$3 AND campaign_id IS NOT DISTINCT FROM $4::uuid AND amount_cents=$5::bigint
          AND refund_cents=$6::bigint AND currency=$7 AND occurred_at=$8::timestamptz
          AND status=$9 AS same
        FROM gifts WHERE org_id=$1 AND source='manual' AND external_id=$2`, [env.CIC_ORG_ID, external,
        input.donor_id, input.campaign_id, input.amount_cents, input.refund_cents, input.currency, input.occurred_at, input.status]);
      if (!existing.rows.length || existing.rows[0].same !== true) throw new HttpError(409);
      const { same: _same, ...record } = existing.rows[0];
      return { gift: toGift(record), created: false };
    });
    res.status(outcome.created ? 201 : 200).json(outcome.gift);
  });
  router.patch('/:id', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = valid(IdSchema.safeParse(req.params.id));
    const update = valid(Correct.safeParse(req.body));
    const gift = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const current = await client.query(`SELECT ${FIELDS} FROM gifts WHERE org_id=$1 AND id=$2 FOR UPDATE`, [env.CIC_ORG_ID, id]);
      if (!current.rows.length) throw new HttpError(404);
      const existing = toGift(current.rows[0]);
      // Merge over the stored record so identity and provenance can never be rewritten.
      valid(GiftWriteSchema.safeParse({
        donor_id: existing.donor_id, campaign_id: existing.campaign_id, amount_cents: existing.amount_cents,
        refund_cents: existing.refund_cents, currency: existing.currency, occurred_at: existing.occurred_at,
        status: existing.status, source: existing.source, external_id: existing.external_id,
        source_row: existing.source_row, ...update,
      }));
      if (update.campaign_id) {
        const campaign = await client.query('SELECT id FROM campaigns WHERE org_id=$1 AND id=$2', [env.CIC_ORG_ID, update.campaign_id]);
        if (!campaign.rows.length) throw new HttpError(400);
      }
      const entries = Object.entries(update);
      const columns = entries.map(([key], index) => `${key}=$${index + 3}${key === 'occurred_at' ? '::timestamptz' : ''}`).join(', ');
      const rows = await client.query(`UPDATE gifts SET ${columns}, updated_at=now() WHERE org_id=$1 AND id=$2 RETURNING ${FIELDS}`,
        [env.CIC_ORG_ID, id, ...entries.map(([, value]) => value)]);
      const corrected = toGift(rows.rows[0]);
      await client.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,'gift.correct',$3,'success')",
        [env.CIC_ORG_ID, member.id, id]);
      return corrected;
    });
    res.json(gift);
  });
  return router;
}
