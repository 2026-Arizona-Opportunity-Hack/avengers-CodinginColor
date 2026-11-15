import type { Identity } from './auth.ts';
import type { Database } from './db.ts';

/** Bootstrap only from the verifier's primary email. The HTTP request cannot choose email or role. */
export async function claimInvitation(db:Database,org:string,identity:Identity){
  if(!identity.verifiedEmail)return;
  const client=await db.connect();let destroy=false;
  try{
    await client.query('BEGIN');await client.query('SET LOCAL ROLE cic_runtime');
    await client.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true)",[org,identity.subject]);
    await client.query('SELECT public.claim_staff_invitation($1)',[identity.verifiedEmail]);
    await client.query('COMMIT');
  }catch(error){try{await client.query('ROLLBACK');}catch{destroy=true;}throw error;}
  finally{client.release(destroy);}
}
