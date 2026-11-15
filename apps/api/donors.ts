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
const Owner = z.strictObject({ owner_id: IdSchema });
const Assigned = z.strictObject({ id: IdSchema, owner_id: IdSchema });
const Create = DonorWriteSchema.extend({ request_id: IdSchema.optional() });
function valid<T>(result: z.ZodSafeParseResult<T>): T {
  if (!result.success) throw new HttpError(400);
  return result.data;
}
// SQLSTATEs raised by the scoped assignment functions; anything else stays a dependency failure.
function failed(error: unknown, statuses: Record<string, number>): never {
  const code = (error as { code?: unknown } | null)?.code;
  const status = typeof code === 'string' ? statuses[code] : undefined;
  throw status ? new HttpError(status) : error;
}

export function donors(env: Env, db: Database, verify: (header: string | undefined) => Promise<Identity>) {
  const router = Router();
  router.post('/', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const write = valid(Create.safeParse(req.body));
    // The function returns only IDs, so a creator assigned elsewhere never receives the row.
    const assigned = await withMember(db, env.CIC_ORG_ID, identity, async client => {
      const values: unknown[] = [write.name, write.email ?? null, write.phone ?? null, write.consent, JSON.stringify(write.metadata)];
      const query = write.request_id ? 'SELECT * FROM public.create_donor_once($1,$2,$3,$4,$5,$6::jsonb)'
        : 'SELECT * FROM public.create_assigned_donor($1,$2,$3,$4,$5::jsonb)';
      if (write.request_id) values.unshift(write.request_id);
      const result = await client.query(query, values).catch(error => failed(error, { '42501': 403, P0001: 409, P0003: 409 }));
      const row = result.rows[0];
      return { donor: Assigned.parse({ id: row.id, owner_id: row.owner_id }), replayed: row.replayed === true };
    });
    res.status(assigned.replayed ? 200 : 201).json(assigned.donor);
  });
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
  router.post('/:id/owner', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = valid(IdSchema.safeParse(req.params.id));
    const owner = valid(Owner.safeParse(req.body));
    const assigned = await withMember(db, env.CIC_ORG_ID, identity, async client => {
      const result = await client.query('SELECT * FROM public.reassign_donor($1,$2)', [id, owner.owner_id])
        .catch(error => failed(error, { '42501': 403, P0002: 404, P0001: 409 }));
      return Assigned.parse(result.rows[0]);
    });
    res.json(assigned);
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
