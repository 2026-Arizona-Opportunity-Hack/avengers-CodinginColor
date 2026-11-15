import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from './app.ts';
import { withMember, type Database } from './db.ts';
import { EnvSchema, HttpError } from './env.ts';
import type { Identity } from './auth.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

test('HTTP membership and transaction cleanup enforce real PostgreSQL RLS under restricted login', async (t) => {
  // Clerk identity is stubbed; migration, role switching, membership and RLS execute in PostgreSQL.
  // PGlite has one connection; this test makes no concurrent-locking claim.
  const sql = new PGlite();
  t.after(() => sql.close());
  await sql.exec(await readFile(new URL('../../db/migrations/001_core.sql', import.meta.url), 'utf8'));
  await sql.query("INSERT INTO organizations (id, name) VALUES ($1, 'CIC test'), ($2, 'Other test')", [id(1), id(2)]);
  for (const [n, org, subject, role, active] of [
    [3, 1, 'board', 'board', true], [4, 1, 'admin', 'admin', true],
    [5, 1, 'inactive', 'board', false], [6, 2, 'foreign', 'board', true],
  ] as const) {
    await sql.query('INSERT INTO memberships (id, org_id, clerk_subject, role, active) VALUES ($1,$2,$3,$4,$5)',
      [id(n), id(org), subject, role, active]);
  }
  await sql.query("INSERT INTO donors (id, org_id, owner_id, name) VALUES ($1,$2,$3,'Before rollback')", [id(7), id(1), id(3)]);
  await sql.exec(`CREATE ROLE cic_api_test NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT cic_runtime TO cic_api_test; SET SESSION AUTHORIZATION cic_api_test;`);
  let releases = 0;
  const db: Database = { connect: async () => ({
    query: (text, values) => sql.query<Record<string, unknown>>(text, values),
    release: (destroy) => { assert.equal(destroy, false); releases++; },
  }) };
  const env = EnvSchema.parse({ DATABASE_URL: 'postgresql://localhost/test', CIC_ORG_ID: id(1),
    CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev',
    APP_ORIGIN: 'http://localhost:4200' });
  const identities = new Map<string, Identity>([
    ['Bearer board', { subject: 'board', mfa: false }],
    ['Bearer admin', { subject: 'admin', mfa: false }],
    ['Bearer admin-mfa', { subject: 'admin', mfa: true }],
    ['Bearer inactive', { subject: 'inactive', mfa: false }],
    ['Bearer foreign', { subject: 'foreign', mfa: false }],
  ]);
  const server = createApp(env, db, async (header) => {
    const identity = identities.get(header ?? '');
    if (!identity) throw new HttpError(401);
    return identity;
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/me`;
  async function contextCleared() {
    const result = await sql.query("SELECT current_user AS role, nullif(current_setting('app.org_id',true),'') AS org, nullif(current_setting('app.user_id',true),'') AS subject");
    assert.deepEqual(result.rows, [{ role: 'cic_api_test', org: null, subject: null }]);
  }
  for (const [token, expectedStatus] of [['board', 200], ['inactive', 403], ['foreign', 403], ['admin', 403], ['admin-mfa', 200], ['board', 200]] as const) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, expectedStatus, token);
    if (expectedStatus === 200) {
      assert.deepEqual(await response.json(), { id: id(token === 'admin-mfa' ? 4 : 3), org_id: id(1), role: token === 'admin-mfa' ? 'admin' : 'board' });
    } else assert.deepEqual(await response.json(), token === 'admin'
      ? { error: 'Request rejected', code: 'admin_mfa_required' }
      : { error: 'Request rejected' });
    await contextCleared();
  }
  const board = { subject: 'board', mfa: false };
  await assert.rejects(withMember(db, id(1), board, async (client) => {
    await client.query("UPDATE donors SET name = 'Must roll back' WHERE id = $1", [id(7)]);
    await client.query("INSERT INTO audit_events (org_id, actor_id, action, target_id, status) VALUES ($1,$2,'donor.update',$3,'success')", [id(1), id(4), id(7)]);
  }), /row-level security/i);
  await contextCleared();
  assert.deepEqual(await withMember(db, id(1), board, async (client) =>
    (await client.query('SELECT name FROM donors WHERE id = $1', [id(7)])).rows), [{ name: 'Before rollback' }]);
  await contextCleared();
  assert.equal(releases, 8);
  await assert.rejects(sql.query('SELECT * FROM memberships'), /permission denied/i);
});
