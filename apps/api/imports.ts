import express,{type ErrorRequestHandler} from 'express';
import { z } from 'zod';
import { fingerprintFile } from '../../tools/import-review.ts';
import { parseCsv } from '../../tools/import-preview.ts';
import { withMember,type Database,type Client,type Member } from './db.ts';
import { HttpError,type Env } from './env.ts';
import type { Identity } from './auth.ts';
import { batchOf,countsOf,draftsOf,fail,ImportError,parse,staged,summary,type Batch } from './import-batches.ts';
import {registerImportReview} from './import-plans.ts';
import {registerImportCommit} from './import-commit.ts';
const Source=z.enum(['spreadsheet','zeffy','benevity','az_gives','united_way']);
const Page=z.strictObject({kind:z.enum(['preview','donor','gift']).default('preview'),
  offset:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(200).default(100)});
export function imports(env:Env,db:Database,verify:(h:string|undefined)=>Promise<Identity>) {
  const router=express.Router();
  const admin=async<T>(header:string|undefined,action:(c:Client,m:Member)=>Promise<T>)=>{
    const identity=await verify(header);
    return withMember(db,env.CIC_ORG_ID,identity,async(c,m)=>{if(m.role!=='admin') fail(403,'forbidden_role'); return action(c,m);});
  };
  router.use(express.json({limit:'1mb'}));
  router.post('/',express.raw({type:'text/csv',limit:4194304}),async(req,res)=>{
    const result=await admin(req.get('Authorization'),async(c,m)=>{
      if(!/^text\/csv(?:;\s*charset=utf-8)?$/i.test(req.get('Content-Type')??'')) fail(415,'unsupported_media_type');
      if(!Buffer.isBuffer(req.body)||!req.body.length) fail(400,'invalid_csv');
      const source=parse(Source,req.get('X-Import-Source'),'invalid_csv');
      const filename=parse(z.string().regex(/^[ -~]{1,255}$/).refine(v=>!/[\\/]/.test(v)&&!['.','..'].includes(v)),req.get('X-Import-Filename'),'invalid_csv');
      const hash=fingerprintFile(req.body);
      try { const text=new TextDecoder('utf-8',{fatal:true}).decode(req.body); if(text.includes('\0')) fail(400,'invalid_csv'); parseCsv(text); }
      catch(e) {if(e instanceof ImportError) throw e; fail(400,e instanceof TypeError?'invalid_utf8':'invalid_csv');}
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['cic-import:'+env.CIC_ORG_ID]);
      const prior=await c.query("SELECT * FROM import_batches WHERE org_id=$1 AND file_sha256=$2 AND status<>'abandoned'",[env.CIC_ORG_ID,hash]);
      if(prior.rows.length) {
        const b=prior.rows[0] as unknown as Batch;
        if(b.source!==source) fail(409,'source_mismatch');
        return {created:false,body:summary(b)};
      }
      // Validation and persistence share a transaction; PostgreSQL generates the UUID.
      const inserted=await c.query(`INSERT INTO import_batches(org_id,created_by,source,filename,file_sha256,raw_csv)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[env.CIC_ORG_ID,m.id,source,filename,hash,req.body]);
      const b=inserted.rows[0] as unknown as Batch;
      const preview=countsOf(b);
      await c.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,'import.stage',$3,'success')",[env.CIC_ORG_ID,m.id,b.id]);
      return {created:true,body:{...summary(b),preview}};
    });
    res.status(result.created?201:200).json(result.body);
  });
  router.get('/:id',async(req,res)=>res.json(await admin(req.get('Authorization'),async c=>
    summary(await batchOf(c,req.params.id,env.CIC_ORG_ID)))));
  router.post('/:id/layout',async(req,res)=>res.json(await admin(req.get('Authorization'),async(c,m)=>{
    const b=await batchOf(c,req.params.id,env.CIC_ORG_ID);
    draftsOf(b,req.body);
    const updated=await c.query(`UPDATE import_batches SET layout=$2,donor_decisions='[]',gift_decisions='[]',
      donor_plan_hash=NULL,gift_plan_hash=NULL,reviewer_id=NULL WHERE id=$1 RETURNING *`,[b.id,JSON.stringify(req.body)]);
    await c.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,'import.layout',$3,'success')",[env.CIC_ORG_ID,m.id,b.id]);
    return {...summary(b),preview:countsOf(updated.rows[0] as unknown as Batch)};
  })));
  router.get('/:id/rows',async(req,res)=>res.json(await admin(req.get('Authorization'),async c=>{
    const b=await batchOf(c,req.params.id,env.CIC_ORG_ID),q=parse(Page,req.query);
    const {preview,drafts}=draftsOf(b);
    const rows=q.kind==='preview'?preview.rows.map(r=>({...r,issues:preview.issues.filter(i=>i.recordNumber===r.recordNumber)}))
      :q.kind==='donor'?drafts.donors:drafts.gifts;
    const items:unknown[]=[];
    for(const row of rows.slice(q.offset,q.offset+q.limit)) {
      if(Buffer.byteLength(JSON.stringify([...items,row]))>1000000) {if(!items.length) fail(413,'payload_too_large'); break;}
      items.push(row);
    }
    return {items,total:rows.length,offset:q.offset,next_offset:q.offset+items.length};
  })));
  router.post('/:id/abandon',async(req,res)=>res.json(await admin(req.get('Authorization'),async(c,m)=>{
    const b=await batchOf(c,req.params.id,env.CIC_ORG_ID); staged(b);
    await c.query("UPDATE import_batches SET status='abandoned',raw_csv=NULL,layout=NULL,donor_decisions=NULL,gift_decisions=NULL WHERE id=$1",[b.id]);
    await c.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,'import.abandon',$3,'success')",[env.CIC_ORG_ID,m.id,b.id]);
    return {batch_id:b.id,status:'abandoned'};
  })));
  registerImportReview(router,admin,env.CIC_ORG_ID);
  registerImportCommit(router,admin,env.CIC_ORG_ID);
  const errors:ErrorRequestHandler=(e,_req,res,next)=>{
    if(e instanceof HttpError) {res.status(e.status).json({error:e instanceof ImportError?e.code:
      ({401:'unauthenticated',403:'forbidden_role',404:'import_not_found',503:'dependency_failure'} as Record<number,string>)[e.status]??'invalid_decision',
      ...('current_plan_hash' in e?{current_plan_hash:e.current_plan_hash}:{})});return;}
    if(e?.type==='entity.too.large'||e?.type==='entity.parse.failed') {res.status(e.type==='entity.too.large'?413:400).json({error:e.type==='entity.too.large'?'payload_too_large':'invalid_decision'});return;}
    res.status(503).json({error:'dependency_failure'});
  };
  router.use(errors); return router;
}
