import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from './app.ts';
import type { Database } from './db.ts';
import { EnvSchema, HttpError } from './env.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
test('donor HTTP routes enforce scope, validation, atomic audit and archive history', async t => {
  const sql = new PGlite();
  t.after(() => sql.close());
  for (const file of ['001_core.sql','002_assignment.sql','003_owner_override.sql'])
    await sql.exec(await readFile(new URL('../../db/migrations/' + file, import.meta.url), 'utf8'));
  await sql.query("INSERT INTO organizations(id,name) VALUES($1,'CIC'),($2,'Other')", [id(1),id(2)]);
  await sql.query("INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES ($1,$4,'board','board'),($2,$4,'other','board'),($3,$4,'admin','admin'),($5,$6,'foreign','board')", [id(3),id(4),id(5),id(1),id(6),id(2)]);
  for (const [n, org, owner, name] of [[10,1,3,'Same'],[11,1,3,'Same'],[12,1,4,'Other'],[13,2,6,'Foreign']] as const)
    await sql.query('INSERT INTO donors(id,org_id,owner_id,name) VALUES($1,$2,$3,$4)', [id(n),id(org),id(owner),name]);
  await sql.query("INSERT INTO gifts(id,org_id,donor_id,amount_cents,refund_cents,currency,occurred_at,status,source) VALUES($1,$2,$3,100,0,'USD',now(),'settled','fixture')", [id(20),id(1),id(10)]);
  await sql.exec('CREATE ROLE donor_test LOGIN NOINHERIT; GRANT cic_runtime TO donor_test; SET SESSION AUTHORIZATION donor_test');
  let failAudit = false;
  const db: Database = { connect: async () => ({
    query: (text, values) => {
      if (failAudit && /INSERT INTO audit_events/i.test(text)) throw new Error('injected audit failure');
      return sql.query<Record<string, unknown>>(text, values);
    }, release: () => {},
  }) };
  const env = EnvSchema.parse({ DATABASE_URL:'postgresql://localhost/test', CIC_ORG_ID:id(1), CLERK_SECRET_KEY:'sk_test_fixture', CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev', APP_ORIGIN:'http://localhost:4200' });
  const server = createApp(env, db, async header => {
    if (header === 'Bearer board') return { subject:'board', mfa:false };
    if (header === 'Bearer other') return { subject:'other', mfa:false };
    if (header === 'Bearer admin') return { subject:'admin', mfa:true };
    throw new HttpError(401);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1/donors`;
  const request = (path = '', options: RequestInit = {}, role = 'board') => fetch(base + path, { ...options, headers: { Authorization:`Bearer ${role}`, ...options.headers } });
  const patch = (value: unknown) => ({ method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value) });
  const post = (value: unknown) => ({ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value) });
  const preflight = await request('', {method:'OPTIONS', headers:{Origin:env.APP_ORIGIN}});
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-methods'),'GET, POST, PATCH');
  assert.equal(preflight.headers.get('access-control-allow-headers'),'Authorization, Content-Type');
  assert.equal((await fetch(base)).status,401);
  let response = await request('?limit=1&offset=1');
  assert.equal(response.status, 200);
  let body = await response.json() as { items: {id:string}[], limit:number, offset:number };
  assert.deepEqual([body.items.map(row => row.id),body.limit,body.offset], [[id(11)],1,1]);
  response = await request('?q=sam&owner_id='+id(3), {}, 'admin');
  body = await response.json() as typeof body;
  assert.deepEqual(body.items.map(row => row.id), [id(10),id(11)]);
  body = await (await request('', {}, 'admin')).json() as typeof body;
  assert.deepEqual(body.items.map(row => row.id), [id(12),id(10),id(11)]);
  assert.equal((await request('/'+id(12), {}, 'admin')).status,200);
  assert.equal((await request('/'+id(13), {}, 'admin')).status,404);
  for (const query of ['?bad=1','?limit=0','?limit=101','?offset=-1','?archived=yes','?owner_id=bad','?q=x&q=y']) assert.equal((await request(query)).status,400,query);
  for (const target of [id(12),id(13)]) {
    assert.equal((await request('/'+target)).status,404);
    assert.equal((await request('/'+target,patch({name:'No'}))).status,404);
    assert.equal((await request('/'+target+'/archive',{method:'POST'})).status,404);
  }
  assert.equal((await request('/bad')).status,400);
  for (const value of [{}, {owner_id:id(4)}, {org_id:id(2)}, {id:id(12)}, {role:'admin'}, {archived_at:null}, {name:''}])
    assert.equal((await request('/'+id(10),patch(value))).status,400,JSON.stringify(value));
  assert.equal((await request('/'+id(10), {method:'PATCH', headers:{'Content-Type':'application/json'}, body:'{'})).status,400);
  assert.equal((await request('/'+id(10), {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'x'.repeat(33000)})})).status,413);
  failAudit = true;
  assert.equal((await request('/'+id(10),patch({name:'Rollback'}))).status,503);
  assert.equal((await request('/'+id(10)+'/archive',{method:'POST'})).status,503);
  failAudit = false;
  response = await request('/'+id(10));
  const unchanged = await response.json() as {name:string,archived_at:string|null};
  assert.equal(unchanged.name,'Same');
  assert.equal(unchanged.archived_at,null);
  response = await request('/'+id(10),patch({name:' Updated ',metadata:{source:'fixture'}}));
  assert.equal(response.status,200);
  assert.equal((await response.json() as {name:string}).name,'Updated');
  response = await request('/'+id(10)+'/archive',{method:'POST'});
  assert.equal(response.status,200);
  assert.match((await response.json() as {archived_at:string}).archived_at,/Z$/);
  body = await (await request()).json() as typeof body;
  assert.deepEqual(body.items.map(row => row.id),[id(11)]);
  body = await (await request('?archived=true')).json() as typeof body;
  assert.deepEqual(body.items.map(row => row.id),[id(10)]);
  for (const value of [{}, {name:'No contact',consent:'maybe',metadata:{}},
    {name:'No contact',consent:'granted',metadata:[],email:'bad'},
    {name:'No contact',consent:'granted',metadata:{},owner_id:id(3)}])
    assert.equal((await request('',post(value))).status,400,JSON.stringify(value));
  response = await request('',post({name:' Ada Lovelace ',email:null,consent:'granted',metadata:{source:'fixture'}}));
  assert.equal(response.status,201);
  const created = await response.json() as { id:string; owner_id:string };
  assert.deepEqual(Object.keys(created).sort(),['id','owner_id']);
  const subjects = new Map([[id(3),'board'],[id(4),'other']]);
  const owner = subjects.get(created.owner_id); assert.ok(owner);
  const outsider = owner === 'board' ? 'other' : 'board';
  const outsiderId = owner === 'board' ? id(4) : id(3);
  assert.equal((await request('/'+created.id,{},owner)).status,200);
  assert.equal((await request('/'+created.id,{},outsider)).status,404);
  assert.equal((await request('/'+created.id,{},'admin')).status,200);
  for (const value of [{},{owner_id:'bad'},{owner_id:outsiderId,role:'admin'}])
    assert.equal((await request('/'+created.id+'/owner',post(value),'admin')).status,400,JSON.stringify(value));
  assert.equal((await request('/'+created.id+'/owner',patch({owner_id:outsiderId}),'admin')).status,404);
  assert.equal((await request('/'+created.id+'/owner',post({owner_id:outsiderId}))).status,403);
  assert.equal((await request('/'+id(99)+'/owner',post({owner_id:outsiderId}),'admin')).status,404);
  assert.equal((await request('/'+created.id+'/owner',post({owner_id:id(5)}),'admin')).status,409);
  assert.equal((await request('/'+created.id+'/owner',post({owner_id:id(99)}),'admin')).status,409);
  response = await request('/'+created.id+'/owner',post({owner_id:outsiderId}),'admin');
  assert.equal(response.status,200);
  const reassigned = await response.json() as { id:string; owner_id:string };
  assert.deepEqual(Object.keys(reassigned).sort(),['id','owner_id']);
  assert.deepEqual([reassigned.id,reassigned.owner_id],[created.id,outsiderId]);
  assert.equal((await request('/'+created.id,{},outsider)).status,200);
  assert.equal((await request('/'+created.id,{},owner)).status,404);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.equal((await sql.query<{n:number}>('SELECT count(*)::int AS n FROM gifts WHERE donor_id=$1',[id(10)])).rows[0].n,1);
  assert.deepEqual((await sql.query('SELECT action FROM audit_events ORDER BY action')).rows,
    [{action:'donor.archive'},{action:'donor.create'},{action:'donor.reassign'},{action:'donor.update'}]);
});
test('creation returns 409 and writes nothing when the organization has no eligible board owner', async t => {
  const sql = new PGlite();
  t.after(() => sql.close());
  for (const file of ['001_core.sql','002_assignment.sql','003_owner_override.sql'])
    await sql.exec(await readFile(new URL('../../db/migrations/' + file, import.meta.url), 'utf8'));
  await sql.query("INSERT INTO organizations(id,name) VALUES($1,'CIC')", [id(1)]);
  await sql.query("INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES($1,$2,'admin','admin')", [id(5),id(1)]);
  await sql.exec('CREATE ROLE donor_test LOGIN NOINHERIT; GRANT cic_runtime TO donor_test; SET SESSION AUTHORIZATION donor_test');
  const db: Database = { connect: async () => ({
    query: (text, values) => sql.query<Record<string, unknown>>(text, values), release: () => {},
  }) };
  const env = EnvSchema.parse({ DATABASE_URL:'postgresql://localhost/test', CIC_ORG_ID:id(1), CLERK_SECRET_KEY:'sk_test_fixture', CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev', APP_ORIGIN:'http://localhost:4200' });
  const server = createApp(env, db, async header => {
    if (header === 'Bearer admin') return { subject:'admin', mfa:true };
    throw new HttpError(401);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/donors`, { method:'POST',
    headers:{Authorization:'Bearer admin','Content-Type':'application/json'},
    body:JSON.stringify({name:'Unowned',consent:'granted',metadata:{}}) });
  assert.equal(response.status,409);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.equal((await sql.query<{n:number}>('SELECT count(*)::int AS n FROM donors')).rows[0].n,0);
  assert.equal((await sql.query<{n:number}>('SELECT count(*)::int AS n FROM audit_events')).rows[0].n,0);
});
