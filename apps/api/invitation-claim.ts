import { createClerkClient } from '@clerk/backend';
import type { Identity } from './auth.ts';
import type { Client,Database } from './db.ts';
import { HttpError,type Env } from './env.ts';
export interface InvitationStatus {id:string;emailAddress:string;status:string;revoked?:boolean;}
export type InvitationStatusLookup=(id:string)=>Promise<InvitationStatus|null>;
export function clerkInvitationStatus(env:Env):InvitationStatusLookup{
  const clerk=createClerkClient({secretKey:env.CLERK_SECRET_KEY});
  return async id=>(await clerk.invitations.getInvitationList({query:id,limit:100})).data.find(i=>i.id===id)??null;
}

/** Bootstrap only from verified identity and live provider status, never body fields or metadata. */
export async function claimInvitation(db:Database,org:string,identity:Identity,lookup:InvitationStatusLookup){
  if(!identity.verifiedEmail)return;
  const context=async<T>(run:(client:Client)=>Promise<T>)=>{
    const client=await db.connect();let destroy=false;
    try{
      await client.query('BEGIN');await client.query('SET LOCAL ROLE cic_runtime');
      await client.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true)",[org,identity.subject]);
      const result=await run(client);await client.query('COMMIT');return result;
    }catch(error){try{await client.query('ROLLBACK');}catch{destroy=true;}throw error;}
    finally{client.release(destroy);}
  };
  const pending=await context(async client=>(await client.query('SELECT * FROM public.pending_staff_invitation($1)',[identity.verifiedEmail])).rows[0]);
  if(!pending)return; // Existing active/inactive memberships never depend on invitation-provider availability.
  let current:InvitationStatus|null;
  try{current=await lookup(String(pending.clerk_id));}catch{throw new HttpError(503);}
  if(!current||current.id!==pending.clerk_id||current.revoked||!['pending','accepted'].includes(current.status)
    ||current.emailAddress.trim().toLowerCase()!==identity.verifiedEmail.trim().toLowerCase())return;
  await context(client=>client.query('SELECT public.claim_staff_invitation($1,$2,$3)',[identity.verifiedEmail,pending.id,pending.clerk_id]));
}
