import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import { EnvSchema, HttpError } from './env.ts';
import { groundedDrafts } from './grounded-drafts.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('grounded drafts use authorized facts without external PII, reject stale context and save unapproved atomically', async t => {
  const sql = new PGlite(); t.after(() => sql.close());
  await migrate({query:async(q,v)=>v?sql.query(q,v):(await sql.exec(q)).at(-1)!},fileURLToPath(new URL('../../db/migrations/',import.meta.url)));
  await sql.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES('${id(10)}','${id(1)}','admin','admin'),('${id(11)}','${id(1)}','board','board');
    INSERT INTO programs(id,org_id,title) VALUES('${id(20)}','${id(1)}','Academy');
    INSERT INTO campaigns(id,org_id,program_id,title) VALUES('${id(21)}','${id(1)}','${id(20)}','Academy fund');
    INSERT INTO donors(id,org_id,owner_id,name,email,consent) VALUES('${id(30)}','${id(1)}','${id(11)}','Private Person','private@example.org','granted'),
      ('${id(31)}','${id(1)}',NULL,'Other','other@example.org','granted'),('${id(32)}','${id(1)}','${id(11)}','Denied','denied@example.org','denied');
    INSERT INTO gifts(org_id,donor_id,campaign_id,amount_cents,refund_cents,currency,occurred_at,status,source)
      VALUES('${id(1)}','${id(30)}','${id(21)}',12345,345,'USD','2026-06-01T12:00:00Z','settled','manual');
    INSERT INTO program_outcomes(org_id,program_id,period_from,period_to,metric,value,unit,denominator,source,approved_by)
      VALUES('${id(1)}','${id(20)}','2026-01-01','2027-01-01','Completed',0,'students',10,'Approved aggregate','${id(10)}'),
        ('${id(1)}','${id(20)}','2026-01-01','2027-01-01','Unknown',NULL,'students',NULL,'Approved aggregate','${id(10)}');
    CREATE ROLE grounded_test NOLOGIN NOINHERIT; GRANT cic_runtime TO grounded_test; SET SESSION AUTHORIZATION grounded_test;`);
  let calls = 0;
  const env = EnvSchema.parse({DATABASE_URL:'postgresql://localhost/test',CIC_ORG_ID:id(1),CLERK_SECRET_KEY:'sk_test_fixture',
    CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev',APP_ORIGIN:'http://localhost:4200'});
  const app = express(); app.use(express.json(),groundedDrafts(env,{connect:async()=>({query:(q,v)=>sql.query(q,v),release(){}})},async h => {
    if (!h) throw new HttpError(401); return {subject:h,mfa:true};
  },async request => {
    calls++; const payload = JSON.stringify(request.data);
    for (const secret of ['Private','private@','12345','120.00','Academy','Completed','Approved aggregate',id(30)]) assert.ok(!payload.includes(secret));
    return {opening:'thanks',closing:'questions',fact_ids:['invented_fact']}; // Rejected plan uses grounded fallback.
  }));
  const errors: ErrorRequestHandler = (e,_req,res,_next) => res.status(e instanceof HttpError?e.status:503).json({error:'rejected'}); app.use(errors);
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}); const addr=server.address(); assert.ok(addr&&typeof addr!=='string');
  const input = {donor_id:id(30),program_id:id(20),from:'2026-01-01',to:'2027-01-01'};
  const call = (path: string, body: unknown, who='admin') => fetch(`http://127.0.0.1:${addr.port}/api/v1/drafts/grounded${path}`,{
    method:'POST',headers:{Authorization:who,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await call('/propose',{...input,donor_id:id(31)},'board')).status,404); assert.equal(calls,0);
  assert.equal((await call('/propose',{...input,donor_id:id(32)})).status,409); assert.equal(calls,0);
  const response = await call('/propose',input); assert.equal(response.status,200); const proposal=await response.json();
  assert.match(proposal.body,/USD 120.00/); assert.match(proposal.body,/Completed: 0 students/); assert.doesNotMatch(proposal.body,/Unknown|invented_fact|\u2014/);
  const save = {...input,context_hash:proposal.context_hash,subject:proposal.subject,body:proposal.body};
  assert.equal((await call('',{...save,context_hash:'0'.repeat(64)})).status,409);
  const saved=await call('',save); assert.equal(saved.status,201); const draft=await saved.json();
  assert.equal((await (await call('',save)).json()).id,draft.id,'identical retries reuse the existing unsent draft');
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  const row=(await sql.query<Record<string, unknown>>('SELECT status,approved_at,body FROM drafts WHERE id=$1',[draft.id])).rows[0]; assert.equal(row.status,'draft'); assert.equal(row.approved_at,null);
  assert.match(String(row.body),/Approved aggregate/);
  await sql.exec(`CREATE FUNCTION reject_grounded_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$;
    CREATE TRIGGER reject_grounded_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_grounded_audit();
    SET SESSION AUTHORIZATION grounded_test;`);
  assert.equal((await call('',{...save,body:save.body+'\nEdited by reviewer.'})).status,503);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE'); assert.equal((await sql.query('SELECT id FROM drafts')).rows.length,1);
});
