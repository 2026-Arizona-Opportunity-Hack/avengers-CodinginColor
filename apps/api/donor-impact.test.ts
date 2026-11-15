import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express,{type ErrorRequestHandler} from 'express';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import { donorImpact } from './donor-impact.ts';
import { EnvSchema,HttpError } from './env.ts';
import type { Database } from './db.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('donor impact is separate from staff and exposes only own gifts and explicitly published current outcomes',async t=>{
  const sql=new PGlite();t.after(()=>sql.close());
  await migrate({query:async(q,v)=>v?sql.query(q,v):(await sql.exec(q)).at(-1)!},fileURLToPath(new URL('../../db/migrations/',import.meta.url)));
  await sql.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC'),('${id(2)}','Other');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES('${id(10)}','${id(1)}','staff','admin');
    INSERT INTO donors(id,org_id,name,email) VALUES('${id(20)}','${id(1)}','Private first','first@example.org'),
      ('${id(21)}','${id(1)}','Private second','second@example.org'),('${id(22)}','${id(2)}','Foreign private','foreign@example.org');
    INSERT INTO programs(id,org_id,title) VALUES('${id(30)}','${id(1)}','Academy');
    INSERT INTO campaigns(id,org_id,program_id,title) VALUES('${id(31)}','${id(1)}','${id(30)}','Summer');
    INSERT INTO gifts(org_id,donor_id,campaign_id,amount_cents,refund_cents,currency,status,occurred_at,source,external_id)
      VALUES('${id(1)}','${id(20)}','${id(31)}',12345,345,'USD','settled',now(),'manual','PRIVATE-ID'),
      ('${id(1)}','${id(21)}','${id(31)}',9900,0,'USD','settled',now(),'manual','OTHER-ID');
    INSERT INTO donor_feed_access(org_id,donor_id,clerk_subject,verified_email,active,opted_in,granted_by)
      VALUES('${id(1)}','${id(20)}','first','first@example.org',true,true,'${id(10)}'),
      ('${id(1)}','${id(21)}','second','second@example.org',true,false,'${id(10)}');
    INSERT INTO program_outcomes(id,org_id,program_id,period_from,period_to,metric,value,unit,source,approved_by)
      VALUES('${id(40)}','${id(1)}','${id(30)}','2026-01-01','2027-01-01','Learners',12,'people','PRIVATE-SOURCE','${id(10)}'),
      ('${id(41)}','${id(1)}','${id(30)}','2026-01-01','2027-01-01','Unpublished',99,'people','INTERNAL','${id(10)}');
    INSERT INTO donor_outcome_publications(org_id,outcome_id,approved_at,published_by)
      SELECT org_id,id,approved_at,'${id(10)}' FROM program_outcomes WHERE id='${id(40)}';
    CREATE ROLE impact_test NOLOGIN NOINHERIT;GRANT cic_runtime TO impact_test;SET SESSION AUTHORIZATION impact_test;`);
  const db:Database={connect:async()=>({query:(q,v)=>sql.query<Record<string,unknown>>(q,v),release(){}})};
  const env=EnvSchema.parse({DATABASE_URL:'postgresql://localhost/test',CIC_ORG_ID:id(1),CLERK_SECRET_KEY:'sk_test_fixture',CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev',APP_ORIGIN:'http://localhost:4200'});
  const app=express();app.use(donorImpact(env,db,async h=>{if(!h)throw new HttpError(401);const subject=h.replace('Bearer ','');
    return {subject:subject==='changed-email'?'first':subject,mfa:false,...(subject==='unverified'?{}:{verifiedEmail:`${subject}@example.org`})};}));
  const errors:ErrorRequestHandler=(e,_req,res,_next)=>res.status(e instanceof HttpError?e.status:503).json({error:'rejected'});app.use(errors);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const a=server.address();assert.ok(a&&typeof a!=='string');const get=(who='first',query='')=>fetch(`http://127.0.0.1:${a.port}/${query}`,{headers:{Authorization:`Bearer ${who}`}});
  for(const who of ['staff','second','foreign','changed-email','unverified'])assert.equal((await get(who)).status,403,who);
  assert.equal((await get('first','?donor_id='+id(21))).status,400);
  const response=await get();assert.equal(response.status,200);const feed=await response.json();assert.equal(feed.gifts.length,1);
  assert.equal(feed.gifts[0].amount_cents,'12345');assert.equal(feed.gifts[0].refund_cents,'345');assert.equal(feed.outcomes.length,1);
  assert.equal(feed.outcomes[0].metric,'Learners');assert.equal(feed.outcomes[0].value,'12');
  const payload=JSON.stringify(feed);for(const secret of ['Private','first@example','second@example','PRIVATE-ID','OTHER-ID','PRIVATE-SOURCE','INTERNAL',id(20),id(21),id(40)])assert.ok(!payload.includes(secret),secret);
  await sql.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');
  assert.equal((await sql.query("SELECT * FROM memberships WHERE clerk_subject='first'")).rows.length,0);
  await sql.query("UPDATE program_outcomes SET value=13,approved_at=approved_at+interval '1 second' WHERE id=$1",[id(40)]);
  await sql.exec('SET SESSION AUTHORIZATION impact_test');assert.deepEqual((await (await get()).json()).outcomes,[]);
  await sql.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');await sql.query("UPDATE donor_feed_access SET active=false WHERE donor_id=$1",[id(20)]);
  await sql.exec('SET SESSION AUTHORIZATION impact_test');assert.equal((await get()).status,403);
});
