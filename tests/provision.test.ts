import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../db/migrate.ts';
import { provision, type ProvisionInput } from '../db/provision.ts';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const migrations = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const roster: ProvisionInput = {
  organization: { name: 'Coding in Color' },
  members: [
    { clerk_subject: 'user_2AdminCeo', role: 'admin' },
    { clerk_subject: 'user_2BoardJordan', role: 'board' },
    { clerk_subject: 'user_2BoardTaylor', role: 'board', active: false },
  ],
};

async function database(t: test.TestContext) {
  const db = new PGlite();
  t.after(() => db.close());
  const client = { query: async (sql: string, values?: unknown[]) => values
    ? db.query<Record<string, unknown>>(sql, values)
    : (await db.exec(sql)).at(-1)! };
  await migrate(client, migrations);
  return { db, client };
}

test('provisions the CIC organization and memberships, and is idempotent', async (t) => {
  const { db, client } = await database(t);
  assert.deepEqual(await provision(client, ORG, roster),
    { organization: 'created', members: { created: 3, updated: 0, unchanged: 0 }, untouched: 0 });
  assert.deepEqual(await provision(client, ORG, roster),
    { organization: 'unchanged', members: { created: 0, updated: 0, unchanged: 3 }, untouched: 0 });
  assert.deepEqual((await db.query('SELECT id, name FROM organizations')).rows, [{ id: ORG, name: 'Coding in Color' }]);
  assert.deepEqual((await db.query('SELECT clerk_subject, role, active FROM memberships ORDER BY clerk_subject')).rows, [
    { clerk_subject: 'user_2AdminCeo', role: 'admin', active: true },
    { clerk_subject: 'user_2BoardJordan', role: 'board', active: true },
    { clerk_subject: 'user_2BoardTaylor', role: 'board', active: false },
  ]);
});

test('re-running updates roles and activation; members missing from the file are left alone', async (t) => {
  const { db, client } = await database(t);
  await provision(client, ORG, roster);
  assert.deepEqual(await provision(client, ORG, {
    organization: { name: 'Coding in Color AZ' },
    members: [
      { clerk_subject: 'user_2AdminCeo', role: 'admin' },
      { clerk_subject: 'user_2BoardTaylor', role: 'board', active: true },
      { clerk_subject: 'user_2BoardRiley', role: 'board' },
    ],
  }), { organization: 'updated', members: { created: 1, updated: 1, unchanged: 1 }, untouched: 1 });
  assert.deepEqual((await db.query("SELECT active FROM memberships WHERE clerk_subject = 'user_2BoardJordan'")).rows,
    [{ active: true }]);
});

test('a provisioned member passes the runtime membership check under RLS', async (t) => {
  const { db, client } = await database(t);
  await provision(client, ORG, roster);
  await db.exec(`CREATE ROLE cic_app_test NOLOGIN NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO cic_app_test;
    SET SESSION AUTHORIZATION cic_app_test;`);
  await db.exec('BEGIN; SET LOCAL ROLE cic_runtime;');
  await db.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [ORG, 'user_2BoardJordan']);
  assert.deepEqual((await db.query('SELECT role FROM memberships')).rows, [{ role: 'board' }]);
  await db.exec('ROLLBACK; RESET SESSION AUTHORIZATION;');
});

test('invalid rosters are rejected before any write', async (t) => {
  const { db, client } = await database(t);
  const bad: Array<[unknown, RegExp]> = [
    [{ ...roster, members: [{ clerk_subject: 'user_2BoardJordan', role: 'board' }] }, /active admin/],
    [{ ...roster, members: [{ clerk_subject: 'user_2AdminCeo', role: 'admin', active: false }] }, /active admin/],
    [{ ...roster, members: [...roster.members, { clerk_subject: 'user_2AdminCeo', role: 'board' }] }, /duplicate/i],
    [{ ...roster, members: [{ clerk_subject: 'jordan@example.com', role: 'admin' }] }, /Clerk user ID/],
    [{ ...roster, members: [{ clerk_subject: 'user_2AdminCeo', role: 'owner' }] }, /role/],
    [{ ...roster, extra: true }, /Unrecognized/i],
    [{ organization: { name: '  ' }, members: roster.members }, /name/],
  ];
  for (const [input, message] of bad) {
    await assert.rejects(provision(client, ORG, input as ProvisionInput), message, JSON.stringify(input));
  }
  await assert.rejects(provision(client, 'not-a-uuid', roster), /CIC_ORG_ID/);
  assert.deepEqual((await db.query('SELECT count(*)::int AS n FROM organizations')).rows, [{ n: 0 }]);
});

test('a non-superuser CREATEROLE migration owner can provision (creator membership is not runtime access)', async (t) => {
  // Review on #35: PostgreSQL 16+ makes the creator of cic_runtime a member WITH ADMIN, which the
  // MEMBER check mistook for the runtime login.
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE ROLE migration_owner NOLOGIN CREATEROLE BYPASSRLS;
    ALTER DATABASE postgres OWNER TO migration_owner; GRANT CREATE ON SCHEMA public TO migration_owner;
    SET SESSION AUTHORIZATION migration_owner;`);
  const client = { query: async (sql: string, values?: unknown[]) => values
    ? db.query<Record<string, unknown>>(sql, values)
    : (await db.exec(sql)).at(-1)! };
  await migrate(client, migrations);
  assert.deepEqual((await db.query<{ member: boolean }>(
    "SELECT pg_has_role(current_user, 'cic_runtime', 'MEMBER') AS member")).rows, [{ member: true }]);
  assert.deepEqual(await provision(client, ORG, roster),
    { organization: 'created', members: { created: 3, updated: 0, unchanged: 0 }, untouched: 0 });
});

test('CLI reports invalid roster JSON without echoing any of the file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cic-provision-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'roster.json');
  await writeFile(file, '{"organization": SENSITIVE_SAMPLE_ROSTER user_2Secret jordan@example.org');
  const script = fileURLToPath(new URL('../db/provision.ts', import.meta.url));
  const child = spawn(process.execPath, [script, file], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(output, /not valid JSON/);
  for (const secret of ['SENSITIVE', 'user_2Secret', 'jordan@']) assert.ok(!output.includes(secret), output);
});

test('refuses the runtime login and roles that cannot bypass row-level security', async (t) => {
  const { db, client } = await database(t);
  await db.exec(`CREATE ROLE cic_app_test NOLOGIN NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO cic_app_test;
    CREATE ROLE weak_owner NOLOGIN NOBYPASSRLS;
    GRANT SELECT, INSERT, UPDATE ON organizations, memberships TO weak_owner;`);
  await db.exec('SET SESSION AUTHORIZATION cic_app_test;');
  await assert.rejects(provision(client, ORG, roster), /runtime/);
  await db.exec('SET SESSION AUTHORIZATION weak_owner;');
  await assert.rejects(provision(client, ORG, roster), /row-level security/);
  // PGlite ignores RESET SESSION AUTHORIZATION; switch back explicitly so RLS can't hide rows from the check.
  await db.exec('SET SESSION AUTHORIZATION postgres;');
  assert.deepEqual((await db.query('SELECT current_user AS who')).rows, [{ who: 'postgres' }]);
  assert.deepEqual((await db.query(`SELECT (SELECT count(*) FROM organizations)::int AS orgs,
    (SELECT count(*) FROM memberships)::int AS members`)).rows, [{ orgs: 0, members: 0 }]);
});
