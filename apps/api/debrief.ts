import { createHash } from 'node:crypto';
import { Router, json } from 'express';
import { z } from 'zod';
import { IdSchema } from '../../packages/contracts/index.ts';
import { ApprovalError, createDraft, editDraft, type MessageDonor } from '../../packages/outreach/messages.ts';
import { instant } from '../../packages/reporting/retention.ts';
import { closeTouches } from './outreach-messages.ts';
import { withMember, type Database } from './db.ts';
import { HttpError, type Env } from './env.ts';
import type { Identity } from './auth.ts';

const timestamp = z.string().refine(value => { try { instant(value); return true; } catch { return false; } });
const Input = z.strictObject({
  request_id: IdSchema, reviewed: z.literal(true),
  note: z.string().trim().min(1).max(2000), occurred_at: timestamp,
  next_action: z.strictObject({ title: z.string().trim().min(1).max(200), due_at: timestamp }).optional(),
  draft: z.strictObject({ channel: z.enum(['email', 'sms']),
    subject: z.string().max(200).regex(/^[^\r\n]*$/).nullable(), body: z.string().trim().min(1).max(5000) }).optional(),
});

/** Only explicitly reviewed facts are persisted; extraction and raw notes stay in the browser. */
export function debrief(env: Env, db: Database, verify: (header: string | undefined) => Promise<Identity>) {
  const router = Router();
  router.post('/api/v1/donors/:id/debrief', json({ limit: '32kb' }), async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const donorId = IdSchema.safeParse(req.params.id), input = Input.safeParse(req.body);
    if (!donorId.success || !input.success) throw new HttpError(400);
    const data = input.data;
    if (Date.parse(data.occurred_at) > Date.now()) throw new HttpError(400);
    const hash = createHash('sha256').update(JSON.stringify([donorId.data, data])).digest('hex');
    const result = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      const [donor] = (await client.query(`SELECT id, owner_id, consent, email, phone FROM donors
        WHERE id=$1 AND archived_at IS NULL FOR UPDATE`, [donorId.data])).rows;
      if (!donor) throw new HttpError(404);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [env.CIC_ORG_ID + member.id + data.request_id]);
      const [prior] = (await client.query(`SELECT payload_sha256,communication_id,follow_up_id,draft_id FROM debrief_requests
        WHERE actor_id=$1 AND request_id=$2`, [member.id, data.request_id])).rows;
      if (prior) {
        if (prior.payload_sha256 !== hash) throw new HttpError(409);
        return { communication_id: prior.communication_id, follow_up_id: prior.follow_up_id, draft_id: prior.draft_id, replayed: true };
      }
      if (data.next_action && !donor.owner_id) throw new HttpError(409);
      let draft;
      if (data.draft) {
        try {
          draft = editDraft(createDraft({ donor: donor as MessageDonor, channel: data.draft.channel,
            template: data.draft.channel === 'email' ? 'quarterly_update' : 'thank_you_sms',
            fields: { first_name: 'friend', program: 'Coding in Color' } }), data.draft);
        } catch (error) { if (error instanceof ApprovalError) throw new HttpError(409); throw error; }
      }
      const [communication] = (await client.query(`INSERT INTO communications(org_id,donor_id,channel,actor_id,occurred_at,status,qualifying,note)
        VALUES($1,$2,'meeting',$3,$4,'logged_contact',true,$5) RETURNING id`,
      [env.CIC_ORG_ID, donor.id, member.id, data.occurred_at, data.note])).rows;
      await closeTouches(client, String(donor.id), data.occurred_at, member.id);
      let taskId: unknown = null, draftId: unknown = null;
      if (data.next_action) {
        const [task] = (await client.query(`INSERT INTO follow_ups(org_id,donor_id,owner_id,kind,title,due_at)
          VALUES($1,$2,$3,'next_action',$4,$5) RETURNING id`,
        [env.CIC_ORG_ID, donor.id, donor.owner_id, data.next_action.title, data.next_action.due_at])).rows;
        taskId = task.id;
      }
      if (draft) {
        const [created] = (await client.query(`INSERT INTO drafts(org_id,donor_id,author_id,channel,recipient,subject,body)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [env.CIC_ORG_ID, donor.id, member.id, draft.channel, draft.recipient, draft.subject, draft.body])).rows;
        draftId = created.id;
      }
      await client.query(`INSERT INTO debrief_requests(org_id,actor_id,request_id,payload_sha256,communication_id,follow_up_id,draft_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [env.CIC_ORG_ID, member.id, data.request_id, hash, communication.id, taskId, draftId]);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,target_id,status)
        VALUES($1,$2,'debrief.save',$3,'success')`, [env.CIC_ORG_ID, member.id, data.request_id]);
      return { communication_id: communication.id, follow_up_id: taskId, draft_id: draftId, replayed: false };
    });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}
