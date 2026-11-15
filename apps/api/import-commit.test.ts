import assert from 'node:assert/strict';
import test from 'node:test';
import {importFixture,iid} from './import-fixture.ts';
const csv='first name,last name,email,donation amount,external id\nAvery,Example,avery@example.org,12.34,tx-1';
const layout={mapping:{},batch_values:{currency:'USD',occurred_at:'2026-01-01T01:00:00.123456Z',status:'settled',refund_cents:0}};
async function ready(t:test.TestContext,file=csv,review=true) {
  const f=await importFixture(t),{call}=f;
  const {batch_id:id}=await (await call('POST','',file)).json() as {batch_id:string};
  assert.equal((await call('POST',`/${id}/layout`,layout)).status,200);
  const {plan_hash:donor_plan_hash}=await (await call('POST',`/${id}/donors/plan`)).json() as {plan_hash:string};
  assert.equal((await call('POST',`/${id}/donors/review`,{plan_hash:donor_plan_hash,decisions:[]})).status,200);
  const {plan_hash}=await (await call('POST',`/${id}/gifts/plan`)).json() as {plan_hash:string};
  if(review) assert.equal((await call('POST',`/${id}/gifts/review`,{donor_plan_hash,plan_hash,decisions:[]})).status,200);
  return {...f,id,hashes:{donor_plan_hash,plan_hash}};
}
test('commit atomically assigns donors and maps gift rows, preserves exact facts and returns safe replay',async t=>{
  const {call,sql,id,hashes}=await ready(t);
  const response=await call('POST',`/${id}/commit`,hashes); assert.equal(response.status,200);
  const result=await response.json() as {replayed:boolean;counts:{donors_created:number;gifts_inserted:number}};
  assert.equal(result.replayed,false); assert.equal(result.counts.donors_created,1); assert.equal(result.counts.gifts_inserted,1);
  const replay=await call('POST',`/${id}/commit`,hashes); assert.equal(replay.status,200);
  assert.equal((await replay.json() as typeof result).replayed,true);
  const upload=await call('POST','',csv); assert.equal(upload.status,200);
  assert.equal((await upload.json() as typeof result).replayed,true);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  const [gift]=(await sql.query<{amount:string;at:string;owner_id:string;batch:string}>(`SELECT amount_cents::text AS amount,
    to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,owner_id,source_row->>'batch_id' AS batch
    FROM gifts JOIN donors ON donors.id=gifts.donor_id`)).rows;
  assert.deepEqual(gift,{amount:'1234',at:'2026-01-01T01:00:00.123456Z',owner_id:iid(11),batch:id});
  assert.equal((await sql.query<{n:number}>("SELECT count(*)::int AS n FROM audit_events WHERE action='gift.insert'")).rows[0].n,1);
  const [batch]=(await sql.query<{raw_csv:unknown;layout:unknown;status:string}>('SELECT raw_csv,layout,status FROM import_batches WHERE id=$1',[id])).rows;
  assert.deepEqual(batch,{raw_csv:null,layout:null,status:'committed'});
});

test('review and commit preserve different row statuses and partial refunds',async t=>{
  const {call,sql}=await importFixture(t);
  const file='first name,email,donation amount,refunded amount,status,currency,occurred at,external id\n' +
    'Avery,a@example.org,12.34,2.34,settled,USD,2026-01-01T12:00:00Z,mixed-1\n' +
    'Sam,s@example.org,50,0,pending,EUR,2026-01-02T12:00:00Z,mixed-2';
  const {batch_id:id}=await (await call('POST','',file)).json() as {batch_id:string};
  assert.equal((await call('POST',`/${id}/layout`,{mapping:{},batch_values:{}})).status,200);
  const donor=await (await call('POST',`/${id}/donors/plan`)).json() as {plan_hash:string};
  assert.equal((await call('POST',`/${id}/donors/review`,{plan_hash:donor.plan_hash,decisions:[]})).status,200);
  const gift=await (await call('POST',`/${id}/gifts/plan`)).json() as {plan_hash:string};
  const hashes={donor_plan_hash:donor.plan_hash,plan_hash:gift.plan_hash};
  assert.equal((await call('POST',`/${id}/gifts/review`,{...hashes,decisions:[]})).status,200);
  assert.equal((await call('POST',`/${id}/commit`,hashes)).status,200);
  assert.equal((await call('POST','',file)).status,200);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.deepEqual((await sql.query(`SELECT amount_cents::text AS amount,refund_cents::text AS refund,status,currency
    FROM gifts ORDER BY external_id`)).rows,[{amount:'1234',refund:'234',status:'settled',currency:'USD'},
    {amount:'5000',refund:'0',status:'pending',currency:'EUR'}]);
});
test('commit requires completed review, the reviewing actor and strict server-owned operations',async t=>{
  const {call,id,hashes}=await ready(t,csv,false);
  assert.equal((await call('POST',`/${id}/commit`,hashes)).status,409);
  await call('POST',`/${id}/gifts/review`,{...hashes,decisions:[]});
  assert.equal((await call('POST',`/${id}/commit`,hashes,'second-admin')).status,409);
  assert.equal((await call('POST',`/${id}/commit`,{...hashes,operations:[]})).status,400);
  assert.equal((await call('POST',`/${id}/commit`,hashes,'board')).status,403);
  assert.equal((await call('POST',`/${id}/commit`,hashes,null)).status,401);
  assert.equal((await call('POST',`/${id}/commit`,{},null)).status,401);
});
test('a changed transaction requires an explicit correction and retains original provenance',async t=>{
  const {call,sql,id,hashes}=await ready(t);
  assert.equal((await call('POST',`/${id}/commit`,hashes)).status,200);
  const changed=csv.replace('12.34','15.00');
  const next=await (await call('POST','',changed)).json() as {batch_id:string};
  await call('POST',`/${next.batch_id}/layout`,layout);
  const dp=await (await call('POST',`/${next.batch_id}/donors/plan`)).json() as {plan_hash:string};
  await call('POST',`/${next.batch_id}/donors/review`,{plan_hash:dp.plan_hash,decisions:[]});
  const gp=await (await call('POST',`/${next.batch_id}/gifts/plan`)).json() as {plan_hash:string};
  const rows=await (await call('GET',`/${next.batch_id}/plan/rows?kind=gift`)).json() as {items:{existingIds:string[]}[]};
  assert.equal((await call('POST',`/${next.batch_id}/gifts/review`,{donor_plan_hash:dp.plan_hash,plan_hash:gp.plan_hash,decisions:[]})).status,200);
  const commit={donor_plan_hash:dp.plan_hash,plan_hash:gp.plan_hash};
  assert.equal((await call('POST',`/${next.batch_id}/commit`,commit)).status,409);
  const decision={kind:'gift',row:0,action:'correct',gift_id:rows.items[0].existingIds[0]};
  assert.equal((await call('POST',`/${next.batch_id}/gifts/review`,{...commit,decisions:[decision]})).status,200);
  const saved=await call('POST',`/${next.batch_id}/commit`,commit); assert.equal(saved.status,200);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  const gifts=(await sql.query<{amount:string;batch:string}>("SELECT amount_cents::text AS amount,source_row->>'batch_id' AS batch FROM gifts")).rows;
  assert.deepEqual(gifts,[{amount:'1500',batch:id}]);
});
test('commit refuses stale facts and rolls back all donor/gift writes if final audit fails',async t=>{
  const {call,sql,id,hashes}=await ready(t);
  await sql.exec(`SET SESSION AUTHORIZATION postgres; RESET ROLE;
    CREATE FUNCTION reject_import_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='import.commit' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_import_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_import_audit();
    SET SESSION AUTHORIZATION import_login;`);
  assert.equal((await call('POST',`/${id}/commit`,hashes)).status,503);
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.equal((await sql.query<{n:number}>('SELECT count(*)::int AS n FROM donors')).rows[0].n,0);
  assert.equal((await sql.query<{n:number}>('SELECT count(*)::int AS n FROM gifts')).rows[0].n,0);
  assert.equal((await sql.query<{status:string}>('SELECT status FROM import_batches WHERE id=$1',[id])).rows[0].status,'reviewing');
  await sql.query('INSERT INTO donors(org_id,owner_id,name,email) VALUES($1,$2,$3,$4)',[iid(1),iid(11),'Avery Example','avery@example.org']);
  await sql.exec('SET SESSION AUTHORIZATION import_login');
  assert.equal((await call('POST',`/${id}/commit`,hashes)).status,409);
});
test('excluded input records must be explicitly acknowledged before a partial import commits',async t=>{
  const {call,id,hashes}=await ready(t,csv+'\nInvalid,Example,not-an-email,8.00,tx-2');
  assert.equal((await call('POST',`/${id}/commit`,hashes)).status,400);
  assert.equal((await call('POST',`/${id}/layout`,{...layout,skip_records:[2]})).status,400);
  assert.equal((await call('POST',`/${id}/layout`,{...layout,skip_records:[3]})).status,200);
  const {plan_hash:donor_plan_hash}=await (await call('POST',`/${id}/donors/plan`)).json() as {plan_hash:string};
  await call('POST',`/${id}/donors/review`,{plan_hash:donor_plan_hash,decisions:[]});
  const {plan_hash}=await (await call('POST',`/${id}/gifts/plan`)).json() as {plan_hash:string};
  await call('POST',`/${id}/gifts/review`,{donor_plan_hash,plan_hash,decisions:[]});
  const response=await call('POST',`/${id}/commit`,{donor_plan_hash,plan_hash}); assert.equal(response.status,200);
  assert.equal((await response.json() as {counts:{skipped:number}}).counts.skipped,1);
});
