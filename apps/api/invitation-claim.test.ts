import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import { createApp } from './app.ts';
import { createVerifier } from './auth.ts';
import { EnvSchema } from './env.ts';
import type { Database } from './db.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const env=EnvSchema.parse({DATABASE_URL:'postgresql://localhost/test',CIC_ORG_ID:id(1),CLERK_SECRET_KEY:'sk_test_fixture',
  CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev',APP_ORIGIN:'http://localhost:4200'});

test('verified identity carries only its verified primary email from the trusted Clerk instance',async()=>{
  const user={id:'user_new',banned:false,locked:false,twoFactorEnabled:false,primaryEmailAddressId:'primary',emailAddresses:[
    {id:'primary',emailAddress:'Actual@Example.org',verification:{status:'verified'}},
    {id:'secondary',emailAddress:'someone-else@example.org',verification:{status:'verified'}}]};
  const verify=createVerifier(env,{verify:async()=>({sub:'user_new',sid:'session',iss:env.CLERK_JWT_ISSUER,azp:env.APP_ORIGIN}),
    session:async()=>({status:'active',userId:'user_new',expireAt:Date.now()+60000}),user:async()=>user});
  assert.equal((await verify('Bearer token')).verifiedEmail,'actual@example.org');
  user.emailAddresses[0].verification.status='unverified';await assert.rejects(verify('Bearer token'),{status:401});
});

test('only sent unexpired same-org exact-primary invitations bootstrap membership and inactive access stays blocked',async t=>{
  const sql=new PGlite();t.after(()=>sql.close());
  await migrate({query:async(q,v)=>v?sql.query(q,v):(await sql.exec(q)).at(-1)!},fileURLToPath(new URL('../../db/migrations/',import.meta.url)));
  await sql.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC'),('${id(2)}','Other');
    INSERT INTO memberships(id,org_id,clerk_subject,role,active) VALUES('${id(10)}','${id(1)}','admin','admin',true),
    ('${id(11)}','${id(1)}','inactive','board',false),('${id(20)}','${id(2)}','foreign','admin',true);
    INSERT INTO staff_invitations(id,org_id,email,role,state,clerk_id,requested_by,expires_at) VALUES
    ('${id(50)}','${id(1)}','new@example.org','board','sent','inv_50','${id(10)}',now()+interval '1 day'),
    ('${id(51)}','${id(1)}','failed@example.org','board','failed',null,'${id(10)}',now()+interval '1 day'),
    ('${id(52)}','${id(1)}','revoked@example.org','admin','revoked','inv_52','${id(10)}',now()+interval '1 day'),
    ('${id(53)}','${id(1)}','expired@example.org','admin','sent','inv_53','${id(10)}',now()-interval '1 day'),
    ('${id(54)}','${id(2)}','other@example.org','admin','sent','inv_54','${id(20)}',now()+interval '1 day'),
    ('${id(55)}','${id(1)}','inactive@example.org','admin','sent','inv_55','${id(10)}',now()+interval '1 day'),
    ('${id(56)}','${id(1)}','newadmin@example.org','admin','sent','inv_56','${id(10)}',now()+interval '1 day');
    CREATE ROLE claim_test NOLOGIN NOINHERIT;GRANT cic_runtime TO claim_test;SET SESSION AUTHORIZATION claim_test;`);
  const db:Database={connect:async()=>({query:(q,v)=>sql.query<Record<string,unknown>>(q,v),release(){}})};
  const app=createApp(env,db,async h=>{const who=h?.replace('Bearer ','')??'missing';return {
    subject:who,mfa:false,...(who!=='missing'?{verifiedEmail:`${who}@example.org`}:{})};});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const a=server.address();assert.ok(a&&typeof a!=='string');
  const me=(who:string)=>fetch(`http://127.0.0.1:${a.port}/api/v1/me?role=admin&email=new@example.org`,{headers:{Authorization:`Bearer ${who}`}});
  for(const who of ['missing','failed','revoked','expired','other','inactive'])assert.equal((await me(who)).status,403,who);
  const accepted=await me('new');assert.equal(accepted.status,200);assert.equal((await accepted.json()).role,'board');
  assert.equal((await me('new')).status,200);assert.equal((await me('newadmin')).status,403); // admin still needs MFA
  await sql.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');
  assert.equal((await sql.query<{n:number}>("SELECT count(*)::int n FROM memberships WHERE org_id=$1",[id(1)])).rows[0].n,4);
  assert.equal((await sql.query<{n:number}>("SELECT count(*)::int n FROM audit_events WHERE action='membership.invite_claim'")).rows[0].n,2);
  const inactive=(await sql.query<{active:boolean;role:string}>("SELECT active,role FROM memberships WHERE clerk_subject='inactive'")).rows[0];
  assert.deepEqual(inactive,{active:false,role:'board'});
  await sql.exec('SET SESSION AUTHORIZATION claim_test;SET ROLE cic_runtime');
  await sql.query("SELECT set_config('app.org_id',$1,false),set_config('app.user_id','new',false)",[id(1)]);
  assert.equal((await sql.query('SELECT * FROM staff_invitations')).rows.length,0);
});
