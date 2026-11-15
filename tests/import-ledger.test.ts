import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function setup(t: test.TestContext, ledger = true) {
  const db = new PGlite(); t.after(() => db.close());
  for (const file of ['001_core','002_assignment','003_owner_override','004_reporting_api','005_outreach','006_import_review'])
    if (ledger || !file.startsWith('006')) await db.exec(await readFile(new URL(`../db/migrations/${file}.sql`,import.meta.url),'utf8'));
  await db.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC'),('${id(2)}','Other');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES
    ('${id(10)}','${id(1)}','admin','admin'),('${id(11)}','${id(1)}','board','board'),('${id(12)}','${id(2)}','foreign','admin');
    CREATE ROLE ledger_login NOLOGIN NOINHERIT; GRANT cic_runtime TO ledger_login;`);
  const as = async (who: string, q: string, values: unknown[] = []) => {
    await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE; BEGIN; SET LOCAL ROLE cic_runtime');
    await db.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true)",[who==='foreign'?id(2):id(1),who]);
    try { const r = await db.query(q,values); await db.exec('COMMIT'); return r.rows as Record<string,unknown>[]; }
    catch(e) { await db.exec('ROLLBACK'); throw e; }
  };
  const insert = (sha = 'a', source = 'zeffy') => `INSERT INTO import_batches(org_id,created_by,source,filename,file_sha256,raw_csv)
    VALUES('${id(1)}','${id(10)}','${source}','test.csv','sha256:${sha.repeat(64)}',decode('61','hex')) RETURNING id`;
  return { db, as, insert };
}
test('import ledger isolates admins, binds actors, and rejects replay across source labels',async t=>{
  const {as,insert}=await setup(t);
  const [row]=await as('admin',insert()); assert.ok(row.id);
  assert.deepEqual(await as('board','SELECT id FROM import_batches'),[]);
  assert.deepEqual(await as('foreign','SELECT id FROM import_batches'),[]);
  await assert.rejects(as('board',insert('b')),/policy|permission/);
  await assert.rejects(as('admin',insert('b').replace(id(10),id(11))),/policy/);
  await assert.rejects(as('admin',insert('a','benevity')),/unique/);
  await assert.rejects(as('admin',`UPDATE import_batches SET source='benevity'`),/permission/);
  await assert.rejects(as('admin','DELETE FROM import_batches'),/permission/);
  await assert.rejects(as('admin',insert('c').replace("decode('61','hex')","decode(repeat('78',4194305),'hex')")),/check/);
});
test('terminal batches purge private staging and cannot reopen; abandoned files may stage again',async t=>{
  const {as,insert}=await setup(t); await as('admin',insert());
  await assert.rejects(as('admin',"UPDATE import_batches SET status='abandoned'"),/check/);
  await as('admin',"UPDATE import_batches SET status='abandoned',raw_csv=NULL,layout=NULL,donor_decisions=NULL,gift_decisions=NULL");
  await assert.rejects(as('admin',"UPDATE import_batches SET status='reviewing',raw_csv=decode('61','hex')"),/terminal/);
  await as('admin',insert());
  await as('admin',`UPDATE import_batches SET status='committed',raw_csv=NULL,layout=NULL,donor_decisions=NULL,gift_decisions=NULL,
    committed_by='${id(10)}',committed_at=now(),result='{"counts":{}}' WHERE status='reviewing'`);
  assert.equal((await as('admin',"SELECT result FROM import_batches WHERE status='committed'")).length,1);
  await assert.rejects(as('admin',insert()),/unique/);
});
test('gift provenance is unique across owners even when RLS hides the prior row',async t=>{
  const {db,as}=await setup(t);
  await db.exec(`INSERT INTO donors(id,org_id,owner_id,name) VALUES('${id(20)}','${id(1)}','${id(10)}','A'),('${id(21)}','${id(1)}','${id(11)}','B');`);
  const gift=(donor: number)=>`INSERT INTO gifts(org_id,donor_id,amount_cents,refund_cents,currency,occurred_at,status,source,source_row)
    VALUES('${id(1)}','${id(donor)}',100,0,'USD',now(),'settled','zeffy','{"batch_id":"${id(30)}","row_key":"2"}')`;
  await as('admin',gift(20));
  assert.deepEqual(await as('board','SELECT id FROM gifts'),[]);
  await assert.rejects(as('board',gift(21)),/unique/);
});
test('duplicate historical provenance aborts migration without deleting any history',async t=>{
  const {db}=await setup(t,false);
  await db.exec(`INSERT INTO donors(id,org_id,owner_id,name) VALUES('${id(20)}','${id(1)}','${id(10)}','A');
    INSERT INTO gifts(org_id,donor_id,amount_cents,refund_cents,currency,occurred_at,status,source,source_row)
    SELECT '${id(1)}','${id(20)}',100,0,'USD',now(),'settled','zeffy','{"batch_id":"${id(30)}","row_key":"2"}'::jsonb
      FROM generate_series(1,2);`);
  await assert.rejects(db.exec(await readFile(new URL('../db/migrations/006_import_review.sql',import.meta.url),'utf8')),/unique/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM gifts')).rows[0].n,2);
  assert.equal((await db.query<{name:string|null}>("SELECT to_regclass('public.import_batches') AS name")).rows[0].name,null);
});
