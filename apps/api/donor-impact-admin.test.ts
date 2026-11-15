import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express,{type ErrorRequestHandler} from 'express';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import { donorImpactAdmin } from './donor-impact-admin.ts';
import { donorImpact } from './donor-impact.ts';
import { EnvSchema,HttpError } from './env.ts';
import type { Database } from './db.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('admin explicitly invites, verifies/opts in a donor, publishes current facts and revokes independent donor access',async t=>{
  const sql=new PGlite();t.after(()=>sql.close());await migrate({query:async(q,v)=>v?sql.query(q,v):(await sql.exec(q)).at(-1)!},fileURLToPath(new URL('../../db/migrations/',import.meta.url)));
  await sql.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES('${id(10)}','${id(1)}','admin','admin'),('${id(11)}','${id(1)}','board','board');
    INSERT INTO donors(id,org_id,name,email,owner_id) VALUES('${id(20)}','${id(1)}','Synthetic','first@example.org','${id(11)}');
    INSERT INTO programs(id,org_id,title) VALUES('${id(30)}','${id(1)}','Academy');INSERT INTO campaigns(id,org_id,program_id,title) VALUES('${id(31)}','${id(1)}','${id(30)}','Summer');
    INSERT INTO gifts(org_id,donor_id,campaign_id,amount_cents,refund_cents,currency,status,occurred_at,source) VALUES('${id(1)}','${id(20)}','${id(31)}',100,0,'USD','settled',now(),'manual');
    INSERT INTO program_outcomes(id,org_id,program_id,period_from,period_to,metric,value,unit,source,approved_by) VALUES('${id(40)}','${id(1)}','${id(30)}','2026-01-01','2027-01-01','Learners',10,'people','Approved aggregate','${id(10)}');
    CREATE ROLE impact_admin_test NOLOGIN NOINHERIT;GRANT cic_runtime TO impact_admin_test;SET SESSION AUTHORIZATION impact_admin_test;`);
  let transaction=false,sends=0,failSend=true,lookups=0;
  const db:Database={connect:async()=>({query:async(q,v)=>{if(q==='BEGIN')transaction=true;const result=await sql.query<Record<string,unknown>>(q,v);if(q==='COMMIT'||q==='ROLLBACK')transaction=false;return result;},release(){}})};
  const env=EnvSchema.parse({DATABASE_URL:'postgresql://localhost/test',CIC_ORG_ID:id(1),CLERK_SECRET_KEY:'sk_test_fixture',CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev',APP_ORIGIN:'http://localhost:4200'});
  const verify=async(h:string|undefined)=>{const who=h?.replace('Bearer ','')??'none';return {subject:who==='no-mfa'?'admin':who,mfa:who!=='no-mfa',verifiedEmail:`${who.replace('user_','')}@example.org`};};
  const app=express();app.use(express.json(),donorImpactAdmin(env,db,verify,async subject=>{lookups++;return {id:subject,banned:false,locked:false,twoFactorEnabled:false,primaryEmailAddressId:'email',emailAddresses:[{id:'email',emailAddress:`${subject.replace('user_','')}@example.org`,verification:{status:'verified'}}]};},
    {send:async(email,redirect)=>{assert.equal(transaction,false);assert.equal(email,'first@example.org');assert.equal(redirect,`${env.APP_ORIGIN}/impact`);sends++;if(failSend)throw Error('private');return {id:'inv_donor'};},revoke:async()=>{assert.equal(transaction,false);}}),donorImpact(env,db,verify));
  const errors:ErrorRequestHandler=(e,_req,res,_next)=>res.status(e instanceof HttpError?e.status:503).json({error:'rejected'});app.use(errors);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const a=server.address();assert.ok(a&&typeof a!=='string');
  const call=(method='GET',path='/',body?:unknown,who='admin')=>fetch(`http://127.0.0.1:${a.port}${path}`,{method,headers:{Authorization:`Bearer ${who}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const link={donor_id:id(20),clerk_subject:'user_first',opt_in:true};
  for(const who of ['board','no-mfa','user_first'])assert.equal((await call('POST','/access',link,who)).status,403);assert.equal(lookups,0);
  assert.equal((await call('POST','/access',{...link,opt_in:false})).status,400);
  assert.equal((await call('POST','/access',{...link,clerk_subject:'user_other'})).status,400);
  const invite={donor_id:id(20),request_id:id(50),requested:true};
  assert.equal((await call('POST','/invitations',invite)).status,503);assert.equal((await call('GET','/',undefined,'user_first')).status,403);
  failSend=false;assert.equal((await call('POST','/invitations',invite)).status,201);assert.equal((await call('POST','/invitations',invite)).status,200);assert.equal(sends,2);
  assert.equal((await call('GET','/',undefined,'user_first')).status,403); // delivery alone never links an identity
  assert.equal((await call('POST','/access',link)).status,200);
  let feed=await (await call('GET','/',undefined,'user_first')).json();assert.equal(feed.gifts.length,1);assert.deepEqual(feed.outcomes,[]);
  assert.equal((await call('POST',`/outcomes/${id(40)}/publication`,{published:true},'board')).status,403);
  assert.equal((await call('POST',`/outcomes/${id(40)}/publication`,{published:true})).status,200);
  feed=await (await call('GET','/',undefined,'user_first')).json();assert.equal(feed.outcomes[0].metric,'Learners');
  assert.equal((await call('POST',`/outcomes/${id(40)}/publication`,{published:false})).status,200);
  assert.deepEqual((await (await call('GET','/',undefined,'user_first')).json()).outcomes,[]);
  assert.equal((await call('POST',`/access/${id(20)}/revoke`,{})).status,200);assert.equal((await call('GET','/',undefined,'user_first')).status,403);
  await sql.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');assert.equal((await sql.query("SELECT * FROM memberships WHERE clerk_subject='user_first'")).rows.length,0);
});
