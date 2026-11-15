import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { createDraft, editDraft, ApprovalError } from '../../packages/outreach/messages.ts';
import { instant } from '../../packages/reporting/retention.ts';
import { withMember, type Client, type Database } from './db.ts';
import { HttpError, type Env } from './env.ts';
import type { Identity } from './auth.ts';
import { proposeJson, type AiRequest } from './ai.ts';
import { RateLimiter } from './rate-limit.ts';

const Input = z.strictObject({ donor_id: z.uuid(), program_id: z.uuid(), from: z.iso.date(), to: z.iso.date() });
const Save = Input.extend({ context_hash: z.string().regex(/^[a-f0-9]{64}$/), subject: z.string().min(1).max(200).regex(/^[^\r\n]+$/), body: z.string().min(1).max(5000) });
const Plan = z.strictObject({ opening: z.enum(['update', 'thanks']), closing: z.enum(['questions', 'thanks']), fact_ids: z.array(z.string()).max(3) });
const planSchema = z.toJSONSchema(Plan);
type Input = z.infer<typeof Input>;
type Fact = { id: string; text: string };
const stamp = (name: string) => `to_char(${name} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const text = (value: unknown) => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\u2014/g, ',').slice(0, 1000);
const cents = (value: string) => { const n = BigInt(value); return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`; };
function parse<T>(schema: z.ZodType<T>, value: unknown) { const p = schema.safeParse(value); if (!p.success) throw new HttpError(400); return p.data; }

async function context(client: Client, input: Input, lock = false) {
  const period = { from: `${input.from}T00:00:00-07:00`, to: `${input.to}T00:00:00-07:00` };
  if (instant(period.from) >= instant(period.to)) throw new HttpError(400);
  const donor = (await client.query(`SELECT id,owner_id,name,email,phone,consent FROM donors WHERE id=$1 AND archived_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [input.donor_id])).rows[0];
  const program = (await client.query('SELECT title FROM programs WHERE id=$1', [input.program_id])).rows[0];
  if (!donor || !program) throw new HttpError(404);
  const draft = createDraft({ donor: donor as Parameters<typeof createDraft>[0]['donor'], channel: 'email', template: 'quarterly_update',
    fields: { first_name: text(donor.name), program: text(program.title) } });
  const totals = (await client.query(`SELECT g.currency,sum(g.amount_cents-g.refund_cents)::text AS net
    FROM gifts g JOIN campaigns c ON c.org_id=g.org_id AND c.id=g.campaign_id
    WHERE g.donor_id=$1 AND c.program_id=$2 AND g.status='settled' AND g.occurred_at >= $3 AND g.occurred_at < $4
    GROUP BY g.currency ORDER BY g.currency`, [input.donor_id,input.program_id,period.from,period.to])).rows;
  // RLS supplies only outcomes this member may read; unavailable results never become claims.
  const outcomes = (await client.query(`SELECT metric,value,unit,denominator,source,${stamp('period_from')} AS period_from,
    ${stamp('period_to')} AS period_to,${stamp('approved_at')} AS approved_at FROM program_outcomes
    WHERE program_id=$1 AND period_from < $3 AND period_to > $2 ORDER BY period_from,period_to,metric LIMIT 10`,
  [input.program_id,period.from,period.to])).rows;
  const facts: Fact[] = totals.map((row,i) => ({ id: `gift_${i}`, text: `Recorded net support for ${text(program.title)}: ${text(row.currency)} ${cents(String(row.net))} (${input.from} to ${input.to}, end exclusive).` }));
  for (const [i,row] of outcomes.entries()) if (row.value !== null) facts.push({ id: `outcome_${i}`, text:
    `${text(row.metric)}: ${text(row.value)} ${text(row.unit)}${row.denominator === null ? '' : `; denominator ${text(row.denominator)}`}.
Period: ${text(row.period_from)} to ${text(row.period_to)} (end exclusive). Source: ${text(row.source)}. Approved: ${text(row.approved_at)}.` });
  const context_hash = createHash('sha256').update(JSON.stringify([donor, program, facts])).digest('hex');
  return { draft, facts, context_hash };
}

/** Model chooses a sentence plan, never supplies unchecked claims or personal text. */
export function updateText(base: Awaited<ReturnType<typeof context>>, proposed: unknown) {
  const p = Plan.safeParse(proposed), ids = new Set(base.facts.map(f => f.id));
  const plan = p.success && p.data.fact_ids.every(id => ids.has(id)) ? p.data : null;
  const selected = plan?.fact_ids.length ? [...new Set(plan.fact_ids)].map(id => base.facts.find(f => f.id === id)!) : base.facts.slice(0,3);
  const opening = plan?.opening === 'thanks' ? 'Thank you for supporting Coding in Color.' : 'Here is an update from Coding in Color.';
  const closing = plan?.closing === 'questions' ? 'Please reply if you have any questions.' : 'Thank you for being part of Coding in Color.';
  return { subject: 'An update from Coding in Color', body: `${opening}\n\n${selected.map(f => f.text).join('\n\n') || 'No approved program results or recorded program gifts are available for this period.'}\n\n${closing}\nCoding in Color`,
    facts: base.facts, context_hash: base.context_hash };
}

export function groundedDrafts(env: Env, db: Database, verify: (header: string | undefined) => Promise<Identity>, propose: (request: AiRequest) => Promise<unknown> = proposeJson) {
  const router = Router(), limiter = new RateLimiter({ limit: 8, windowMs: 60000, maxEntries: 1000 });
  router.post('/api/v1/drafts/grounded/propose', async (req,res) => {
    const identity = await verify(req.get('Authorization')), input = parse(Input,req.body);
    const base = await withMember(db,env.CIC_ORG_ID,identity,async (client,member) => {
      if (!limiter.hit(member.id).ok) throw new HttpError(429);
      return context(client,input);
    }).catch(error => { if (error instanceof ApprovalError) throw new HttpError(409); throw error; });
    // External inputs contain only synthetic fact references and categories, never donor/outcome text or financial values.
    const plan = await propose({ purpose: 'Choose a concise update sentence plan using supplied fact references. Prefer approved outcome facts when available. Never add facts.',
      schema: planSchema, data: { facts: base.facts.map(f => ({ id: f.id, kind: f.id.startsWith('gift_') ? 'gift' : 'approved_outcome' })) } }).catch(() => null);
    res.json(updateText(base,plan));
  });
  router.post('/api/v1/drafts/grounded', async (req,res) => {
    const identity = await verify(req.get('Authorization')), input = parse(Save,req.body);
    const created = await withMember(db,env.CIC_ORG_ID,identity,async (client,member) => {
      const base = await context(client,input,true);
      if (base.context_hash !== input.context_hash) throw new HttpError(409);
      const draft = editDraft(base.draft,{subject:input.subject,body:input.body});
      const existing = (await client.query(`SELECT id FROM drafts WHERE donor_id=$1 AND author_id=$2
        AND subject=$3 AND body=$4 AND status IN ('draft','approved') ORDER BY created_at,id LIMIT 1`,
      [input.donor_id,member.id,draft.subject,draft.body])).rows[0];
      if (existing) return existing;
      const row = (await client.query(`INSERT INTO drafts(org_id,donor_id,author_id,channel,recipient,subject,body)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [env.CIC_ORG_ID,input.donor_id,member.id,draft.channel,draft.recipient,draft.subject,draft.body])).rows[0];
      await client.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,'draft.grounded.create',$3,'success')", [env.CIC_ORG_ID,member.id,row.id]);
      return row;
    }).catch(error => { if (error instanceof ApprovalError) throw new HttpError(409); throw error; });
    res.status(201).json(created);
  });
  return router;
}
