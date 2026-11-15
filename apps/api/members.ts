import { Router } from 'express';
import { z } from 'zod';
import { IdSchema } from '../../packages/contracts/index.ts';
import { withMember, type Database } from './db.ts';
import { HttpError, type Env } from './env.ts';
import { clerkProvider, type AuthProvider, type Identity } from './auth.ts';

const Access=z.strictObject({role:z.enum(['admin','board']),active:z.boolean()});
const Create=Access.extend({clerk_subject:z.string().regex(/^user_[A-Za-z0-9]+$/).max(200)});
export function members(env:Env,db:Database,verify:(header:string|undefined)=>Promise<Identity>,
  lookup:AuthProvider['user']=(subject)=>clerkProvider(env).user(subject)) {
  const router=Router();
  const admin=async(identity:Identity)=>withMember(db,env.CIC_ORG_ID,identity,async(_c,m)=>{
    if(m.role!=='admin')throw new HttpError(403);
  });
  router.get('/',async(req,res)=>{
    const identity=await verify(req.get('Authorization'));
    const items=await withMember(db,env.CIC_ORG_ID,identity,async(c,m)=>{
      if(m.role!=='admin')throw new HttpError(403);
      return (await c.query('SELECT * FROM public.admin_members()')).rows;
    });res.json({items});
  });
  const save=async(identity:Identity,id:string|null,subject:string|null,role:string,active:boolean)=>{
    try{return await withMember(db,env.CIC_ORG_ID,identity,async(c,m)=>{
      if(m.role!=='admin')throw new HttpError(403);
      return (await c.query('SELECT * FROM public.manage_member($1,$2,$3,$4)',[id,subject,role,active])).rows[0];
    });}catch(error){
      const code=(error as {code?:string}).code;
      if(code==='42501')throw new HttpError(403);
      if(code==='P0002')throw new HttpError(404);
      if(code==='P0001'||code==='23505')throw new HttpError(409);
      throw error;
    }
  };
  router.post('/',async(req,res)=>{
    const identity=await verify(req.get('Authorization'));const parsed=Create.safeParse(req.body);
    if(!parsed.success)throw new HttpError(400);
    await admin(identity); // Verify authorization before looking up another identity.
    let user;try{user=await lookup(parsed.data.clerk_subject);}catch{throw new HttpError(503);}
    if(user.id!==parsed.data.clerk_subject||user.banned||user.locked||!user.emailAddresses.some(e=>
      e.id===user.primaryEmailAddressId&&e.verification?.status==='verified'))throw new HttpError(400);
    res.status(201).json(await save(identity,null,parsed.data.clerk_subject,parsed.data.role,parsed.data.active));
  });
  router.patch('/:id',async(req,res)=>{
    const identity=await verify(req.get('Authorization'));const id=IdSchema.safeParse(req.params.id),parsed=Access.safeParse(req.body);
    if(!id.success||!parsed.success)throw new HttpError(400);
    res.json(await save(identity,id.data,null,parsed.data.role,parsed.data.active));
  });return router;
}
