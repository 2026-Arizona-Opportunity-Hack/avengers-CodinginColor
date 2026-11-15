import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Client,Pool} from 'pg';
import {migrate} from '../db/migrate.ts';
import {createApp} from '../apps/api/app.ts';
import {EnvSchema,HttpError} from '../apps/api/env.ts';
test('native overlapping import transactions commit once and reject a stale competing file',
  {skip:!process.env.CIC_NATIVE_TEST_URL},async t=>{
  const url=new URL(process.env.CIC_NATIVE_TEST_URL!);
  assert.equal(url.hostname,'127.0.0.1','Native test requires a disposable loopback database');
  assert.match(url.pathname,/^\/cic_native_[a-f0-9]+$/);
  const owner=new Client({connectionString:url.href}); await owner.connect(); t.after(()=>owner.end());
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0,'Database must be empty');
  await migrate(owner,fileURLToPath(new URL('../db/migrations/',import.meta.url)));
  const org=randomUUID(),admin=randomUUID(),board=randomUUID();
  await owner.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic native import')",[org]);
  await owner.query("INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES($1,$3,'admin','admin'),($2,$3,'board','board')",[admin,board,org]);
  const password=randomBytes(24).toString('hex');
  await owner.query(`CREATE ROLE import_native LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO import_native`);
  const login=new URL(url); login.username='import_native';login.password=password;
  const pool=new Pool({connectionString:login.href,max:6}); t.after(()=>pool.end());
  const env=EnvSchema.parse({DATABASE_URL:login.href,CIC_ORG_ID:org,CLERK_SECRET_KEY:'sk_test_fixture',
    CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev',APP_ORIGIN:'http://localhost:4200'});
  const server=createApp(env,pool,async h=>{if(h!=='Bearer admin') throw new HttpError(401);return {subject:'admin',mfa:true};}).listen(0,'127.0.0.1');
  await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const call=async(path:string,body?:unknown)=>{
    const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/imports${path}`,{method:'POST',headers:{Authorization:'Bearer admin',
      ...(typeof body==='string'?{'Content-Type':'text/csv','X-Import-Source':'zeffy','X-Import-Filename':'test.csv'}:{'Content-Type':'application/json'})},
      body:typeof body==='string'?body:JSON.stringify(body??{})});
    return {status:response.status,body:await response.json() as Record<string,unknown>};
  };
  const csv=(who:string,amount:string)=>`first name,last name,email,donation amount,external id\n${who},Example,${who.toLowerCase()}@example.org,${amount},${who}-tx`;
  const prepare=async(file:string)=>{
    const upload=await call('',file);assert.ok([200,201].includes(upload.status));const id=String(upload.body.batch_id);
    assert.equal((await call(`/${id}/layout`,{batch_values:{currency:'USD',occurred_at:'2026-01-01T01:00:00.123456Z',status:'settled',refund_cents:0}})).status,200);
    const d=await call(`/${id}/donors/plan`);assert.equal(d.status,200);
    assert.equal((await call(`/${id}/donors/review`,{plan_hash:d.body.plan_hash,decisions:[]})).status,200);
    const g=await call(`/${id}/gifts/plan`);assert.equal(g.status,200);
    const hashes={donor_plan_hash:d.body.plan_hash,plan_hash:g.body.plan_hash};
    assert.equal((await call(`/${id}/gifts/review`,{...hashes,decisions:[]})).status,200);
    return {id,hashes};
  };
  const first=await prepare(csv('Avery','12.34'));
  const concurrent=await Promise.all(Array.from({length:6},()=>call(`/${first.id}/commit`,first.hashes)));
  assert.ok(concurrent.every(r=>r.status===200));
  assert.equal(concurrent.filter(r=>r.body.replayed===false).length,1);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM gifts')).rows[0].n,1);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE action='import.commit'")).rows[0].n,1);
  const a=await prepare(csv('Jordan','10.00')),b=await prepare(csv('Jordan','11.00'));
  const race=await Promise.all([call(`/${a.id}/commit`,a.hashes),call(`/${b.id}/commit`,b.hashes)]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM gifts')).rows[0].n,2);
});
