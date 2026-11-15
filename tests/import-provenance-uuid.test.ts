import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const batch='00000000-0000-4000-8000-00000000000a';
const migration=new URL('../db/migrations/008_import_provenance_uuid.sql',import.meta.url);
async function setup(t:test.TestContext,upgrade=true) {
  const db=new PGlite(); t.after(()=>db.close());
  for(const file of ['001_core','002_assignment','003_owner_override','004_reporting_api','005_outreach','006_import_review','007_owner_followups'])
    await db.exec(await readFile(new URL(`../db/migrations/${file}.sql`,import.meta.url),'utf8'));
  if(upgrade) await db.exec(await readFile(migration,'utf8'));
  await db.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC'),('${id(2)}','Other');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES
    ('${id(10)}','${id(1)}','admin','admin'),('${id(11)}','${id(1)}','board','board'),('${id(12)}','${id(2)}','foreign','admin');
    INSERT INTO donors(id,org_id,owner_id,name) VALUES
    ('${id(20)}','${id(1)}','${id(10)}','A'),('${id(21)}','${id(1)}','${id(11)}','B'),('${id(22)}','${id(2)}','${id(12)}','C');`);
  const gift=(donor:number,uuid=batch,key='row-A',org=id(1))=>db.query(`INSERT INTO gifts
    (org_id,donor_id,amount_cents,refund_cents,currency,occurred_at,status,source,source_row)
    VALUES($1,$2,100,0,'USD',now(),'settled','zeffy',$3::jsonb)`,[org,id(donor),JSON.stringify({batch_id:uuid,row_key:key})]);
  return {db,gift};
}
test('UUID case aliases cannot duplicate gift provenance across hidden owners',async t=>{
  const {db,gift}=await setup(t);
  await gift(20);
  await db.exec(`SET ROLE cic_runtime; SELECT set_config('app.org_id','${id(1)}',false),set_config('app.user_id','board',false)`);
  assert.equal((await db.query('SELECT id FROM gifts')).rows.length,0);
  await assert.rejects(gift(21,batch.toUpperCase()),/unique/);
});
test('provenance retains organization scope and case-sensitive row keys',async t=>{
  const {db,gift}=await setup(t);
  await gift(20); await gift(20,batch.toUpperCase(),'row-a');
  await gift(22,batch.toUpperCase(),'row-A',id(2));
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM gifts')).rows[0].n,3);
});
test('historical UUID aliases abort upgrade atomically and preserve the old index and history',async t=>{
  const {db,gift}=await setup(t,false);
  await gift(20); await gift(21,batch.toUpperCase());
  await assert.rejects(db.exec(await readFile(migration,'utf8')),/unique/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM gifts')).rows[0].n,2);
  await assert.rejects(gift(20),/unique/);
});
