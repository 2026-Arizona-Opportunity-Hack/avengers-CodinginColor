import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import { donors } from './donors.ts';
import { EnvSchema, HttpError } from './env.ts';
import type { Database } from './db.ts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('manual request retries return only the original IDs and bind actor/exact facts', async t => {
  const sql = new PGlite(); t.after(()=>sql.close());
  await migrate({ query: async (q,v) => v ? sql.query(q,v) : (await sql.exec(q)).at(-1)! },
    fileURLToPath(new URL('../../db/migrations/',import.meta.url)));
  await sql.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES('${id(10)}','${id(1)}','admin','admin'),
      ('${id(11)}','${id(1)}','board','board');
    CREATE ROLE request_test NOLOGIN NOINHERIT; GRANT cic_runtime TO request_test;
    SET SESSION AUTHORIZATION request_test;`);
  const db:Database = {connect:async()=>({query:(q,v)=>sql.query<Record<string,unknown>>(q,v),release(){}})};
  const env=EnvSchema.parse({DATABASE_URL:'postgresql://localhost/test',CIC_ORG_ID:id(1),CLERK_SECRET_KEY:'sk_test_fixture',
    CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev',APP_ORIGIN:'http://localhost:4200'});
  const app=express(); app.use(express.json(),donors(env,db,async h=>{
    if(!h)throw new HttpError(401);return {subject:h.replace('Bearer ',''),mfa:true};
  }));
  const errors:ErrorRequestHandler=(e,_req,res,_next)=>res.status(e instanceof HttpError?e.status:503).json({error:'rejected'});
  app.use(errors); const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const a=server.address();assert.ok(a&&typeof a!=='string');
  const body={request_id:id(50),name:'Avery',email:'avery@example.org',consent:'unknown',metadata:{kind:'individual'}};
  const post=(value:unknown=body,who='admin')=>fetch(`http://127.0.0.1:${a.port}/`,{method:'POST',
    headers:{Authorization:`Bearer ${who}`,'Content-Type':'application/json'},body:JSON.stringify(value)});
  const first=await post(); assert.equal(first.status,201); const created=await first.json();
  const retry=await post(); assert.equal(retry.status,200); assert.deepEqual(await retry.json(),created);
  assert.deepEqual(Object.keys(created).sort(),['id','owner_id']);
  assert.equal((await post({...body,name:'Changed'})).status,409);
  assert.equal((await post({...body,request_id:'bad'})).status,400);
  const otherActor=await post(body,'board'); assert.equal(otherActor.status,201);
  assert.notEqual((await otherActor.json()).id,created.id);
  assert.equal((await post(body,'unknown')).status,403);
  // A failing transaction cannot leave a replay entry or advance ownership/creation.
  await sql.exec(`SET SESSION AUTHORIZATION postgres;RESET ROLE;
    CREATE FUNCTION reject_manual_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE='58000'; END $$;
    CREATE TRIGGER reject_manual_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_manual_audit();
    SET SESSION AUTHORIZATION request_test;`);
  assert.equal((await post({...body,request_id:id(51)})).status,503);
  await sql.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');
  assert.equal((await sql.query<{n:number}>('SELECT count(*)::int AS n FROM donors')).rows[0].n,2);
  assert.equal((await sql.query<{n:number}>('SELECT count(*)::int AS n FROM manual_donor_requests')).rows[0].n,2);
  await sql.exec('SET SESSION AUTHORIZATION request_test;SET ROLE cic_runtime');
  await assert.rejects(sql.query('SELECT * FROM manual_donor_requests'),/permission denied/);
});
