import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express,{type ErrorRequestHandler} from 'express';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import { members } from './members.ts';
import { EnvSchema,HttpError } from './env.ts';
import type { Database } from './db.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('member administration scopes identity and changes atomically under the restricted role',async t=>{
  const sql=new PGlite();t.after(()=>sql.close());
  await migrate({query:async(q,v)=>v?sql.query(q,v):(await sql.exec(q)).at(-1)!},fileURLToPath(new URL('../../db/migrations/',import.meta.url)));
  await sql.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC'),('${id(2)}','Other');
    INSERT INTO memberships(id,org_id,clerk_subject,role,active) VALUES
    ('${id(10)}','${id(1)}','admin','admin',true),('${id(11)}','${id(1)}','board','board',true),
    ('${id(12)}','${id(1)}','inactive','board',false),('${id(20)}','${id(2)}','foreign','admin',true);
    INSERT INTO donors(id,org_id,name,owner_id) VALUES('${id(30)}','${id(1)}','Synthetic','${id(11)}');
    CREATE ROLE member_test NOLOGIN NOINHERIT;GRANT cic_runtime TO member_test;SET SESSION AUTHORIZATION member_test;`);
  const db:Database={connect:async()=>({query:(q,v)=>sql.query<Record<string,unknown>>(q,v),release(){}})};
  const env=EnvSchema.parse({DATABASE_URL:'postgresql://localhost/test',CIC_ORG_ID:id(1),CLERK_SECRET_KEY:'sk_test_fixture',
    CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev',APP_ORIGIN:'http://localhost:4200'});
  let lookedUp=0;
  const app=express();app.use(express.json(),members(env,db,async h=>{
    if(!h)throw new HttpError(401);const who=h.replace('Bearer ','');return {subject:who==='no-mfa'?'admin':who,mfa:who!=='no-mfa'};
  },async subject=>{lookedUp++;return {id:subject,banned:false,locked:false,twoFactorEnabled:false,
    primaryEmailAddressId:'email',emailAddresses:[{id:'email',verification:{status:subject==='user_unverified'?'unverified':'verified'}}]};}));
  const errors:ErrorRequestHandler=(e,_req,res,_next)=>res.status(e instanceof HttpError?e.status:503).json({error:'rejected'});app.use(errors);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const a=server.address();assert.ok(a&&typeof a!=='string');
  const call=(method='GET',path='/',body?:unknown,who='admin')=>fetch(`http://127.0.0.1:${a.port}${path}`,{method,
    headers:{Authorization:`Bearer ${who}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const listed=await call();assert.equal(listed.status,200);const rows=(await listed.json()).items;
  assert.equal(rows.length,3);assert.ok(rows.some((m:{active:boolean})=>!m.active));
  for(const who of ['board','inactive','foreign','no-mfa'])assert.equal((await call('GET','/',undefined,who)).status,403);
  const create={clerk_subject:'user_new',role:'board',active:true};
  assert.equal((await call('POST','/',create,'board')).status,403);assert.equal(lookedUp,0);
  assert.equal((await call('POST','/',{...create,clerk_subject:'user_unverified'})).status,400);
  const first=await call('POST','/',create);assert.equal(first.status,201);const created=await first.json();
  assert.equal(created.role,'board');assert.equal((await call('POST','/',create)).status,409);
  assert.equal((await call('PATCH',`/${id(20)}`,{role:'board',active:false})).status,404);
  assert.equal((await call('PATCH',`/${id(10)}`,{role:'board',active:false})).status,409);
  assert.equal((await call('PATCH',`/${id(11)}`,{role:'board',active:false})).status,409);
  assert.equal((await call('PATCH',`/${id(11)}`,{role:'admin',active:true})).status,409);
  assert.equal((await call('PATCH',`/${created.id}`,{role:'admin',active:true},'board')).status,403);
  assert.equal((await call('PATCH',`/${created.id}`,{role:'admin',active:true})).status,200);
  // Inject a failed audit: membership changes must roll back with it.
  await sql.exec(`SET SESSION AUTHORIZATION postgres;RESET ROLE;
    CREATE FUNCTION reject_member_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'test' USING ERRCODE='58000';END$$;
    CREATE TRIGGER reject_member_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_member_audit();
    SET SESSION AUTHORIZATION member_test;`);
  assert.equal((await call('PATCH',`/${created.id}`,{role:'board',active:false})).status,503);
  await sql.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');
  const unchanged=(await sql.query<{role:string;active:boolean}>('SELECT role,active FROM memberships WHERE id=$1',[created.id])).rows[0];
  assert.deepEqual(unchanged,{role:'admin',active:true});
  assert.equal((await sql.query<{n:number}>("SELECT count(*)::int n FROM audit_events WHERE action LIKE 'membership.%'")).rows[0].n,2);
  await sql.exec('SET SESSION AUTHORIZATION member_test;SET ROLE cic_runtime');
  await assert.rejects(sql.query("UPDATE memberships SET active=false"),/permission denied/);
});
