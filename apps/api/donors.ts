import { Router } from 'express';
import { z } from 'zod';
import { DonorSchema, DonorWriteSchema, IdSchema } from '../../packages/contracts/index.ts';
import { HttpError, type Env } from './env.ts';
import { withMember, type Database } from './db.ts';
import type { Identity } from './auth.ts';

const Query = z.strictObject({
  q: z.string().max(300).optional(), owner_id: IdSchema.optional(),
  archived: z.enum(['true','false']).default('false'),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(100)).default(25),
  offset: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().nonnegative()).default(0),
});
const fields = "id, org_id, owner_id, name, email, phone, consent, metadata, to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS archived_at";
const Update = DonorWriteSchema.partial().refine(value => Object.keys(value).length > 0);
function valid<T>(result: z.ZodSafeParseResult<T>): T {
  if (!result.success) throw new HttpError(400);
  return result.data;
}

export function donors(env: Env, db: Database, verify: (header: string | undefined) => Promise<Identity>) {
  const router = Router();
  router.get('/', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const query = valid(Query.safeParse(req.query));
    const items = await withMember(db, env.CIC_ORG_ID, identity, async client => {
      const rows = await client.query(`SELECT ${fields} FROM donors WHERE org_id=$1
        AND (archived_at IS NOT NULL)=$2 AND ($3::uuid IS NULL OR owner_id=$3)
        AND ($4::text IS NULL OR position(lower($4) in lower(name)) > 0)
        ORDER BY name,id LIMIT $5 OFFSET $6`,
      [env.CIC_ORG_ID,query.archived === 'true',query.owner_id ?? null,query.q ?? null,query.limit,query.offset]);
      return rows.rows.map(row => DonorSchema.parse(row));
    });
    res.json({items,limit:query.limit,offset:query.offset});
  });
  router.get('/:id', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = valid(IdSchema.safeParse(req.params.id));
    const donor = await withMember(db, env.CIC_ORG_ID, identity, async client => {
      const rows = await client.query(`SELECT ${fields} FROM donors WHERE org_id=$1 AND id=$2`, [env.CIC_ORG_ID,id]);
      if (!rows.rows.length) throw new HttpError(404);
      return DonorSchema.parse(rows.rows[0]);
    });
    res.json(donor);
  });
  router.patch('/:id', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = valid(IdSchema.safeParse(req.params.id));
    const update = valid(Update.safeParse(req.body));
    const entries = Object.entries(update);
    const donor = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const values = entries.map(([key,value]) => key === 'metadata' ? JSON.stringify(value) : value);
      const columns = entries.map(([key], i) => `${key}=$${i + 3}${key === 'metadata' ? '::jsonb' : ''}`).join(', ');
      const rows = await client.query(`UPDATE donors SET ${columns}, updated_at=now() WHERE org_id=$1 AND id=$2 RETURNING ${fields}`, [env.CIC_ORG_ID,id,...values]);
      if (!rows.rows.length) throw new HttpError(404);
      await client.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,'donor.update',$3,'success')", [env.CIC_ORG_ID,member.id,id]);
      return DonorSchema.parse(rows.rows[0]);
    });
    res.json(donor);
  });
  router.post('/:id/archive', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = valid(IdSchema.safeParse(req.params.id));
    const donor = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const rows = await client.query(`UPDATE donors SET archived_at=now(), updated_at=now() WHERE org_id=$1 AND id=$2 RETURNING ${fields}`, [env.CIC_ORG_ID,id]);
      if (!rows.rows.length) throw new HttpError(404);
      await client.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,'donor.archive',$3,'success')", [env.CIC_ORG_ID,member.id,id]);
      return DonorSchema.parse(rows.rows[0]);
    });
    res.json(donor);
  });
  return router;
}
