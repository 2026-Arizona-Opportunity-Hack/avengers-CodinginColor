import { Router } from 'express';
import { createClerkClient } from '@clerk/backend';
import { z } from 'zod';
import { IdSchema } from '../../packages/contracts/index.ts';
import { withMember,type Client,type Database } from './db.ts';
import { HttpError,type Env } from './env.ts';
import type { Identity } from './auth.ts';

export interface InvitationProvider {
  send(email:string,redirect:string):Promise<{id:string}>;
  revoke(id:string):Promise<unknown>;
}
export function clerkInvitations(env:Env):InvitationProvider {
  const clerk=createClerkClient({secretKey:env.CLERK_SECRET_KEY});
  return {
    send:(emailAddress,redirectUrl)=>clerk.invitations.createInvitation({emailAddress,redirectUrl,
      notify:true,expiresInDays:7,ignoreExisting:true}),
    revoke:id=>clerk.invitations.revokeInvitation(id),
  };
}
const Create=z.strictObject({request_id:IdSchema,email:z.string().trim().toLowerCase().max(320).pipe(z.email()),
  role:z.enum(['board','admin']).default('board')});
const fields='id,email,role,state,expires_at';
export function staffInvitations(env:Env,db:Database,verify:(h:string|undefined)=>Promise<Identity>,
  provider:InvitationProvider=clerkInvitations(env)){
  const router=Router();
  const admin=<T>(identity:Identity,run:(c:Client,actor:string)=>Promise<T>)=>withMember(db,env.CIC_ORG_ID,identity,async(c,m)=>{
    if(m.role!=='admin')throw new HttpError(403);return run(c,m.id);
  });
  const audit=(c:Client,actor:string,id:string,action:string,status='success')=>c.query(
    'INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,$3,$4,$5)',[env.CIC_ORG_ID,actor,action,id,status]);
  router.get('/',async(req,res)=>{
    const identity=await verify(req.get('Authorization'));
    res.json({items:await admin(identity,async c=>(await c.query(`SELECT ${fields} FROM staff_invitations ORDER BY created_at DESC,id LIMIT 200`)).rows)});
  });
  router.post('/',async(req,res)=>{
    const identity=await verify(req.get('Authorization')),parsed=Create.safeParse(req.body);
    if(!parsed.success)throw new HttpError(400);const input=parsed.data;
    const prepared=await admin(identity,async(c,actor)=>{
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1||':staff-invites',0))",[env.CIC_ORG_ID]);
      const prior=(await c.query(`SELECT ${fields} FROM staff_invitations WHERE id=$1 FOR UPDATE`,[input.request_id])).rows[0];
      if(prior){
        if(prior.email!==input.email||prior.role!==input.role)throw new HttpError(409);
        if(prior.state==='sent')return {attempt:false,row:prior};
        if(prior.state!=='failed')throw new HttpError(409);
      }
      const attempts=(await c.query(`SELECT count(*)::int n FROM audit_events WHERE actor_id=$1
        AND action='invitation.request' AND created_at>now()-interval '1 hour'`,[actor])).rows[0];
      if(Number(attempts.n)>=10)throw new HttpError(429);
      await c.query("UPDATE staff_invitations SET state='revoked' WHERE email=$1 AND state IN('queued','sent') AND expires_at<=now()",[input.email]);
      if(!prior&&(await c.query("SELECT id FROM staff_invitations WHERE email=$1 AND state IN('queued','sent')",[input.email])).rows.length)throw new HttpError(409);
      const row=prior?(await c.query(`UPDATE staff_invitations SET state='queued',clerk_id=null,expires_at=now()+interval '7 days'
        WHERE id=$1 RETURNING ${fields}`,[input.request_id])).rows[0]:(await c.query(`INSERT INTO staff_invitations(id,org_id,email,role,requested_by)
        VALUES($1,$2,$3,$4,$5) RETURNING ${fields}`,[input.request_id,env.CIC_ORG_ID,input.email,input.role,actor])).rows[0];
      await audit(c,actor,input.request_id,'invitation.request');return {attempt:true,row};
    });
    if(!prepared.attempt){res.json(prepared.row);return;}
    let delivered:{id:string};
    try{delivered=await provider.send(input.email,`${env.APP_ORIGIN}/sign-up`);}
    catch{
      await admin(identity,async(c,actor)=>{
        await c.query("UPDATE staff_invitations SET state='failed' WHERE id=$1 AND state='queued'",[input.request_id]);
        await audit(c,actor,input.request_id,'invitation.delivery','failure');
      });throw new HttpError(503);
    }
    const saved=await admin(identity,async(c,actor)=>{
      const row=(await c.query(`UPDATE staff_invitations SET state='sent',clerk_id=$2 WHERE id=$1 AND state='queued' RETURNING ${fields}`,[input.request_id,delivered.id])).rows[0];
      if(row)await audit(c,actor,input.request_id,'invitation.delivery');return row;
    });
    if(!saved){try{await provider.revoke(delivered.id);}catch{/* DB intent remains closed even if provider cleanup fails. */}throw new HttpError(409);}
    res.status(201).json(saved);
  });
  router.post('/:id/revoke',async(req,res)=>{
    const identity=await verify(req.get('Authorization')),id=IdSchema.safeParse(req.params.id);
    if(!id.success)throw new HttpError(400);
    const result=await admin(identity,async(c,actor)=>{
      const current=(await c.query(`SELECT ${fields},clerk_id FROM staff_invitations WHERE id=$1 FOR UPDATE`,[id.data])).rows[0];
      if(!current)throw new HttpError(404);if(current.state==='claimed')throw new HttpError(409);
      const row=(await c.query(`UPDATE staff_invitations SET state='revoked' WHERE id=$1 RETURNING ${fields}`,[id.data])).rows[0];
      await audit(c,actor,id.data,'invitation.revoke');return {row,clerk:current.clerk_id};
    });
    if(result.clerk)try{await provider.revoke(String(result.clerk));}catch{throw new HttpError(503);}
    res.json(result.row);
  });return router;
}
