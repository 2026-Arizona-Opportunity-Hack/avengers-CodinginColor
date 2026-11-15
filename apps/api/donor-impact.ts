import { Router } from 'express';
import { z } from 'zod';
import type { Database } from './db.ts';
import { HttpError,type Env } from './env.ts';
import type { Identity } from './auth.ts';
const Page=z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).default(0)});
export function donorImpact(env:Env,db:Database,verify:(header:string|undefined)=>Promise<Identity>){
  const router=Router();router.get('/',async(req,res)=>{
    const identity=await verify(req.get('Authorization')),page=Page.safeParse(req.query);if(!page.success)throw new HttpError(400);
    if(!identity.verifiedEmail)throw new HttpError(403);
    const client=await db.connect();let destroy=false;
    try{
      await client.query('BEGIN');await client.query('SET LOCAL ROLE cic_runtime');
      await client.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true),set_config('app.verified_email',$3,true)",[env.CIC_ORG_ID,identity.subject,identity.verifiedEmail]);
      const result=await client.query('SELECT public.donor_impact_feed($1,$2) AS feed',[page.data.limit,page.data.offset]);
      await client.query('COMMIT');res.json(result.rows[0].feed);
    }catch(error){try{await client.query('ROLLBACK');}catch{destroy=true;}
      if((error as {code?:string}).code==='42501')throw new HttpError(403);throw error;
    }finally{client.release(destroy);}
  });return router;
}
