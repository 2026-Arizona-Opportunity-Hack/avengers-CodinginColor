import express from 'express';
import { z } from 'zod';
import { IdSchema } from '../../packages/contracts/index.ts';
import { generateApiKey } from '../../packages/reporting/summary.ts';
import { withMember, type Client, type Database, type Member } from './db.ts';
import { HttpError, type Env } from './env.ts';
import type { Identity } from './auth.ts';

const stamp = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CreateKey = z.strictObject({ name: z.string().trim().min(1).max(100) });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400);
  return result.data;
}
function adminOnly(member: Member) { if (member.role !== 'admin') throw new HttpError(403); }
async function audit(client: Client, org: string, actor: string, action: string, target: string) {
  await client.query(`INSERT INTO audit_events (org_id, actor_id, action, target_id, status)
    VALUES ($1, $2, $3, $4, 'success')`, [org, actor, action, target]);
}

/**
 * Admin management of CIC dashboard API keys (#29), on top of 004's runtime policies:
 * a new key is returned exactly once, only its SHA-256 is stored, and revocation is one-way.
 */
export function createApiKeyRouter(env: Env, db: Database, verify: (header: string | undefined) => Promise<Identity>) {
  const router = express.Router();

  router.get('/api/v1/api-keys', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const items = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      adminOnly(member);
      return (await client.query(`SELECT id, name, hint, scopes, created_by, ${stamp('created_at')} AS created_at,
        ${stamp('revoked_at')} AS revoked_at FROM api_keys ORDER BY created_at DESC, id`)).rows;
    });
    res.json({ items });
  });

  router.post('/api/v1/api-keys', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const { name } = parse(CreateKey, req.body);
    const created = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      adminOnly(member);
      const key = generateApiKey();
      const [row] = (await client.query(`INSERT INTO api_keys (org_id, name, key_hash, hint, scopes, created_by)
        VALUES ($1, $2, $3, $4, ARRAY['read:aggregates'], $5) RETURNING id, name, hint`,
      [env.CIC_ORG_ID, name, key.hash, key.hint, member.id])).rows;
      await audit(client, env.CIC_ORG_ID, member.id, 'api_key.create', String(row.id));
      // The only time the raw key leaves the server; the page must show it once and never store it.
      return { ...row, key: key.key };
    });
    res.status(201).json(created);
  });

  router.post('/api/v1/api-keys/:id/revoke', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = parse(IdSchema, req.params.id);
    const revoked = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      adminOnly(member);
      const [existing] = (await client.query('SELECT revoked_at FROM api_keys WHERE id = $1', [id])).rows;
      if (!existing) throw new HttpError(404);
      if (existing.revoked_at !== null) throw new HttpError(409);
      const [row] = (await client.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL
        RETURNING id, ${stamp('revoked_at')} AS revoked_at`, [id])).rows;
      if (!row) throw new HttpError(409);
      await audit(client, env.CIC_ORG_ID, member.id, 'api_key.revoke', id);
      return row;
    });
    res.json(revoked);
  });

  return router;
}
