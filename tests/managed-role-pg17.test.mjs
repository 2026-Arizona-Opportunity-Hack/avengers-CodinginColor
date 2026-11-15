import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

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
      CREATE ROLE rehearsal_actor NOLOGIN;
      CREATE ROLE rehearsal_runtime NOLOGIN;
      GRANT rehearsal_owner TO rehearsal_cloud WITH ADMIN TRUE;
      SET LOCAL ROLE rehearsal_cloud;
      GRANT rehearsal_owner TO rehearsal_actor WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
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
    await db.query('RESET SESSION AUTHORIZATION');
    await db.query('ROLLBACK');
  } finally {
    await db.end();
  }
});
