import type {Router} from 'express';
import {z} from 'zod';
import {DonorWriteSchema,GiftWriteSchema} from '../../packages/contracts/index.ts';
import {applyReviewedGifts} from '../../tools/import-apply.ts';
import {batchOf,fail,ImportError,parse,staged} from './import-batches.ts';
import {giftPlan,plans,resolve,sameReviewer,stale,type ImportAccess} from './import-plans.ts';
const Hash=z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Commit=z.strictObject({donor_plan_hash:Hash,plan_hash:Hash});
export function registerImportCommit(router:Router,access:ImportAccess,org:string) {
  router.post('/:id/commit',async(req,res)=>{
    const result=await access(req.get('Authorization'),async(c,m)=>{
      const input=parse(Commit,req.body);
      const b=await batchOf(c,req.params.id,org);
      if(b.status==='committed') {
        if(b.donor_plan_hash!==input.donor_plan_hash||b.gift_plan_hash!==input.plan_hash) fail(409,'batch_not_reviewing');
        return {...b.result,replayed:true};
      }
      staged(b); sameReviewer(b,m.id);
      if(!b.reviewer_id||b.gift_decisions===null) fail(409,'plan_not_ready');
      // Follow assignment's lock order; hold existing facts stable through apply.
      await c.query('INSERT INTO assignment_cursors(org_id) VALUES($1) ON CONFLICT DO NOTHING',[org]);
      await c.query('SELECT org_id FROM assignment_cursors WHERE org_id=$1 FOR UPDATE',[org]);
      const p=await plans(c,b,org,true);
      if(input.donor_plan_hash!==p.donor.plan_hash) stale(p.donor.plan_hash);
      const {gift,donorResolution}=giftPlan(b,p);
      if(input.plan_hash!==gift.plan_hash||b.gift_plan_hash!==gift.plan_hash) stale(gift.plan_hash);
      const gifts=resolve(gift,b.gift_decisions??fail(409,'plan_not_ready'));
      if(gifts.status!=='ready') return fail(409,'plan_not_ready');
      const skipped=new Set(b.layout?.skip_records??[]);
      if(p.drafts.excluded.some(r=>!skipped.has(r.recordNumber))) fail(400,'invalid_decision');
      const donorIds=new Map<number,string>(); let created=0,linked=0;
      for(const op of donorResolution.operations) {
        if(op.reviewer_id!==null&&op.reviewer_id!==m.id) fail(409,'reviewer_mismatch');
        if(op.op==='link') {donorIds.set(op.row,op.donor_id!);linked++;continue;}
        const d=DonorWriteSchema.parse(op.draft);
        const [row]=(await c.query('SELECT * FROM public.create_assigned_donor($1,$2,$3,$4,$5::jsonb)',
          [d.name,d.email??null,d.phone??null,d.consent,JSON.stringify(d.metadata)]).catch(e=>{
            if((e as {code?:string}).code==='P0001') fail(409,'plan_not_ready'); throw e;
          })).rows;
        donorIds.set(op.row,String(row.id)); created++;
        const owner=d.metadata.import_owner_id;
        if(typeof owner==='string') await c.query('SELECT * FROM public.reassign_donor($1,$2)',[row.id,owner]);
      }
      const operations=gifts.operations.map(op=>{
        const {donor_row,...operation}=op;
        const draft=GiftWriteSchema.parse({...op.draft as object,...(donor_row===undefined?{}:{donor_id:donorIds.get(donor_row)})});
        if(draft.source!==b.source||draft.source_row?.batch_id!==b.id) fail(400,'invalid_decision');
        if(op.op==='correct') {
          const old=p.stored.existing_gifts.find(g=>g.id===op.gift_id);
          if(!old) return fail(400,'invalid_decision');
          // Correct facts without rewriting the original gift's immutable import identity.
          return {...operation,draft:{...draft,source_row:old.source_row??null}};
        }
        return {...operation,draft};
      });
      const applied=await applyReviewedGifts(c,{org_id:org,operations}).catch(e=>{
        if((e as {code?:string}).code==='23505') fail(409,'provenance_conflict'); throw e;
      });
      const [clock]=(await c.query(`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows;
      const saved={batch_id:b.id,status:'committed',committed_at:clock.at,replayed:false,counts:{donors_created:created,donors_linked:linked,
        gifts_inserted:applied.applied.filter(x=>x.op==='insert').length,gifts_corrected:applied.applied.filter(x=>x.op==='correct').length,
        skipped:p.drafts.excluded.length+p.drafts.gifts.length-operations.length}};
      await c.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,'import.commit',$3,'success')",[org,m.id,b.id]);
      await c.query(`UPDATE import_batches SET status='committed',raw_csv=NULL,layout=NULL,donor_decisions=NULL,gift_decisions=NULL,
        committed_by=$2,committed_at=now(),result=$3 WHERE id=$1`,[b.id,m.id,JSON.stringify(saved)]);
      return saved;
    });
    res.json(result);
  });
}
