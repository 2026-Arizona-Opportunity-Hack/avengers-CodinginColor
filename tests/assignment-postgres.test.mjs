import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from 'pg';
import { migrate } from '../db/migrate.ts';

const url = process.env.CORE_TEST_DATABASE_URL;
const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const org = uuid(1), alice = uuid(2), bob = uuid(3), admin = uuid(4);
const call = 'SELECT * FROM public.create_assigned_donor($1, NULL, NULL, $2, $3::jsonb)';

test('native PostgreSQL serializes assignment across commit and rollback', { skip: !url, timeout: 30000 }, async t => {
  const connection = new URL(url);
  assert.ok(['postgres:', 'postgresql:'].includes(connection.protocol));
  assert.match(decodeURIComponent(connection.pathname.slice(1)), /^cic_test_[a-z0-9_]+$/);
  const observer = new Client({ connectionString: url, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
  const clients = [observer];
  t.after(async () => { for (const client of clients) await client.end().catch(() => {}); });
  await observer.connect();
  const empty = await observer.query(`SELECT
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')) AS objects,
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AS functions,
    (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('cic_runtime','cic_assignment','cic_assignment_test_login')) AS roles`);
  assert.deepEqual(empty.rows[0], { objects: 0, functions: 0, roles: 0 }, 'test requires an empty disposable database and cluster');
  await migrate(observer, fileURLToPath(new URL('../db/migrations/', import.meta.url)));
  await observer.query("INSERT INTO organizations (id,name) VALUES ($1,'Synthetic CIC')", [org]);
  await observer.query("INSERT INTO memberships (id,org_id,clerk_subject,role) VALUES ($1,$4,'alice','board'),($2,$4,'bob','board'),($3,$4,'admin','admin')", [alice,bob,admin,org]);
  const password = randomBytes(32).toString('hex');
  await observer.query(`CREATE ROLE cic_assignment_test_login LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO cic_assignment_test_login`);
  const restricted = new URL(url);
  restricted.username = 'cic_assignment_test_login'; restricted.password = password;
  for (let i = 0; i < 2; i++) {
    const client = new Client({ connectionString: restricted.href, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
    clients.push(client); await client.connect();
  }
  const [, a, b] = clients;
  const pids = await Promise.all([a,b].map(async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
  assert.notEqual(pids[0], pids[1]);
  async function begin(client) {
    await client.query('BEGIN; SET LOCAL ROLE cic_runtime');
    await client.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true)", [org,'admin']);
  }
  for (const finish of ['COMMIT', 'ROLLBACK']) {
    // Reset only synthetic rows in the disposable database between scenarios.
    await observer.query('DELETE FROM audit_events; DELETE FROM donors; DELETE FROM assignment_cursors');
    await begin(a); await begin(b);
    const first = (await a.query(call, ['First','unknown','{}'])).rows[0];
    assert.equal(first.owner_id, alice);
    const waiting = b.query(call, ['Second','unknown','{}']);
    waiting.catch(() => {});
    const deadline = Date.now() + 5000;
    let blockers = [];
    while (Date.now() < deadline) {
      blockers = (await observer.query('SELECT pg_blocking_pids($1) AS pids', [pids[1]])).rows[0].pids;
      if (blockers.includes(pids[0])) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(blockers.includes(pids[0]), 'second function call must block on the first transaction');
    await a.query(finish);
    if (finish === 'ROLLBACK') {
      const state = (await observer.query('SELECT (SELECT count(*)::int FROM donors) AS donors, (SELECT count(*)::int FROM audit_events) AS audits, (SELECT count(*)::int FROM assignment_cursors) AS cursors')).rows[0];
      assert.deepEqual(state, { donors: 0, audits: 0, cursors: 0 });
    }
    const second = (await waiting).rows[0];
    assert.equal(second.owner_id, finish === 'COMMIT' ? bob : alice);
    await b.query('COMMIT');
    const donors = (await observer.query('SELECT id,owner_id FROM donors ORDER BY name')).rows;
    const audits = (await observer.query('SELECT target_id FROM audit_events ORDER BY target_id')).rows;
    const cursor = (await observer.query('SELECT last_owner_id FROM assignment_cursors WHERE org_id=$1', [org])).rows;
    assert.equal(donors.length, finish === 'COMMIT' ? 2 : 1);
    assert.equal(audits.length, donors.length);
    assert.deepEqual(audits.map(row => row.target_id).sort(), donors.map(row => row.id).sort());
    assert.deepEqual(cursor, [{ last_owner_id: second.owner_id }]);
    if (finish === 'ROLLBACK') {
      assert.ok(!donors.some(row => row.id === first.id));
      assert.ok(!audits.some(row => row.target_id === first.id));
    }
  }
});
