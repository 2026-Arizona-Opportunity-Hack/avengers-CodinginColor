import type {Router} from 'express';
import {z} from 'zod';
import {DonorSchema,GiftSchema,IdSchema} from '../../packages/contracts/index.ts';
import {createReviewPlan,resolveReview,type ReviewPlan} from '../../tools/import-review.ts';
import type {Client,Member} from './db.ts';
import {batchOf,draftsOf,fail,ImportError,parse,type Batch} from './import-batches.ts';
export type ImportAccess=<T>(h:string|undefined,action:(c:Client,m:Member)=>Promise<T>)=>Promise<T>;
const Hash=z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Decision=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('donor'),row:z.int().nonnegative(),action:z.enum(['new','link','skip']),donor_id:IdSchema.optional()}),
  z.strictObject({kind:z.literal('gift'),row:z.int().nonnegative(),action:z.enum(['insert','correct','skip']),gift_id:IdSchema.optional()})]);
const Review=z.strictObject({plan_hash:Hash,donor_plan_hash:Hash.optional(),decisions:z.array(Decision).max(25000)});
export function stale(hash:string):never {throw Object.assign(new ImportError(409,'plan_stale'),{current_plan_hash:hash});}
export function sameReviewer(b:Batch,actor:string) {if(b.reviewer_id&&b.reviewer_id!==actor) fail(409,'reviewer_mismatch');}
export function resolve(plan:ReviewPlan,decisions:unknown[]) {
  try {return resolveReview(plan,decisions);} catch {return fail(400,'invalid_decision');}
}
export async function snapshot(c:Client,org:string,lock=false) {
  const suffix=' WHERE org_id=$1 ORDER BY id'+(lock?' FOR UPDATE':'');
  const donors=(await c.query(`SELECT id,org_id,owner_id,name,email,phone,consent,metadata,
    to_char(archived_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS archived_at FROM donors`+suffix,[org])).rows.map(r=>DonorSchema.parse(r));
  const gifts=(await c.query(`SELECT id,org_id,donor_id,campaign_id,amount_cents::text,refund_cents::text,currency,status,source,external_id,source_row,
    to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at FROM gifts`+suffix,[org])).rows
    .map(r=>GiftSchema.parse({...r,amount_cents:Number(r.amount_cents),refund_cents:Number(r.refund_cents)}));
  return {existing_donors:donors,existing_gifts:gifts};
}
export async function plans(c:Client,b:Batch,org:string,lock=false) {
  const {drafts}=draftsOf(b),stored=await snapshot(c,org,lock);
  const base={...stored,org_id:org,batch_id:b.id,file_sha256:b.file_sha256};
  const donor=createReviewPlan({...base,donors:drafts.donors,gifts:[]});
  return {drafts,stored,base,donor};
}
export function giftPlan(b:Batch,p:Awaited<ReturnType<typeof plans>>) {
  if(b.donor_plan_hash!==p.donor.plan_hash) stale(p.donor.plan_hash);
  const donorResolution=resolve(p.donor,b.donor_decisions??[]);
  if(donorResolution.status!=='ready') return fail(409,'plan_not_ready');
  const gift=createReviewPlan({...p.base,donors:[],gifts:p.drafts.gifts,donor_resolution:donorResolution});
  return {gift,donorResolution};
}
const counts=(p:ReviewPlan,kind:'donor'|'gift')=>p[`${kind}s`].rows.reduce<Record<string,number>>((n,r)=>({...n,[r.action]:(n[r.action]??0)+1}),{});
export function registerImportReview(router:Router,access:ImportAccess,org:string) {
  for(const kind of ['donor','gift'] as const) {
    const path=kind+'s';
    router.post(`/:id/${path}/plan`,async(req,res)=>res.json(await access(req.get('Authorization'),async(c,m)=>{
      const b=await batchOf(c,parse(IdSchema,req.params.id),org); sameReviewer(b,m.id);
      const p=await plans(c,b,org),plan=kind==='donor'?p.donor:giftPlan(b,p).gift;
      if(kind==='donor'&&b.donor_plan_hash!==plan.plan_hash) {
        await c.query("UPDATE import_batches SET donor_plan_hash=$2,donor_decisions='[]',gift_decisions='[]',gift_plan_hash=NULL WHERE id=$1",[b.id,plan.plan_hash]);
      } else if(kind==='gift'&&b.gift_plan_hash!==plan.plan_hash) {
        await c.query("UPDATE import_batches SET gift_plan_hash=$2,gift_decisions='[]' WHERE id=$1",[b.id,plan.plan_hash]);
      }
      return {plan_hash:plan.plan_hash,donor_plan_hash:p.donor.plan_hash,counts:counts(plan,kind),
        excluded:p.drafts.excluded.length,unresolved:p.drafts.unresolved};
    })));
    router.post(`/:id/${path}/review`,async(req,res)=>res.json(await access(req.get('Authorization'),async(c,m)=>{
      const input=parse(Review,req.body),b=await batchOf(c,parse(IdSchema,req.params.id),org); sameReviewer(b,m.id);
      if(input.decisions.some(d=>d.kind!==kind)) fail(400,'invalid_decision');
      const p=await plans(c,b,org),plan=kind==='donor'?p.donor:giftPlan(b,p).gift;
      if(input.plan_hash!==plan.plan_hash||b[kind==='donor'?'donor_plan_hash':'gift_plan_hash']!==plan.plan_hash) stale(plan.plan_hash);
      if(kind==='gift'&&input.donor_plan_hash!==p.donor.plan_hash) stale(p.donor.plan_hash);
      const decisions=input.decisions.map(d=>({...d,plan_hash:plan.plan_hash,reviewer_id:m.id}));
      const result=resolve(plan,decisions);
      if(kind==='donor') {
        await c.query("UPDATE import_batches SET donor_decisions=$2,gift_decisions='[]',gift_plan_hash=NULL,reviewer_id=$3 WHERE id=$1",[b.id,JSON.stringify(decisions),m.id]);
      } else await c.query('UPDATE import_batches SET gift_decisions=$2,reviewer_id=$3 WHERE id=$1',[b.id,JSON.stringify(decisions),m.id]);
      await c.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,$3,$4,'success')",[org,m.id,'import.review.'+kind,b.id]);
      return {status:result.status,...(result.status==='needs_review'?{pending:result.pending.slice(0,200),total_pending:result.pending.length}:{}),
        plan_hash:plan.plan_hash,donor_plan_hash:p.donor.plan_hash};
    })));
  }
  router.get('/:id/plan/rows',async(req,res)=>res.json(await access(req.get('Authorization'),async c=>{
    const q=parse(z.strictObject({kind:z.enum(['donor','gift']),offset:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(200).default(100)}),req.query);
    const b=await batchOf(c,parse(IdSchema,req.params.id),org),p=await plans(c,b,org),plan=q.kind==='donor'?p.donor:giftPlan(b,p).gift;
    const group=plan[`${q.kind}s`],items:unknown[]=[];
    for(const row of group.rows.slice(q.offset,q.offset+q.limit)) {
      const item={...row,draft:group.drafts[row.row],candidates:group.reviewed.filter(r=>row.existingIds.includes(String((r as {id:string}).id)))};
      if(Buffer.byteLength(JSON.stringify([...items,item]))>1000000) {if(!items.length) fail(413,'payload_too_large'); break;}
      items.push(item);
    }
    return {plan_hash:plan.plan_hash,items,total:group.rows.length,offset:q.offset,next_offset:q.offset+items.length};
  })));
}
