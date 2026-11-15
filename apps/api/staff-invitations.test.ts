import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express,{type ErrorRequestHandler} from 'express';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import { staffInvitations,type InvitationProvider } from './staff-invitations.ts';
import { EnvSchema,HttpError } from './env.ts';
import type { Database } from './db.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('explicit admin invitations persist intent before delivery, isolate failures, replay safely and revoke grants first',async t=>{
  const sql=new PGlite();t.after(()=>sql.close());
  await migrate({query:async(q,v)=>v?sql.query(q,v):(await sql.exec(q)).at(-1)!},fileURLToPath(new URL('../../db/migrations/',import.meta.url)));
  await sql.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES('${id(10)}','${id(1)}','admin','admin'),('${id(11)}','${id(1)}','board','board');
    CREATE ROLE invite_test NOLOGIN NOINHERIT;GRANT cic_runtime TO invite_test;SET SESSION AUTHORIZATION invite_test;`);
  let inTransaction=false,sends=0,revokes=0,failSend=true,failRevoke=false;
  const db:Database={connect:async()=>({query:async(q,v)=>{if(q==='BEGIN')inTransaction=true;
    const result=await sql.query<Record<string,unknown>>(q,v);if(q==='COMMIT'||q==='ROLLBACK')inTransaction=false;return result;},release(){}})};
  const provider:InvitationProvider={send:async(email,redirect)=>{
    assert.equal(inTransaction,false);sends++;assert.equal(email,'staff@example.org');assert.equal(redirect,'http://localhost:4200/sign-up');
    if(failSend)throw new Error('SECRET upstream');return {id:'inv_sent'};
  },revoke:async()=>{assert.equal(inTransaction,false);revokes++;if(failRevoke)throw new Error('SECRET');}};
  const env=EnvSchema.parse({DATABASE_URL:'postgresql://localhost/test',CIC_ORG_ID:id(1),CLERK_SECRET_KEY:'sk_test_fixture',
    CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev',APP_ORIGIN:'http://localhost:4200'});
  const app=express();app.use(express.json(),staffInvitations(env,db,async h=>{const who=h?.replace('Bearer ','')??'none';return {subject:who==='no-mfa'?'admin':who,mfa:who!=='no-mfa'};},provider));
  const errors:ErrorRequestHandler=(e,_req,res,_next)=>res.status(e instanceof HttpError?e.status:503).json({error:'rejected'});app.use(errors);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const a=server.address();assert.ok(a&&typeof a!=='string');
  const call=(method='GET',path='/',body?:unknown,who='admin')=>fetch(`http://127.0.0.1:${a.port}${path}`,{method,headers:{Authorization:`Bearer ${who}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const body={request_id:id(50),email:' Staff@Example.org '};
  for(const who of ['board','no-mfa'])assert.equal((await call('POST','/',body,who)).status,403);
  assert.equal(sends,0);assert.equal((await call('POST','/',{...body,email:'invalid'})).status,400);
  const failed=await call('POST','/',body);assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('SECRET'));
  let listed=(await (await call()).json()).items;assert.equal(listed[0].state,'failed');assert.equal(listed[0].role,'board');
  assert.equal((await call('GET','/',undefined,'board')).status,403);
  failSend=false;const sent=await call('POST','/',body);assert.equal(sent.status,201);assert.equal((await sent.json()).state,'sent');
  assert.equal(sends,2);assert.equal((await call('POST','/',body)).status,200);assert.equal(sends,2);
  assert.equal((await call('POST','/',{...body,role:'admin'})).status,409);
  assert.equal((await call('POST','/',{...body,request_id:id(51)})).status,409);
  failRevoke=true;assert.equal((await call('POST',`/${id(50)}/revoke`,{})).status,503);assert.equal(revokes,1);
  listed=(await (await call()).json()).items;assert.equal(listed[0].state,'revoked'); // failed provider cleanup never keeps access open
  assert.equal((await call('POST',`/${id(99)}/revoke`,{})).status,404);
  await sql.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');
  const count=(await sql.query<{n:number}>("SELECT count(*)::int n FROM audit_events WHERE action LIKE 'invitation.%'")).rows[0].n;assert.equal(count,5);
  await sql.query("INSERT INTO audit_events(org_id,actor_id,action,target_id,status) SELECT $1,$2,'invitation.request',gen_random_uuid(),'success' FROM generate_series(1,10)",[id(1),id(10)]);
  await sql.exec('SET SESSION AUTHORIZATION invite_test');
  assert.equal((await call('POST','/',{...body,request_id:id(52)})).status,429);assert.equal(sends,2);
});
