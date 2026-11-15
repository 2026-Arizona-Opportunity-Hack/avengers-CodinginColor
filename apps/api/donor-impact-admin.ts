import { Router } from 'express';
import { z } from 'zod';
import { IdSchema } from '../../packages/contracts/index.ts';
import { withMember,type Client,type Database } from './db.ts';
import { HttpError,type Env } from './env.ts';
import { clerkProvider,type AuthProvider,type Identity } from './auth.ts';
import type { InvitationProvider } from './staff-invitations.ts';
import { donorInvitations } from './donor-invitations.ts';
const Link=z.strictObject({donor_id:IdSchema,clerk_subject:z.string().regex(/^user_[A-Za-z0-9]+$/).max(200),opt_in:z.literal(true)});
export function donorImpactAdmin(env:Env,db:Database,verify:(h:string|undefined)=>Promise<Identity>,lookup:AuthProvider['user']=id=>clerkProvider(env).user(id),invitations?:InvitationProvider){
  const router=Router();
  const admin=<T>(identity:Identity,run:(c:Client,actor:string)=>Promise<T>)=>withMember(db,env.CIC_ORG_ID,identity,async(c,m)=>{if(m.role!=='admin')throw new HttpError(403);return run(c,m.id);});
  const audit=(c:Client,actor:string,id:string,action:string)=>c.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) VALUES($1,$2,$3,$4,'success')",[env.CIC_ORG_ID,actor,action,id]);
  router.get('/access',async(req,res)=>{const identity=await verify(req.get('Authorization'));res.json({items:await admin(identity,async c=>(await c.query('SELECT donor_id,clerk_subject,active,opted_in FROM donor_feed_access ORDER BY updated_at DESC LIMIT 200')).rows)});});
  router.post('/access',async(req,res)=>{
    const identity=await verify(req.get('Authorization')),parsed=Link.safeParse(req.body);if(!parsed.success)throw new HttpError(400);
    await admin(identity,async()=>{});let user;try{user=await lookup(parsed.data.clerk_subject);}catch{throw new HttpError(503);}
    const primary=user.emailAddresses.find(e=>e.id===user.primaryEmailAddressId&&e.verification?.status==='verified');
    if(user.id!==parsed.data.clerk_subject||user.banned||user.locked||!primary?.emailAddress)throw new HttpError(400);
    const email=primary.emailAddress.trim().toLowerCase();
    try{const saved=await admin(identity,async(c,actor)=>{
      const donor=(await c.query('SELECT email FROM donors WHERE id=$1 FOR UPDATE',[parsed.data.donor_id])).rows[0];
      if(!donor)throw new HttpError(404);if(String(donor.email??'').trim().toLowerCase()!==email)throw new HttpError(400);
      const row=(await c.query(`INSERT INTO donor_feed_access(org_id,donor_id,clerk_subject,verified_email,active,opted_in,granted_by)
        VALUES($1,$2,$3,$4,true,true,$5) ON CONFLICT(org_id,donor_id) DO UPDATE SET clerk_subject=EXCLUDED.clerk_subject,
        verified_email=EXCLUDED.verified_email,active=true,opted_in=true,granted_by=EXCLUDED.granted_by,updated_at=now()
        RETURNING donor_id,clerk_subject,active,opted_in`,[env.CIC_ORG_ID,parsed.data.donor_id,user.id,email,actor])).rows[0];
      await audit(c,actor,parsed.data.donor_id,'impact.access.grant');return row;
    });res.json(saved);}catch(error){if((error as {code?:string}).code==='23505')throw new HttpError(409);throw error;}
  });
  router.post('/access/:id/revoke',async(req,res)=>{
    const identity=await verify(req.get('Authorization')),id=IdSchema.safeParse(req.params.id);if(!id.success)throw new HttpError(400);
    res.json(await admin(identity,async(c,actor)=>{
      const row=(await c.query('UPDATE donor_feed_access SET active=false,opted_in=false,updated_at=now() WHERE donor_id=$1 RETURNING donor_id,active,opted_in',[id.data])).rows[0];
      if(!row)throw new HttpError(404);await audit(c,actor,id.data,'impact.access.revoke');return row;
    }));
  });
  router.get('/outcomes',async(req,res)=>{
    const identity=await verify(req.get('Authorization'));res.json({items:await admin(identity,async c=>(await c.query(`SELECT o.id,p.title AS program,o.metric,o.value::text,o.unit,
      to_char(o.period_from AT TIME ZONE 'America/Phoenix','YYYY-MM-DD') AS period_from,to_char(o.period_to AT TIME ZONE 'America/Phoenix','YYYY-MM-DD') AS period_to,
      coalesce(pub.approved_at=o.approved_at,false) AS published FROM program_outcomes o JOIN programs p ON p.org_id=o.org_id AND p.id=o.program_id
      LEFT JOIN donor_outcome_publications pub ON pub.org_id=o.org_id AND pub.outcome_id=o.id ORDER BY o.period_to DESC,o.id LIMIT 200`)).rows)});
  });
  router.post('/outcomes/:id/publication',async(req,res)=>{
    const identity=await verify(req.get('Authorization')),id=IdSchema.safeParse(req.params.id),parsed=z.strictObject({published:z.boolean()}).safeParse(req.body);
    if(!id.success||!parsed.success)throw new HttpError(400);
    await admin(identity,async(c,actor)=>{
      const outcome=(await c.query('SELECT id FROM program_outcomes WHERE id=$1 FOR UPDATE',[id.data])).rows[0];if(!outcome)throw new HttpError(404);
      if(parsed.data.published)await c.query(`INSERT INTO donor_outcome_publications(org_id,outcome_id,approved_at,published_by)
        SELECT org_id,id,approved_at,$2 FROM program_outcomes WHERE id=$1 ON CONFLICT(org_id,outcome_id) DO UPDATE
        SET approved_at=EXCLUDED.approved_at,published_by=EXCLUDED.published_by,published_at=now()`,[id.data,actor]);
      else await c.query('DELETE FROM donor_outcome_publications WHERE outcome_id=$1',[id.data]);
      await audit(c,actor,id.data,parsed.data.published?'impact.outcome.publish':'impact.outcome.unpublish');
    });res.json({published:parsed.data.published});
  });
  router.use('/invitations',donorInvitations(env,db,verify,invitations));return router;
}
