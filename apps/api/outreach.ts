import express from 'express';
import { z } from 'zod';
import { IdSchema } from '../../packages/contracts/index.ts';
import { buildQueue, planQuarterlyTouches, type OutreachDonor, type OutreachTask } from '../../packages/outreach/queue.ts';
import { instant } from '../../packages/reporting/retention.ts';
import { withMember, type Database } from './db.ts';
import { HttpError, type Env } from './env.ts';
import type { Identity } from './auth.ts';

/** CIC works in Phoenix time, which has no daylight saving. */
const OFFSET = '-07:00';
const stamp = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const timestamp = z.string().refine((v) => { try { instant(v); return true; } catch { return false; } });
const Scope = z.strictObject({ scope: z.enum(['mine', 'all']).default('mine') });
const NextAction = z.strictObject({ donor_id: IdSchema, title: z.string().trim().min(1).max(200), due_at: timestamp });
const Quarterly = z.strictObject({ quarter: z.string().regex(/^\d{4}-Q[1-4]$/) });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400);
  return result.data;
}
const audit = (actor: string, action: string, target: string, org: string): [string, unknown[]] => [
  `INSERT INTO audit_events (org_id, actor_id, action, target_id, status) VALUES ($1, $2, $3, $4, 'success')`,
  [org, actor, action, target]];

/**
 * Follow-up queue routes (#45, #47). Row-level security on follow_ups follows donor visibility,
 * so board members only ever see and complete their own donors' tasks.
 */
export function createOutreachRouter(env: Env, db: Database, verify: (header: string | undefined) => Promise<Identity>,
  options: { now?: () => string } = {}) {
  const router = express.Router();
  const now = () => options.now?.() ?? new Date().toISOString();

  router.get('/api/v1/follow-ups', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const { scope } = parse(Scope, req.query);
    const tasks = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      if (scope === 'all' && member.role !== 'admin') throw new HttpError(403);
      return (await client.query(`SELECT f.id, f.donor_id, f.owner_id, f.kind, f.quarter, f.title, f.status,
          ${stamp('f.due_at')} AS due_at, d.name AS donor_name
        FROM follow_ups f JOIN donors d ON d.org_id = f.org_id AND d.id = f.donor_id
        WHERE f.status = 'open' AND ($1::uuid IS NULL OR f.owner_id = $1)`,
      [scope === 'mine' ? member.id : null])).rows as Array<OutreachTask & { donor_name: string }>;
    });
    res.json(buildQueue(tasks, { now: now() }));
  });

  router.post('/api/v1/follow-ups', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const input = parse(NextAction, req.body);
    const task = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const [donor] = (await client.query('SELECT owner_id FROM donors WHERE id = $1 AND archived_at IS NULL',
        [input.donor_id])).rows;
      if (!donor) throw new HttpError(404);
      if (donor.owner_id === null) throw new HttpError(409);
      // The task always belongs to the donor's current owner, whoever records it.
      const [row] = (await client.query(`INSERT INTO follow_ups (org_id, donor_id, owner_id, kind, title, due_at)
        VALUES ($1, $2, $3, 'next_action', $4, $5)
        RETURNING id, donor_id, owner_id, kind, title, status, ${stamp('due_at')} AS due_at`,
      [env.CIC_ORG_ID, input.donor_id, donor.owner_id, input.title, input.due_at])).rows;
      await client.query(...audit(member.id, 'follow_up.create', String(row.id), env.CIC_ORG_ID));
      return row;
    });
    res.status(201).json(task);
  });

  router.post('/api/v1/follow-ups/quarterly', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const { quarter } = parse(Quarterly, req.body);
    const result = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      if (member.role !== 'admin') throw new HttpError(403);
      const donors = (await client.query(`SELECT id, owner_id, consent, ${stamp('archived_at')} AS archived_at
        FROM donors`)).rows as OutreachDonor[];
      const existing = (await client.query(`SELECT id, donor_id, owner_id, kind, quarter, title, status,
          ${stamp('due_at')} AS due_at FROM follow_ups WHERE kind = 'quarterly' AND quarter = $1`, [quarter])).rows as OutreachTask[];
      const plan = planQuarterlyTouches(donors, existing, { quarter, offset: OFFSET });
      let created = 0;
      for (const task of plan.create) {
        created += (await client.query(`INSERT INTO follow_ups (org_id, donor_id, owner_id, kind, quarter, title, due_at)
          VALUES ($1, $2, $3, 'quarterly', $4, 'Quarterly update', $5)
          ON CONFLICT (org_id, donor_id, quarter) WHERE kind = 'quarterly' DO NOTHING RETURNING id`,
        [env.CIC_ORG_ID, task.donor_id, task.owner_id, task.quarter, task.due_at])).rows.length;
      }
      await client.query(...audit(member.id, 'follow_up.quarterly', env.CIC_ORG_ID, env.CIC_ORG_ID));
      return { created, skipped: Object.fromEntries(Object.entries(plan.skipped).map(([k, v]) => [k, v.length])) };
    });
    res.json(result);
  });

  router.post('/api/v1/follow-ups/:id/complete', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = parse(IdSchema, req.params.id);
    const done = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const [task] = (await client.query('SELECT status, kind FROM follow_ups WHERE id = $1', [id])).rows;
      if (!task) throw new HttpError(404);
      if (task.status !== 'open' || task.kind === 'quarterly') throw new HttpError(409);
      const [row] = (await client.query(`UPDATE follow_ups SET status = 'done', completed_at = now(), completed_by = $2
        WHERE id = $1 AND status = 'open' RETURNING id, status, completed_by`, [id, member.id])).rows;
      if (!row) throw new HttpError(409);
      await client.query(...audit(member.id, 'follow_up.complete', id, env.CIC_ORG_ID));
      return row;
    });
    res.json(done);
  });

  return router;
}
