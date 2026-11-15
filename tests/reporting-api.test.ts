import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../db/migrate.ts';
import { generateApiKey, summarize, type SummaryGift } from '../packages/reporting/summary.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = id(1), OTHER = id(2), ADMIN = id(10), BOARD = id(11), FOREIGN_ADMIN = id(12);
const AI = id(20), AI_FUND = id(30), DONOR_A = id(40), DONOR_B = id(41), DONOR_C = id(42), FOREIGN_DONOR = id(43);
const migrations = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const runner = (db: PGlite) => ({ query: async (s: string, v?: unknown[]) =>
  v ? db.query<Record<string, unknown>>(s, v) : (await db.exec(s)).at(-1)! });

async function setup(t: test.TestContext) {
  const db = new PGlite();
  t.after(() => db.close());
  await migrate(runner(db), migrations);
  await db.exec(`
    INSERT INTO organizations (id, name) VALUES ('${ORG}', 'CIC'), ('${OTHER}', 'Other');
    INSERT INTO memberships (id, org_id, clerk_subject, role) VALUES ('${ADMIN}', '${ORG}', 'admin', 'admin'),
      ('${BOARD}', '${ORG}', 'board', 'board'), ('${FOREIGN_ADMIN}', '${OTHER}', 'foreign', 'admin');
    INSERT INTO programs (id, org_id, title) VALUES ('${AI}', '${ORG}', 'AI Academy');
    INSERT INTO campaigns (id, org_id, program_id, title) VALUES ('${AI_FUND}', '${ORG}', '${AI}', 'AI Fund');
    INSERT INTO donors (id, org_id, owner_id, name, email) VALUES
      ('${DONOR_A}', '${ORG}', '${BOARD}', 'Avery Rivera', 'avery@example.org'),
      ('${DONOR_B}', '${ORG}', '${BOARD}', 'Jordan Chen', 'jordan@example.org'),
      ('${DONOR_C}', '${ORG}', '${BOARD}', 'Riley Okafor', NULL),
      ('${FOREIGN_DONOR}', '${OTHER}', '${FOREIGN_ADMIN}', 'Not CIC', NULL);
    INSERT INTO gifts (org_id, donor_id, campaign_id, amount_cents, refund_cents, currency, occurred_at, status, source, external_id) VALUES
      ('${ORG}', '${DONOR_A}', '${AI_FUND}', 5000, 0, 'USD', '2026-02-01T12:00:00-07:00', 'settled', 'zeffy', 'a1'),
      ('${ORG}', '${DONOR_B}', NULL, 2500, 500, 'USD', '2026-03-01T12:00:00-07:00', 'settled', 'benevity', 'b1'),
      ('${ORG}', '${DONOR_C}', '${AI_FUND}', 1000, 0, 'USD', '2026-04-01T12:00:00-07:00', 'settled', 'sheet', 'c1'),
      ('${ORG}', '${DONOR_C}', NULL, 9999, 0, 'USD', '2026-04-02T12:00:00-07:00', 'void', 'sheet', 'c2'),
      ('${ORG}', '${DONOR_A}', NULL, 700, 0, 'USD', '2025-12-31T12:00:00-07:00', 'settled', 'zeffy', 'a0'),
      ('${OTHER}', '${FOREIGN_DONOR}', NULL, 123456, 0, 'USD', '2026-02-01T12:00:00-07:00', 'settled', 'zeffy', 'x1');
    CREATE ROLE cic_app_test NOLOGIN NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO cic_app_test;`);
  /** Run SQL the way the API does: restricted login, SET LOCAL ROLE cic_runtime, optional member context. */
  const asRuntime = async (sql: string, values: unknown[] = [], member?: string) => {
    await db.exec('SET SESSION AUTHORIZATION cic_app_test; BEGIN; SET LOCAL ROLE cic_runtime;');
    try {
      if (member) await db.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [ORG, member]);
      const rows = (await db.query<Record<string, unknown>>(sql, values)).rows;
      await db.exec('COMMIT;');
      return rows;
    } catch (error) { await db.exec('ROLLBACK;'); throw error; } finally {
      // PGlite ignores RESET SESSION AUTHORIZATION; switch back explicitly.
      await db.exec('SET SESSION AUTHORIZATION postgres;');
    }
  };
  const addKey = async (member: string) => {
    const key = generateApiKey();
    await asRuntime(`INSERT INTO api_keys (org_id, name, key_hash, hint, scopes, created_by)
      VALUES ($1, 'Org dashboard', $2, $3, ARRAY['read:aggregates'], $4) RETURNING id`, [ORG, key.hash, key.hint,
      member === 'admin' ? ADMIN : BOARD], member);
    return key;
  };
  return { db, asRuntime, addKey };
}

test('admins create and revoke keys through the runtime role; nobody reads the stored hash', async (t) => {
  const { asRuntime, addKey } = await setup(t);
  const key = await addKey('admin');
  const [row] = await asRuntime('SELECT name, hint, scopes, revoked_at FROM api_keys', [], 'admin');
  assert.deepEqual(row, { name: 'Org dashboard', hint: key.hint, scopes: ['read:aggregates'], revoked_at: null });
  await assert.rejects(asRuntime('SELECT key_hash FROM api_keys', [], 'admin'), /permission denied/);
  await assert.rejects(addKey('board'), /row-level security/);
  assert.deepEqual(await asRuntime('SELECT id FROM api_keys', [], 'board'), []);
  assert.equal((await asRuntime('UPDATE api_keys SET revoked_at = now() RETURNING id', [], 'admin')).length, 1);
  assert.equal((await asRuntime('UPDATE api_keys SET revoked_at = now() RETURNING id', [], 'admin')).length, 0);
  // Revocation is one-way: an already revoked key is outside the update policy, so nothing changes.
  assert.equal((await asRuntime('UPDATE api_keys SET revoked_at = NULL RETURNING id', [], 'admin')).length, 0);
  assert.notEqual((await asRuntime('SELECT revoked_at FROM api_keys', [], 'admin'))[0].revoked_at, null);
  await assert.rejects(asRuntime("UPDATE api_keys SET scopes = ARRAY['read:aggregates']", [], 'admin'), /permission denied/);
  await assert.rejects(asRuntime('DELETE FROM api_keys', [], 'admin'), /permission denied/);
});

test('a valid key reads only its own org\'s non-void gifts in the window, with no contact fields', async (t) => {
  const { asRuntime, addKey } = await setup(t);
  const key = await addKey('admin');
  const rows = await asRuntime(`SELECT donor_id, program_id, owner_id, amount_cents::int AS amount_cents,
      refund_cents::int AS refund_cents, currency, status, source FROM cic_reporting_gifts($1, $2, $3) ORDER BY occurred_at`,
  [key.hash, '2026-01-01T00:00:00-07:00', '2027-01-01T00:00:00-07:00']);
  assert.deepEqual(rows, [
    { donor_id: DONOR_A, program_id: AI, owner_id: BOARD, amount_cents: 5000, refund_cents: 0, currency: 'USD', status: 'settled', source: 'zeffy' },
    { donor_id: DONOR_B, program_id: null, owner_id: BOARD, amount_cents: 2500, refund_cents: 500, currency: 'USD', status: 'settled', source: 'benevity' },
    { donor_id: DONOR_C, program_id: AI, owner_id: BOARD, amount_cents: 1000, refund_cents: 0, currency: 'USD', status: 'settled', source: 'sheet' },
  ]);
  const columns = await asRuntime(`SELECT * FROM cic_reporting_gifts($1, $2, $3) LIMIT 1`,
    [key.hash, '2026-01-01T00:00:00-07:00', '2027-01-01T00:00:00-07:00']);
  for (const forbidden of ['name', 'email', 'phone', 'metadata', 'consent']) assert.ok(!(forbidden in columns[0]), forbidden);
  assert.deepEqual(await asRuntime('SELECT id, title FROM cic_reporting_programs($1)', [key.hash]), [{ id: AI, title: 'AI Academy' }]);

  // The rows feed the reviewed pure aggregation; only suppressed aggregates leave the server.
  const gifts: SummaryGift[] = (await asRuntime(`SELECT donor_id, program_id, owner_id, amount_cents::int AS amount_cents,
      refund_cents::int AS refund_cents, currency, status, source,
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
    FROM cic_reporting_gifts($1, $2, $3)`, [key.hash, '2026-01-01T00:00:00-07:00', '2027-01-01T00:00:00-07:00'])) as SummaryGift[];
  const summary = summarize(gifts, { window: { from: '2026-01-01T00:00:00-07:00', to: '2027-01-01T00:00:00-07:00' },
    groupBy: 'program' }, { offset: '-07:00', minDonors: 2 });
  assert.deepEqual(summary.totals, { suppressed: false, donors: 3, currencies: { USD: { gifts: 3, net_cents: 8000 } } });
});

test('unknown, revoked and wrong-org keys get nothing; windows are bounded; recent activity is capped', async (t) => {
  const { db, asRuntime, addKey } = await setup(t);
  const window = ['2026-01-01T00:00:00-07:00', '2027-01-01T00:00:00-07:00'];
  await assert.rejects(asRuntime('SELECT * FROM cic_reporting_gifts($1, $2, $3)', [generateApiKey().hash, ...window]), /Invalid API key/);
  await assert.rejects(asRuntime('SELECT * FROM cic_reporting_gifts($1, $2, $3)', ['not-a-hash', ...window]), /Invalid API key/);
  const key = await addKey('admin');
  await assert.rejects(asRuntime('SELECT * FROM cic_reporting_gifts($1, $2, $3)',
    [key.hash, '2020-01-01T00:00:00Z', '2026-01-02T00:00:00Z']), /window/);
  await assert.rejects(asRuntime('SELECT * FROM cic_reporting_gifts($1, $2, $3)', [key.hash, window[1], window[0]]), /window/);
  const recent = await asRuntime('SELECT donor_id, amount_cents::int AS amount_cents FROM cic_reporting_recent($1, 2)', [key.hash]);
  assert.deepEqual(recent, [{ donor_id: DONOR_C, amount_cents: 1000 }, { donor_id: DONOR_B, amount_cents: 2500 }]);
  for (const limit of [0, 101]) {
    await assert.rejects(asRuntime('SELECT * FROM cic_reporting_recent($1, $2)', [key.hash, limit]), /limit/);
  }
  await asRuntime('UPDATE api_keys SET revoked_at = now()', [], 'admin');
  await assert.rejects(asRuntime('SELECT * FROM cic_reporting_gifts($1, $2, $3)', [key.hash, ...window]), /Invalid API key/);
  // Another org's key only ever sees that org.
  const other = generateApiKey();
  await db.query(`INSERT INTO api_keys (org_id, name, key_hash, hint, scopes, created_by)
    VALUES ($1, 'Other', $2, $3, ARRAY['read:aggregates'], $4)`, [OTHER, other.hash, other.hint, FOREIGN_ADMIN]);
  assert.deepEqual((await asRuntime('SELECT donor_id FROM cic_reporting_gifts($1, $2, $3)', [other.hash, ...window])),
    [{ donor_id: FOREIGN_DONOR }]);
});

test('the definer role is unreachable directly, cannot read contact columns, and only runtime may execute', async (t) => {
  const { db } = await setup(t);
  await db.exec('SET ROLE cic_reporting;');
  await assert.rejects(db.query('SELECT name FROM donors'), /permission denied/);
  await assert.rejects(db.query('SELECT email FROM donors'), /permission denied/);
  await assert.rejects(db.query('SELECT metadata FROM donors'), /permission denied/);
  await db.exec('RESET ROLE;');
  const [role] = (await db.query<Record<string, unknown>>(`SELECT rolcanlogin, rolbypassrls, rolsuper, rolinherit,
    (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid AND m.set_option) AS settable_members
    FROM pg_roles r WHERE rolname = 'cic_reporting'`)).rows;
  assert.deepEqual(role, { rolcanlogin: false, rolbypassrls: false, rolsuper: false, rolinherit: false, settable_members: 0 });
  const grants = (await db.query<{ grantee: string; routine_name: string }>(`SELECT grantee, routine_name
    FROM information_schema.role_routine_grants WHERE routine_name LIKE 'cic_reporting%' AND privilege_type = 'EXECUTE'
      AND grantee NOT IN ('cic_reporting') ORDER BY 2, 1`)).rows;
  assert.deepEqual(grants.map((g) => `${g.routine_name}:${g.grantee}`).sort(),
    ['cic_reporting_gifts:cic_runtime', 'cic_reporting_programs:cic_runtime', 'cic_reporting_recent:cic_runtime']);
});

test('an unsafe pre-existing cic_reporting role stops the migration', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE ROLE cic_reporting LOGIN;');
  await assert.rejects(migrate(runner(db), migrations), /Unsafe existing cic_reporting role/);
  assert.deepEqual((await db.query("SELECT to_regclass('api_keys') AS t")).rows, [{ t: null }]);
});

test('a non-superuser CREATEROLE migration owner can apply 001-004', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE ROLE migration_owner NOLOGIN CREATEROLE BYPASSRLS;
    ALTER DATABASE postgres OWNER TO migration_owner; GRANT CREATE ON SCHEMA public TO migration_owner;
    SET SESSION AUTHORIZATION migration_owner;`);
  assert.ok((await migrate(runner(db), migrations)).includes('004_reporting_api.sql'));
  await db.exec('SET SESSION AUTHORIZATION postgres;');
  const [owner] = (await db.query<{ owner: string }>(
    "SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'cic_reporting_gifts'")).rows;
  assert.equal(owner.owner, 'cic_reporting');
});
