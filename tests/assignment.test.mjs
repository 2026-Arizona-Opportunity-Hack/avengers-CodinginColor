import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../db/migrate.ts';

const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const org = uuid(1), foreign = uuid(2), alice = uuid(3), bob = uuid(4), admin = uuid(5);
const directory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const call = 'SELECT * FROM public.create_assigned_donor($1, $2, $3, $4, $5::jsonb)';
const params = ['Synthetic donor', null, null, 'unknown', '{}'];
const clientFor = db => ({ query: async (sql, values) => values ? db.query(sql, values) : (await db.exec(sql)).at(-1) });

test('assignment creates donor, owner, cursor and audit atomically with restricted privileges', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await migrate(clientFor(db), directory);
  await db.query('INSERT INTO organizations (id,name) VALUES ($1,$3),($2,$3)', [org, foreign, 'Synthetic CIC']);
  for (const [id, organization, subject, role, active] of [
    [alice, org, 'alice', 'board', true], [bob, org, 'bob', 'board', true],
    [admin, org, 'admin', 'admin', true], [uuid(6), org, 'inactive', 'board', false],
    [uuid(7), foreign, 'foreign', 'board', true],
  ]) await db.query('INSERT INTO memberships (id,org_id,clerk_subject,role,active) VALUES ($1,$2,$3,$4,$5)', [id, organization, subject, role, active]);
  await db.query("INSERT INTO donors (id,org_id,owner_id,name) VALUES ($1,$2,$3,'Existing')", [uuid(10),org,alice]);
  await db.query("INSERT INTO donors (id,org_id,owner_id,name,archived_at) VALUES ($1,$2,$3,'Archived',now())", [uuid(11),org,bob]);
  await db.exec('CREATE ROLE assignment_test_login LOGIN NOINHERIT; GRANT cic_runtime TO assignment_test_login;');
  async function asUser(subject, run, commit = false, organization = org) {
    await db.exec('SET SESSION AUTHORIZATION assignment_test_login; BEGIN; SET LOCAL ROLE cic_runtime;');
    try {
      if (subject) await db.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true)", [organization,subject]);
      const value = await run();
      await db.exec(commit ? 'COMMIT' : 'ROLLBACK');
      return value;
    } catch (error) { await db.exec('ROLLBACK'); throw error; }
    finally { await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE;'); }
  }
  const create = async () => (await db.query(call, params)).rows[0];
  const state = async () => ({
    donors: (await db.query('SELECT id,owner_id FROM donors ORDER BY id')).rows,
    cursors: (await db.query('SELECT * FROM assignment_cursors ORDER BY org_id')).rows,
    audits: (await db.query('SELECT * FROM audit_events ORDER BY id')).rows,
  });

  await t.test('least load excludes archived, inactive, foreign and admin; ties rotate by UUID', async () => {
    const owners = [];
    for (let i=0;i<4;i++) owners.push((await asUser('admin', create, true)).owner_id);
    assert.deepEqual(owners, [bob,alice,bob,alice]);
    assert.equal((await db.query('SELECT owner_id FROM donors WHERE id=$1',[uuid(10)])).rows[0].owner_id,alice);
    assert.equal((await db.query('SELECT owner_id FROM donors WHERE id=$1',[uuid(11)])).rows[0].owner_id,bob);
    assert.equal((await db.query('SELECT last_owner_id FROM assignment_cursors WHERE org_id=$1',[org])).rows[0].last_owner_id,alice);
    const audits = (await db.query('SELECT org_id,actor_id FROM audit_events')).rows;
    assert.equal(audits.length,4);
    assert.ok(audits.every(row=>row.org_id===org && row.actor_id===admin));
  });
  await t.test('active board can create assigned donor without learning other donors or members', async () => {
    const before = await state();
    await asUser('alice', async () => {
      assert.equal((await create()).owner_id,bob);
      assert.equal((await db.query('SELECT id FROM memberships')).rows.length,1);
      assert.ok((await db.query('SELECT owner_id FROM donors')).rows.every(row=>row.owner_id===alice));
    });
    assert.deepEqual(await state(),before);
  });
  await t.test('missing, unknown, inactive and wrong-organization callers cannot create', async () => {
    for (const [subject,organization] of [[null,org],['unknown',org],['inactive',org],['alice',foreign]]) {
      const before = await state();
      await assert.rejects(asUser(subject,create,true,organization));
      assert.deepEqual(await state(),before);
    }
  });
  await t.test('runtime cannot bypass assignment with direct donor inserts', async () => {
    for (const [subject, owner] of [['alice',alice],['alice',bob],['alice',null],['admin',admin],['admin',bob],['admin',null]]) {
      await assert.rejects(asUser(subject,()=>db.query("INSERT INTO donors (org_id,owner_id,name) VALUES ($1,$2,'Bypass')",[org,owner]),true),/permission denied/i);
    }
  });
  await t.test('no eligible owner and invalid donor data leave no writes', async () => {
    await db.query('UPDATE memberships SET active=false WHERE id IN ($1,$2)',[alice,bob]);
    const before = await state();
    await assert.rejects(asUser('admin',create,true));
    assert.deepEqual(await state(),before);
    await db.query('UPDATE memberships SET active=true WHERE id IN ($1,$2)',[alice,bob]);
    for (const bad of [[' ',null,null,'unknown','{}'],['Valid',null,null,'yes','{}'],['Valid',null,null,'unknown','[]']]) {
      const baseline = await state();
      await assert.rejects(asUser('admin',()=>db.query(call,bad),true));
      assert.deepEqual(await state(),baseline);
    }
  });
  await t.test('rollback restores assignment state and audit; runtime cannot become assigner or reassign', async () => {
    const role = (await db.query("SELECT rolsuper,rolcanlogin,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,rolreplication FROM pg_roles WHERE rolname='cic_assignment'")).rows[0];
    assert.ok(role && Object.values(role).every(value=>value===false));
    const before = await state();
    await assert.rejects(asUser('alice',async()=>{await create();throw new Error('later failure');},true),/later failure/);
    assert.deepEqual(await state(),before);
    await assert.rejects(asUser('alice',()=>db.exec('SET ROLE cic_assignment')),/permission denied/i);
    await assert.rejects(asUser('alice',()=>db.query('UPDATE donors SET owner_id=$1 WHERE id=$2',[bob,uuid(10)])),/permission denied/i);
    await db.exec('SET SESSION AUTHORIZATION assignment_test_login;');
    try { await assert.rejects(db.query(call,params),/permission denied/i); }
    finally { await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE;'); }
  });
});

test('assignment migration accepts only isolated, restricted pre-existing assigner role', async t => {
  for (const attribute of ['BYPASSRLS','SUPERUSER','LOGIN','CREATEDB','CREATEROLE','INHERIT','REPLICATION','parent','grantee','safe']) {
    await t.test(attribute, async st => {
      const db = new PGlite();
      st.after(()=>db.close());
      await db.exec('CREATE ROLE cic_assignment NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;');
      if (attribute==='parent') await db.exec('CREATE ROLE elevated NOLOGIN BYPASSRLS; GRANT elevated TO cic_assignment;');
      else if (attribute==='grantee') await db.exec('CREATE ROLE outsider LOGIN; GRANT cic_assignment TO outsider;');
      else if (attribute!=='safe') await db.exec(`ALTER ROLE cic_assignment ${attribute};`);
      if (attribute==='safe') assert.equal((await migrate(clientFor(db),directory)).length,2);
      else await assert.rejects(migrate(clientFor(db),directory),/unsafe.*cic_assignment/i);
    });
  }
});
