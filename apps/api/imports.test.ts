import assert from 'node:assert/strict';
import test from 'node:test';
import { importFixture, iid } from './import-fixture.ts';
export const csv='first name,last name,email,donation amount,external id\nAvery,Example,avery@example.org,12.34,tx-1';
export const layout={mapping:{},batch_values:{currency:'USD',occurred_at:'2026-01-01T01:00:00.123456Z',status:'settled',refund_cents:0}};
test('imports stage exact bytes with server identity, resume safely, validate layout and purge abandoned data',async t=>{
  const {call,sql}=await importFixture(t);
  const preflight=await call('OPTIONS','',undefined,null,{Origin:'http://localhost:4200'});
  assert.equal(preflight.status,204); assert.match(preflight.headers.get('access-control-allow-headers')??'',/X-Import-Source/);
  assert.equal((await call('POST','',csv,null)).status,401);
  assert.equal((await call('POST','',csv,'board')).status,403);
  assert.equal((await call('POST','',csv,'admin-no-mfa')).status,403);
  assert.equal((await call('POST','',csv,'foreign')).status,403);
  const response=await call('POST','',csv); assert.equal(response.status,201);
  const batch=await response.json() as {batch_id:string;file_sha256:string;status:string};
  assert.match(batch.file_sha256,/^sha256:[0-9a-f]{64}$/); assert.equal(batch.status,'reviewing');
  const replay=await call('POST','',csv); assert.equal(replay.status,200);
  assert.equal((await replay.json() as typeof batch).batch_id,batch.batch_id);
  assert.equal((await call('POST','',csv,'admin',{'X-Import-Source':'benevity'})).status,409);
  assert.equal((await call('GET','/'+batch.batch_id,undefined,'board')).status,403);
  assert.equal((await call('GET','/00000000-0000-4000-8000-000000000099')).status,404);
  assert.equal((await call('GET','/'+iid(90))).status,404);
  for(const value of [{...layout,org_id:'bad'},{...layout,batch_values:{amount_cents:1}},{mapping:{missing:'email'}},
    {date_format:'MM/DD/YYYY'}]) assert.equal((await call('POST',`/${batch.batch_id}/layout`,value)).status,400);
  const mapped=await call('POST',`/${batch.batch_id}/layout`,layout); assert.equal(mapped.status,200);
  for(const mapping of [{missing:'email'},{email:'unknown_target'}]) {
    const invalid=await call('POST',`/${batch.batch_id}/layout`,{mapping});
    assert.equal(invalid.status,400); assert.deepEqual(await invalid.json(),{error:'invalid_mapping'});
  }
  const invalidDecision=await call('POST',`/${batch.batch_id}/donors/review`,{
    plan_hash:'sha256:'+'0'.repeat(64),decisions:[{kind:'donor',row:0,action:'link',donor_id:'bad'}]});
  assert.equal(invalidDecision.status,400); assert.deepEqual(await invalidDecision.json(),{error:'invalid_decision'});
  const rows=await call('GET',`/${batch.batch_id}/rows?kind=donor&limit=1`);
  assert.equal(rows.status,200); assert.equal((await rows.json() as {items:unknown[]}).items.length,1);
  assert.equal((await call('POST',`/${batch.batch_id}/abandon`)).status,200);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  const [stored]=(await sql.query<{raw_csv:unknown;layout:unknown;status:string}>('SELECT raw_csv,layout,status FROM import_batches WHERE org_id=$1',[iid(1)])).rows;
  assert.deepEqual(stored,{raw_csv:null,layout:null,status:'abandoned'});
});
test('import upload rejects unsupported media, invalid CSV and excessive payloads without donor writes',async t=>{
  const {call,sql}=await importFixture(t);
  assert.equal((await call('POST','',{csv})).status,415);
  assert.equal((await call('POST','','"unterminated')).status,400);
  assert.equal((await call('POST','',csv,'admin',{'X-Import-Filename':'../private.csv'})).status,400);
  assert.equal((await call('POST','','x'.repeat(4194305))).status,413);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.equal((await sql.query<{n:number}>('SELECT count(*)::int AS n FROM donors')).rows[0].n,0);
});

test('invalid CSV headers have a stable public error and leave no staged batches',async t=>{
  const {call,sql}=await importFixture(t);
  for(const raw of ['email,EMAIL\na@example.org,b@example.org','first_name,first-name\nA,B',
    'email,\na@example.org,B',' , \nA,B']) {
    const response=await call('POST','',raw);
    assert.equal(response.status,400);
    assert.deepEqual(await response.json(),{error:'invalid_csv'});
  }
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.equal((await sql.query<{n:number}>('SELECT count(*)::int AS n FROM import_batches')).rows[0].n,1); // foreign fixture only
});

test('every import batch route conceals malformed IDs like missing IDs after authorization',async t=>{
  const {call}=await importFixture(t);
  const hash='sha256:'+'0'.repeat(64);
  const routes:[string,string,unknown][]=[['GET','',undefined],['GET','/rows',undefined],
    ['GET','/plan/rows?kind=donor',undefined],['POST','/layout',layout],['POST','/abandon',undefined],
    ['POST','/donors/plan',undefined],['POST','/gifts/plan',undefined],
    ['POST','/donors/review',{plan_hash:hash,decisions:[]}],
    ['POST','/gifts/review',{plan_hash:hash,donor_plan_hash:hash,decisions:[]}],
    ['POST','/commit',{plan_hash:hash,donor_plan_hash:hash}]];
  for(const [method,path,body] of routes) {
    for(const id of ['not-a-uuid','00000000-0000-4000-8000-000000000099']) {
      const response=await call(method,`/${id}${path}`,body);
      assert.equal(response.status,404,`${method} ${path} ${id}`);
      assert.deepEqual(await response.json(),{error:'import_not_found'});
    }
    assert.equal((await call(method,`/not-a-uuid${path}`,body,null)).status,401);
    assert.equal((await call(method,`/not-a-uuid${path}`,body,'board')).status,403);
  }
});
