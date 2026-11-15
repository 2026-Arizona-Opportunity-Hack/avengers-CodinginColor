import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../db/migrate.ts';

const migrations = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const forward = '018_staff_invitation_provider_status.sql';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('published invitation migration upgrades once without changing its checksum or retaining email-only claims', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cic-invite-upgrade-'));
  const sql = new PGlite();
  t.after(async () => {
    await sql.close();
    assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'cic-invite-upgrade-'))));
    await rm(directory, { recursive: true });
  });
  const client = { query: async (q: string, values?: unknown[]) => values
    ? sql.query<Record<string, unknown>>(q, values) : (await sql.exec(q)).at(-1)! };
  for (const file of await readdir(migrations)) if (/^0(0\d|1[0-3])_/.test(file))
    await copyFile(join(migrations, file), join(directory, file));
  await migrate(client, directory);
  const prior = (await sql.query<{ sha256: string }>(
    "SELECT sha256 FROM schema_migrations WHERE name='013_staff_invitations.sql'")).rows[0].sha256;
  assert.ok((await sql.query("SELECT to_regprocedure('public.claim_staff_invitation(text)') AS old")).rows[0].old);
  await copyFile(join(migrations, forward), join(directory, forward));
  assert.deepEqual(await migrate(client, directory), [forward]);
  assert.deepEqual(await migrate(client, directory), []);
  assert.equal((await sql.query("SELECT sha256 FROM schema_migrations WHERE name='013_staff_invitations.sql'")).rows[0].sha256, prior);
  assert.equal((await sql.query("SELECT to_regprocedure('public.claim_staff_invitation(text)') AS old")).rows[0].old, null);
  for (const signature of ['pending_staff_invitation(text)', 'claim_staff_invitation(text,uuid,text)']) {
    const row = (await sql.query(`SELECT pg_get_userbyid(proowner) AS owner, proconfig,
      has_function_privilege('cic_runtime',oid,'EXECUTE') AS runtime,
      EXISTS(SELECT FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc WHERE oid=$1::regprocedure`, [`public.${signature}`])).rows[0];
    assert.equal(row.owner, 'cic_assignment'); assert.equal(row.runtime, true); assert.equal(row.public_execute, false);
    assert.deepEqual(row.proconfig, ['search_path=pg_catalog']);
  }
  await sql.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES('${id(10)}','${id(1)}','admin','admin');
    INSERT INTO staff_invitations(id,org_id,email,state,clerk_id,requested_by)
      VALUES('${id(50)}','${id(1)}','new@example.org','sent','inv_50','${id(10)}');
    SET ROLE cic_runtime;
    SELECT set_config('app.org_id','${id(1)}',false),set_config('app.user_id','new',false);`);
  const pending = (await sql.query('SELECT * FROM public.pending_staff_invitation($1)', ['new@example.org'])).rows;
  assert.deepEqual(pending, [{ id: id(50), clerk_id: 'inv_50' }]);
  for (const args of [['new@example.org',id(51),'inv_50'], ['new@example.org',id(50),'wrong-provider'],
    ['other@example.org',id(50),'inv_50']])
    assert.equal((await sql.query('SELECT public.claim_staff_invitation($1,$2,$3) AS claimed', args)).rows[0].claimed, false);
  await sql.exec('RESET ROLE');
  await sql.query("UPDATE staff_invitations SET state='revoked' WHERE id=$1", [id(50)]);
  await sql.exec('SET ROLE cic_runtime');
  assert.equal((await sql.query('SELECT public.claim_staff_invitation($1,$2,$3) AS claimed',
    ['new@example.org',id(50),'inv_50'])).rows[0].claimed, false);
});
