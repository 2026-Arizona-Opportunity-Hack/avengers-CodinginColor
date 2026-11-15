import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('reassignment moves open tasks only, stays admin-only and rolls donor/tasks back together',async t=>{
  const db=new PGlite(); t.after(()=>db.close());
  for(const f of ['001_core','002_assignment','003_owner_override','004_reporting_api','005_outreach','006_import_review'])
    await db.exec(await readFile(new URL(`../db/migrations/${f}.sql`,import.meta.url),'utf8'));
  // Optional before implementation: assertions must expose missing behavior, not just a missing file.
  try {await db.exec(await readFile(new URL('../db/migrations/007_owner_followups.sql',import.meta.url),'utf8'));}
  catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;}
  await db.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES('${id(10)}','${id(1)}','admin','admin'),
    ('${id(11)}','${id(1)}','old','board'),('${id(12)}','${id(1)}','new','board');
    INSERT INTO donors(id,org_id,owner_id,name) VALUES('${id(20)}','${id(1)}','${id(11)}','Avery');
    INSERT INTO follow_ups(org_id,donor_id,owner_id,kind,title,due_at,status)
    VALUES('${id(1)}','${id(20)}','${id(11)}','next_action','Open',now(),'open'),
    ('${id(1)}','${id(20)}','${id(11)}','next_action','History',now(),'done');`);
  const as=async(who:string,q:string)=>{
    await db.exec('BEGIN; SET LOCAL ROLE cic_runtime');
    await db.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true)",[id(1),who]);
    try {const r=await db.query(q);await db.exec('COMMIT');return r.rows;}
    catch(e) {await db.exec('ROLLBACK');throw e;}
  };
  await assert.rejects(as('old',`SELECT * FROM reassign_donor('${id(20)}','${id(12)}')`),/admin/);
  await as('admin',`SELECT * FROM reassign_donor('${id(20)}','${id(12)}')`);
  assert.deepEqual((await db.query('SELECT title,owner_id FROM follow_ups ORDER BY title')).rows,
    [{title:'History',owner_id:id(11)},{title:'Open',owner_id:id(12)}]);
  await assert.rejects(as('admin',`UPDATE follow_ups SET owner_id='${id(11)}'`),/permission/);
  await db.exec(`CREATE FUNCTION reject_transfer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
    CREATE TRIGGER reject_transfer BEFORE UPDATE ON follow_ups FOR EACH ROW EXECUTE FUNCTION reject_transfer();`);
  await assert.rejects(as('admin',`SELECT * FROM reassign_donor('${id(20)}','${id(11)}')`),/injected/);
  assert.equal((await db.query<{owner_id:string}>('SELECT owner_id FROM donors')).rows[0].owner_id,id(12));
  assert.equal((await db.query<{n:number}>("SELECT count(*)::int AS n FROM audit_events WHERE action='donor.reassign'")).rows[0].n,1);
});
