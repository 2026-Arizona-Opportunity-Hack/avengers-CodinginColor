import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { readdir,readFile } from 'node:fs/promises';

// This URL must point only to a disposable PostgreSQL 17 database.
test('a separate grantor can harden a definer function without removing managed membership', { skip: !process.env.CIC_PG17_REHEARSAL_URL }, async () => {
  const db = new pg.Client({ connectionString: process.env.CIC_PG17_REHEARSAL_URL });
  await db.connect();
  const notices = [];
  db.on('notice', notice => notices.push(notice.message));
  try {
    const version = (await db.query('SHOW server_version_num')).rows[0].server_version_num;
    assert.equal(Math.floor(Number(version) / 10000), 17);
    await db.query('BEGIN');
    await db.query(`CREATE ROLE rehearsal_cloud NOLOGIN;
      CREATE ROLE rehearsal_owner NOLOGIN;
      CREATE ROLE rehearsal_denied NOLOGIN;
      CREATE ROLE rehearsal_actor NOLOGIN;
      CREATE ROLE rehearsal_runtime NOLOGIN;
      GRANT rehearsal_owner, rehearsal_denied TO rehearsal_cloud WITH ADMIN TRUE;
      SET LOCAL ROLE rehearsal_cloud;
      GRANT rehearsal_owner TO rehearsal_actor WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
      GRANT rehearsal_denied TO rehearsal_actor WITH ADMIN FALSE, INHERIT FALSE, SET FALSE;
      RESET ROLE;
      CREATE FUNCTION public.rehearsal_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
      ALTER FUNCTION public.rehearsal_definer() OWNER TO rehearsal_owner;`);
    const memberships = async () => (await db.query(`SELECT pg_get_userbyid(roleid) role,pg_get_userbyid(member) member,
      pg_get_userbyid(grantor) grantor,admin_option,inherit_option,set_option FROM pg_auth_members
      WHERE roleid='rehearsal_owner'::regrole AND member='rehearsal_actor'::regrole ORDER BY grantor`)).rows;
    const baseline = await memberships();
    assert.equal(baseline.length, 1);
    assert.deepEqual([baseline[0].grantor, baseline[0].admin_option, baseline[0].inherit_option, baseline[0].set_option],
      ['rehearsal_cloud', true, false, false]);
    await db.query('SET SESSION AUTHORIZATION rehearsal_actor');
    await db.query('REVOKE ALL ON FUNCTION public.rehearsal_definer() FROM PUBLIC');
    assert.ok(notices.length, 'an ineffective privilege change must be visible');
    const acl = async () => (await db.query(`SELECT EXISTS(SELECT FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid='public.rehearsal_definer()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_exec,
      has_function_privilege('rehearsal_runtime','public.rehearsal_definer()','EXECUTE') AS runtime_exec`)).rows[0];
    assert.equal((await acl()).public_exec, true);
    await db.query(`GRANT rehearsal_owner TO rehearsal_actor WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
      SET LOCAL ROLE rehearsal_owner;
      REVOKE ALL ON FUNCTION public.rehearsal_definer() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.rehearsal_definer() TO rehearsal_runtime;
      RESET ROLE;
      REVOKE rehearsal_owner FROM rehearsal_actor GRANTED BY rehearsal_actor;`);
    assert.deepEqual(await acl(), { public_exec: false, runtime_exec: true });
    assert.deepEqual(await memberships(), baseline);
    await db.query('SAVEPOINT denied');
    await assert.rejects(db.query('GRANT rehearsal_denied TO rehearsal_actor WITH INHERIT FALSE, SET TRUE'));
    await db.query('ROLLBACK TO SAVEPOINT denied');
    assert.deepEqual(await memberships(), baseline);
    await db.query('RESET SESSION AUTHORIZATION');
    await db.query('ROLLBACK');
    const after = await db.query("SELECT to_regprocedure('public.rehearsal_definer()') AS function, EXISTS(SELECT FROM pg_roles WHERE rolname='rehearsal_actor') AS role");
    assert.deepEqual(after.rows[0], { function: null, role: false });
  } finally {
    await db.end();
  }
});

test('019 preserves native PG17 managed membership grantors/options and schema CREATE', {skip:!process.env.CIC_PG17_REHEARSAL_URL}, async()=>{
  const db=new pg.Client({connectionString:process.env.CIC_PG17_REHEARSAL_URL}); await db.connect();
  const body=source=>source.replace(/^\s*BEGIN;/,'').replace(/COMMIT;\s*$/,'');
  try {
    assert.equal(Math.floor(Number((await db.query('SHOW server_version_num')).rows[0].server_version_num)/10000),17);
    await db.query('BEGIN');
    const names=(await readdir('db/migrations')).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort();
    for(const name of names.filter(n=>n<'019_')) await db.query(body(await readFile(`db/migrations/${name}`,'utf8')));
    await db.query(`CREATE ROLE audit_owner NOLOGIN CREATEROLE; CREATE ROLE audit_cloud NOLOGIN;
      GRANT cic_reporting TO audit_cloud WITH ADMIN TRUE; SET LOCAL ROLE audit_cloud;
      GRANT cic_reporting TO audit_owner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE; RESET ROLE;
      GRANT CREATE ON SCHEMA public TO audit_owner WITH GRANT OPTION;
      GRANT REFERENCES ON public.organizations,public.api_keys TO audit_owner;
      GRANT SELECT(id) ON public.api_keys TO audit_owner WITH GRANT OPTION;
      ALTER DEFAULT PRIVILEGES FOR ROLE audit_owner GRANT EXECUTE ON FUNCTIONS TO cic_runtime WITH GRANT OPTION;`);
    const catalog=async()=>({
      members:(await db.query(`SELECT * FROM pg_auth_members WHERE roleid='cic_reporting'::regrole ORDER BY member,grantor`)).rows,
      schema:(await db.query("SELECT nspacl FROM pg_namespace WHERE oid='public'::regnamespace")).rows,
      defaults:(await db.query('SELECT * FROM pg_default_acl ORDER BY oid')).rows,
    });
    const source=body(await readFile('db/migrations/019_aggregate_access_audit.sql','utf8'));
    for(const existingCreate of [false,true]) {
      if(existingCreate) await db.query('GRANT CREATE ON SCHEMA public TO cic_reporting WITH GRANT OPTION');
      const before=await catalog(); await db.query('SAVEPOINT before_audit');
      await db.query('SET SESSION AUTHORIZATION audit_owner'); await db.query(source);
      assert.deepEqual(await catalog(),before);
      await db.query('RESET SESSION AUTHORIZATION; RESET ROLE');
      const result=(await db.query(`SELECT pg_get_userbyid(proowner) owner,prosecdef,proconfig,
        has_function_privilege('cic_runtime',oid,'EXECUTE') runtime,
        EXISTS(SELECT FROM aclexplode(proacl) a WHERE a.grantee=0) public
        FROM pg_proc WHERE oid='public.cic_record_aggregate_access(text,text,integer)'::regprocedure`)).rows[0];
      assert.deepEqual(result,{owner:'cic_reporting',prosecdef:true,proconfig:['search_path=pg_catalog'],runtime:true,public:false});
      assert.deepEqual((await db.query(`SELECT a.is_grantable,pg_get_userbyid(a.grantor) grantor
        FROM pg_proc p,aclexplode(p.proacl) a WHERE p.oid='public.cic_record_aggregate_access(text,text,integer)'::regprocedure
        AND a.grantee='cic_runtime'::regrole`)).rows,[{is_grantable:false,grantor:'cic_reporting'}]);
      await db.query('ROLLBACK TO SAVEPOINT before_audit');
    }
    await db.query('ROLLBACK');
  } finally { await db.query('RESET SESSION AUTHORIZATION; RESET ROLE; ROLLBACK').catch(()=>{}); await db.end(); }
});
