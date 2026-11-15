import { Router } from 'express';
import { z } from 'zod';
import { IdSchema } from '../../packages/contracts/index.ts';
import { withMember,type Client,type Database } from './db.ts';
import { HttpError,type Env } from './env.ts';
import type { Identity } from './auth.ts';
import { clerkInvitations,type InvitationProvider } from './staff-invitations.ts';
const Create=z.strictObject({request_id:IdSchema,donor_id:IdSchema,requested:z.literal(true)});
const fields='id,donor_id,email,state,expires_at';
export function donorInvitations(env:Env,db:Database,verify:(h:string|undefined)=>Promise<Identity>,provider:InvitationProvider=clerkInvitations(env)){
  const router=Router();const admin=<T>(identity:Identity,run:(c:Client,actor:string)=>Promise<T>)=>withMember(db,env.CIC_ORG_ID,identity,async(c,m)=>{if(m.role!=='admin')throw new HttpError(403);return run(c,m.id);});
  const audit=(c:Client,actor:string,id:string,action:string,status='success')=>c.query('INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,$3,$4,$5)',[env.CIC_ORG_ID,actor,action,id,status]);
  router.get('/',async(req,res)=>{const identity=await verify(req.get('Authorization'));res.json({items:await admin(identity,async c=>(await c.query(`SELECT ${fields} FROM donor_feed_invitations ORDER BY created_at DESC LIMIT 200`)).rows)});});
  router.post('/',async(req,res)=>{
    const identity=await verify(req.get('Authorization')),parsed=Create.safeParse(req.body);if(!parsed.success)throw new HttpError(400);const input=parsed.data;
    const prepared=await admin(identity,async(c,actor)=>{
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1||':donor-invites',0))",[env.CIC_ORG_ID]);
      const donor=(await c.query('SELECT email FROM donors WHERE id=$1',[input.donor_id])).rows[0];if(!donor)throw new HttpError(404);
      const email=z.email().safeParse(String(donor.email??'').trim().toLowerCase());if(!email.success)throw new HttpError(400);
      const prior=(await c.query(`SELECT ${fields} FROM donor_feed_invitations WHERE id=$1 FOR UPDATE`,[input.request_id])).rows[0];
      if(prior){if(prior.donor_id!==input.donor_id||prior.email!==email.data)throw new HttpError(409);if(prior.state==='sent')return {attempt:false,row:prior};if(prior.state!=='failed')throw new HttpError(409);}
      const count=(await c.query("SELECT count(*)::int n FROM audit_events WHERE actor_id=$1 AND action='impact.invitation.request' AND created_at>now()-interval '1 hour'",[actor])).rows[0];if(Number(count.n)>=10)throw new HttpError(429);
      const row=prior?(await c.query(`UPDATE donor_feed_invitations SET state='queued',clerk_id=null,expires_at=now()+interval '7 days' WHERE id=$1 RETURNING ${fields}`,[input.request_id])).rows[0]
        :(await c.query(`INSERT INTO donor_feed_invitations(org_id,id,donor_id,email,requested_by) VALUES($1,$2,$3,$4,$5) RETURNING ${fields}`,[env.CIC_ORG_ID,input.request_id,input.donor_id,email.data,actor])).rows[0];
      await audit(c,actor,input.request_id,'impact.invitation.request');return {attempt:true,row};
    });if(!prepared.attempt){res.json(prepared.row);return;}
    let delivered:{id:string};try{delivered=await provider.send(String(prepared.row.email),`${env.APP_ORIGIN}/impact`);}
    catch{await admin(identity,async(c,actor)=>{await c.query("UPDATE donor_feed_invitations SET state='failed' WHERE id=$1 AND state='queued'",[input.request_id]);await audit(c,actor,input.request_id,'impact.invitation.delivery','failure');});throw new HttpError(503);}
    const saved=await admin(identity,async(c,actor)=>{const row=(await c.query(`UPDATE donor_feed_invitations SET state='sent',clerk_id=$2 WHERE id=$1 AND state='queued' RETURNING ${fields}`,[input.request_id,delivered.id])).rows[0];if(row)await audit(c,actor,input.request_id,'impact.invitation.delivery');return row;});
    if(!saved){try{await provider.revoke(delivered.id);}catch{}throw new HttpError(409);}res.status(201).json(saved);
  });
  router.post('/:id/revoke',async(req,res)=>{
    const identity=await verify(req.get('Authorization')),id=IdSchema.safeParse(req.params.id);if(!id.success)throw new HttpError(400);
    const saved=await admin(identity,async(c,actor)=>{const current=(await c.query(`SELECT ${fields},clerk_id FROM donor_feed_invitations WHERE id=$1 FOR UPDATE`,[id.data])).rows[0];if(!current)throw new HttpError(404);
      const row=(await c.query(`UPDATE donor_feed_invitations SET state='revoked' WHERE id=$1 RETURNING ${fields}`,[id.data])).rows[0];await audit(c,actor,id.data,'impact.invitation.revoke');return {row,clerk:current.clerk_id};});
    if(saved.clerk)try{await provider.revoke(String(saved.clerk));}catch{throw new HttpError(503);}res.json(saved.row);
  });return router;
}
