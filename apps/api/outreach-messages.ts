import express from 'express';
import { z } from 'zod';
import { IdSchema } from '../../packages/contracts/index.ts';
import {
  ApprovalError, TEMPLATES, approveDraft, composeLink, createDraft, editDraft, recordManualSend,
  type Actor, type Draft, type MessageDonor,
} from '../../packages/outreach/messages.ts';
import { tasksClosedBy, type OutreachTask } from '../../packages/outreach/queue.ts';
import { instant } from '../../packages/reporting/retention.ts';
import { withMember, type Client, type Database } from './db.ts';
import { HttpError, type Env } from './env.ts';
import type { Identity } from './auth.ts';

/** CIC works in Phoenix time, which has no daylight saving. */
const OFFSET = '-07:00';
const stamp = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const timestamp = z.string().refine((v) => { try { instant(v); return true; } catch { return false; } });
const templateIds = Object.keys(TEMPLATES) as [keyof typeof TEMPLATES, ...(keyof typeof TEMPLATES)[]];
const CreateDraft = z.strictObject({ donor_id: IdSchema, template: z.enum(templateIds),
  fields: z.record(z.string(), z.string().max(200)) });
const EditDraft = z.strictObject({ subject: z.string().nullable().optional(), body: z.string().optional() })
  .refine((v) => v.subject !== undefined || v.body !== undefined);
const ManualSend = z.strictObject({ confirmed: z.literal(true) });
const ListDrafts = z.strictObject({ status: z.enum(['open', 'draft', 'approved', 'sent', 'failed', 'logged']).default('open') });
const LogContact = z.strictObject({ channel: z.enum(['call', 'meeting', 'sms', 'email']), occurred_at: timestamp,
  note: z.string().max(2000).optional() });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400);
  return result.data;
}
/** Translate the reviewed message rules' errors into HTTP statuses. */
function rule(error: unknown): never {
  if (!(error instanceof ApprovalError)) throw error;
  if (/not this donor's owner/.test(error.message)) throw new HttpError(403);
  if (/declined contact|archived|already sent|must be approved|contact changed|Only an unapproved/.test(error.message)) {
    throw new HttpError(409);
  }
  throw new HttpError(400);
}
async function audit(client: Client, org: string, actor: string, action: string, target: string) {
  await client.query(`INSERT INTO audit_events (org_id, actor_id, action, target_id, status)
    VALUES ($1, $2, $3, $4, 'success')`, [org, actor, action, target]);
}
async function visibleDonor(client: Client, id: string): Promise<MessageDonor> {
  const [row] = (await client.query(`SELECT id, owner_id, consent, email, phone FROM donors
    WHERE id = $1 AND archived_at IS NULL`, [id])).rows;
  if (!row) throw new HttpError(404);
  return row as MessageDonor;
}
/** A draft and its donor's current owner, consent, contact and archive state; RLS turns other owners' drafts into 404s. */
async function loadDraft(client: Client, id: string): Promise<{ draft: Draft; donor: MessageDonor }> {
  const [r] = (await client.query(`SELECT d.donor_id, d.channel, d.recipient, d.subject, d.body, d.status,
      d.approval_hash, d.approved_by, ${stamp('d.approved_at')} AS approved_at,
      n.owner_id, n.consent, n.email, n.phone, n.archived_at IS NOT NULL AS archived
    FROM drafts d JOIN donors n ON n.org_id = d.org_id AND n.id = d.donor_id WHERE d.id = $1`, [id])).rows;
  if (!r) throw new HttpError(404);
  const donor = { id: String(r.donor_id), owner_id: r.owner_id as string | null, consent: r.consent as MessageDonor['consent'],
    email: r.email as string | null, phone: r.phone as string | null, archived: r.archived === true };
  const draft: Draft = { donor_id: donor.id, owner_id: donor.owner_id, channel: r.channel as Draft['channel'],
    recipient: String(r.recipient), subject: r.subject as string | null, body: String(r.body), status: r.status as Draft['status'],
    approval: r.approval_hash ? { hash: String(r.approval_hash), approved_by: String(r.approved_by), approved_at: String(r.approved_at) } : null };
  return { draft, donor };
}
/** A qualifying contact completes that donor's open quarterly touch for the contact's quarter. */
async function closeTouches(client: Client, donorId: string, at: string, actor: string): Promise<number> {
  const open = (await client.query(`SELECT id, donor_id, owner_id, kind, quarter, title, status, ${stamp('due_at')} AS due_at
    FROM follow_ups WHERE donor_id = $1 AND status = 'open'`, [donorId])).rows as OutreachTask[];
  const ids = tasksClosedBy(open, { donor_id: donorId, occurred_at: at, qualifying: true }, OFFSET);
  if (ids.length === 0) return 0;
  return (await client.query(`UPDATE follow_ups SET status = 'done', completed_at = now(), completed_by = $2
    WHERE id = ANY($1::uuid[]) AND status = 'open' RETURNING id`, [ids, actor])).rows.length;
}

/**
 * Message drafting, approval, manual sending and the communications timeline (#46, #47).
 * Nothing is ever sent by the server: a person sends from their own app and confirms it.
 */
export function createMessageRouter(env: Env, db: Database, verify: (header: string | undefined) => Promise<Identity>,
  options: { now?: () => string } = {}) {
  const router = express.Router();
  const now = () => options.now?.() ?? new Date().toISOString();
  const actorOf = (m: { id: string; role: 'admin' | 'board' }): Actor => ({ member_id: m.id, role: m.role });

  /** Drafts this member may see (RLS scopes board members to their donors). Default: still awaiting a send. */
  router.get('/api/v1/drafts', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const { status } = parse(ListDrafts, req.query);
    const statuses = status === 'open' ? ['draft', 'approved'] : [status];
    const items = await withMember(db, env.CIC_ORG_ID, identity, async (client) => (await client.query(
      `SELECT d.id, d.donor_id, n.owner_id, d.author_id, d.channel, d.recipient, d.subject, d.body, d.status, d.approved_by,
          ${stamp('d.approved_at')} AS approved_at, ${stamp('d.created_at')} AS created_at
        FROM drafts d JOIN donors n ON n.org_id = d.org_id AND n.id = d.donor_id
        WHERE d.status = ANY($1::text[]) AND n.archived_at IS NULL ORDER BY d.created_at DESC, d.id LIMIT 200`,
      [statuses])).rows);
    res.json({ items });
  });

  router.post('/api/v1/drafts', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const input = parse(CreateDraft, req.body);
    const row = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const donor = await visibleDonor(client, input.donor_id);
      let draft: Draft;
      try {
        draft = createDraft({ donor, channel: TEMPLATES[input.template].channel, template: input.template, fields: input.fields });
      } catch (error) { rule(error); }
      const [created] = (await client.query(`INSERT INTO drafts (org_id, donor_id, author_id, channel, recipient, subject, body)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, donor_id, author_id, channel, recipient, subject, body, status,
          ${stamp('created_at')} AS created_at`,
      [env.CIC_ORG_ID, donor.id, member.id, draft.channel, draft.recipient, draft.subject, draft.body])).rows;
      await audit(client, env.CIC_ORG_ID, member.id, 'draft.create', String(created.id));
      // owner_id is the donor's current owner (who works the queue); author_id is who drafted it.
      return { ...created, owner_id: donor.owner_id };
    });
    res.status(201).json(row);
  });

  router.patch('/api/v1/drafts/:id', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = parse(IdSchema, req.params.id);
    const changes = parse(EditDraft, req.body);
    const row = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const { draft } = await loadDraft(client, id);
      let next: Draft;
      try { next = editDraft(draft, changes); } catch (error) { rule(error); }
      // The drafts trigger drops any approval when subject or body change.
      const [updated] = (await client.query(`UPDATE drafts SET subject = $2, body = $3 WHERE id = $1
        RETURNING id, status, approval_hash, subject, body`, [id, next.subject, next.body])).rows;
      await audit(client, env.CIC_ORG_ID, member.id, 'draft.update', id);
      return updated;
    });
    res.json(row);
  });

  router.post('/api/v1/drafts/:id/approve', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = parse(IdSchema, req.params.id);
    const row = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const { draft } = await loadDraft(client, id);
      let approved: Draft;
      try { approved = approveDraft(draft, actorOf(member), now()); } catch (error) { rule(error); }
      const [updated] = (await client.query(`UPDATE drafts SET status = 'approved', approval_hash = $2, approved_by = $3,
          approved_at = $4 WHERE id = $1 AND status = 'draft' RETURNING id, status, approval_hash`,
      [id, approved.approval!.hash, member.id, approved.approval!.approved_at])).rows;
      if (!updated) throw new HttpError(409);
      await audit(client, env.CIC_ORG_ID, member.id, 'draft.approve', id);
      return updated;
    });
    res.json(row);
  });

  router.get('/api/v1/drafts/:id/compose', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = parse(IdSchema, req.params.id);
    const href = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const { draft, donor } = await loadDraft(client, id);
      try { return composeLink(draft, donor, actorOf(member)); } catch (error) { rule(error); }
    });
    res.json({ href });
  });

  router.post('/api/v1/drafts/:id/manual-send', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = parse(IdSchema, req.params.id);
    parse(ManualSend, req.body);
    const result = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const { draft, donor } = await loadDraft(client, id);
      const at = now();
      let logged;
      try { logged = recordManualSend(draft, donor, actorOf(member), { confirmed: true, at }); } catch (error) { rule(error); }
      if (!logged.communication) return { status: 'logged', closed_follow_ups: 0, already_logged: true };
      const c = logged.communication;
      // The unique index on approval_hash makes a concurrent double send fail instead of logging twice.
      await client.query(`INSERT INTO communications (org_id, donor_id, draft_id, channel, actor_id, occurred_at, status,
          approval_hash, qualifying) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [env.CIC_ORG_ID, c.donor_id, id, c.channel, member.id, c.sent_at, c.status, c.approval_hash, c.qualifying]);
      await client.query(`UPDATE drafts SET status = 'logged' WHERE id = $1`, [id]);
      const closed = await closeTouches(client, donor.id, at, member.id);
      await audit(client, env.CIC_ORG_ID, member.id, 'draft.manual_send', id);
      return { status: 'logged', closed_follow_ups: closed, already_logged: false };
    }).catch((error) => {
      if ((error as { code?: string }).code === '23505') throw new HttpError(409);
      throw error;
    });
    res.json(result);
  });

  router.get('/api/v1/donors/:id/communications', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = parse(IdSchema, req.params.id);
    const items = await withMember(db, env.CIC_ORG_ID, identity, async (client) => {
      const [donor] = (await client.query('SELECT id FROM donors WHERE id = $1', [id])).rows;
      if (!donor) throw new HttpError(404);
      return (await client.query(`SELECT id, channel, status, ${stamp('occurred_at')} AS occurred_at, actor_id, qualifying, note
        FROM communications WHERE donor_id = $1 ORDER BY occurred_at DESC, created_at DESC`, [id])).rows;
    });
    res.json({ items });
  });

  router.post('/api/v1/donors/:id/communications', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const id = parse(IdSchema, req.params.id);
    const input = parse(LogContact, req.body);
    const result = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const donor = await visibleDonor(client, id);
      const [row] = (await client.query(`INSERT INTO communications (org_id, donor_id, channel, actor_id, occurred_at, status,
          qualifying, note) VALUES ($1, $2, $3, $4, $5, 'logged_contact', true, $6) RETURNING id`,
      [env.CIC_ORG_ID, donor.id, input.channel, member.id, input.occurred_at, input.note ?? null])).rows;
      const closed = await closeTouches(client, donor.id, input.occurred_at, member.id);
      await audit(client, env.CIC_ORG_ID, member.id, 'communication.log', String(row.id));
      return { status: 'logged_contact', closed_follow_ups: closed };
    });
    res.status(201).json(result);
  });

  return router;
}
