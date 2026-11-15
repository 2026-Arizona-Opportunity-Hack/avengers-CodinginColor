import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const org=id(1), foreign=id(2), alice=id(3), bob=id(4), admin=id(5), inactive=id(6), foreignBoard=id(7), donor=id(10), foreignDonor=id(11);
const migration = async (db, name) => db.exec(await readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8'));
const call = (db, target=donor, owner=bob) => db.query('SELECT * FROM public.reassign_donor($1,$2)', [target,owner]);

test('admin reassigns atomically without exposing ownership update to runtime', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await migration(db,'001_core.sql'); await migration(db,'002_assignment.sql');
  await migration(db,'003_owner_override.sql');
  await db.query("INSERT INTO organizations(id,name) VALUES ($1,'CIC'),($2,'Other')", [org,foreign]);
  for (const [member,organization,subject,role,active] of [[alice,org,'alice','board',true],[bob,org,'bob','board',true],[admin,org,'admin','admin',true],[inactive,org,'inactive','board',false],[foreignBoard,foreign,'foreign','board',true]])
    await db.query('INSERT INTO memberships(id,org_id,clerk_subject,role,active) VALUES ($1,$2,$3,$4,$5)',[member,organization,subject,role,active]);
  await db.query("INSERT INTO donors(id,org_id,owner_id,name) VALUES ($1,$3,$4,'One'),($2,$5,$6,'Foreign')",[donor,foreignDonor,org,alice,foreign,foreignBoard]);
  await db.query("INSERT INTO gifts(id,org_id,donor_id,amount_cents,refund_cents,currency,occurred_at,status,source) VALUES ($1,$2,$3,100,0,'USD',now(),'settled','fixture')",[id(12),org,donor]);
  await db.exec('CREATE ROLE override_test LOGIN NOINHERIT; GRANT cic_runtime TO override_test;');
  async function as(subject, fn, commit=true, organization=org) {
    await db.exec('SET SESSION AUTHORIZATION override_test; BEGIN; SET LOCAL ROLE cic_runtime');
    try {
      if(subject) await db.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true)",[organization,subject]);
      const result=await fn(); await db.exec(commit?'COMMIT':'ROLLBACK'); return result;
    } catch(error) { await db.exec('ROLLBACK'); throw error; }
    finally { await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE'); }
  }
  const state = async () => ({ donors:(await db.query('SELECT id,owner_id,updated_at FROM donors ORDER BY id')).rows,
    audits:(await db.query('SELECT org_id,actor_id,action,target_id,status FROM audit_events ORDER BY id')).rows,
    cursors:(await db.query('SELECT * FROM assignment_cursors')).rows });
  const before = await state();
  assert.deepEqual((await as('admin',()=>call(db),false)).rows,[{id:donor,owner_id:bob}]);
  assert.deepEqual(await state(),before);
  for (const [subject,organization] of [[null,org],['unknown',org],['inactive',org],['alice',org],['admin',foreign]]) {
    await assert.rejects(as(subject,()=>call(db),true,organization), error=>error.code==='42501');
    assert.deepEqual(await state(),before);
  }
  for (const target of [foreignDonor,id(99)]) {
    await assert.rejects(as('admin',()=>call(db,target)), error=>error.code==='P0002');
    assert.deepEqual(await state(),before);
  }
  for (const owner of [inactive,foreignBoard,admin,id(99),null]) {
    await assert.rejects(as('admin',()=>call(db,donor,owner)), error=>error.code==='P0001');
    assert.deepEqual(await state(),before);
  }
  await assert.rejects(as('admin',()=>db.query('UPDATE donors SET owner_id=$1 WHERE id=$2',[bob,donor])),/permission denied/i);
  await db.exec("CREATE FUNCTION fail_override_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failed'; END $$; CREATE TRIGGER fail_override_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_override_audit()");
  await assert.rejects(as('admin',()=>call(db)),/audit failed/);
  assert.deepEqual(await state(),before);
  await db.exec('DROP TRIGGER fail_override_audit ON audit_events; DROP FUNCTION fail_override_audit()');
  assert.deepEqual((await as('admin',()=>call(db))).rows,[{id:donor,owner_id:bob}]);
  const after=await state();
  assert.equal(after.donors[0].owner_id,bob);
  assert.deepEqual(after.audits,[{org_id:org,actor_id:admin,action:'donor.reassign',target_id:donor,status:'success'}]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM gifts WHERE donor_id=$1',[donor])).rows[0].n,1);
});

test('override migration rejects unsafe assigner privileges before expansion', async t => {
  for (const threat of ['BYPASSRLS','LOGIN','parent','outsider','runtime']) await t.test(threat, async st => {
    const db=new PGlite(); st.after(()=>db.close());
    await migration(db,'001_core.sql'); await migration(db,'002_assignment.sql');
    if (threat==='parent') await db.exec('CREATE ROLE elevated BYPASSRLS; GRANT elevated TO cic_assignment');
    else if (threat==='outsider') await db.exec('CREATE ROLE outsider LOGIN; GRANT cic_assignment TO outsider');
    else if (threat==='runtime') await db.exec('GRANT cic_assignment TO cic_runtime');
    else await db.exec(`ALTER ROLE cic_assignment ${threat}`);
    await assert.rejects(migration(db,'003_owner_override.sql'),/unsafe.*cic_assignment/i);
    await db.exec('ROLLBACK');
    assert.equal((await db.query("SELECT has_column_privilege('cic_assignment','donors','owner_id','UPDATE') AS granted")).rows[0].granted,false);
  });
});


test('fresh migrations work for a non-superuser database owner', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('CREATE ROLE migration_owner LOGIN CREATEROLE BYPASSRLS;');
  const name = (await db.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(name,/^[a-zA-Z0-9_]+$/);
  await db.exec(`ALTER DATABASE "${name}" OWNER TO migration_owner; SET SESSION AUTHORIZATION migration_owner`);
  await migration(db,'001_core.sql'); await migration(db,'002_assignment.sql'); await migration(db,'003_owner_override.sql');
  const flags=(await db.query("SELECT rolsuper,rolcanlogin,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,rolreplication FROM pg_roles WHERE rolname='cic_assignment'")).rows[0];
  assert.ok(Object.values(flags).every(value=>value===false));
  assert.equal((await db.query("SELECT pg_has_role('cic_runtime','cic_assignment','MEMBER') AS member")).rows[0].member,false);
});
