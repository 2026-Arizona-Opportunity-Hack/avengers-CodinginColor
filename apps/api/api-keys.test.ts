import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import { hashApiKey } from '../../packages/reporting/summary.ts';
import type { Database } from './db.ts';
import { EnvSchema, HttpError } from './env.ts';
import type { Identity } from './auth.ts';
import { createApiKeyRouter } from './api-keys.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = id(1), ADMIN = id(10), BOARD = id(11);

async function setup(t: test.TestContext) {
  const sql = new PGlite();
  t.after(() => sql.close());
  const owner = { query: async (q: string, v?: unknown[]) => v ? sql.query<Record<string, unknown>>(q, v) : (await sql.exec(q)).at(-1)! };
  await migrate(owner, fileURLToPath(new URL('../../db/migrations/', import.meta.url)));
  await sql.exec(`
    INSERT INTO organizations (id, name) VALUES ('${ORG}', 'CIC');
    INSERT INTO memberships (id, org_id, clerk_subject, role) VALUES ('${ADMIN}', '${ORG}', 'admin', 'admin'),
      ('${BOARD}', '${ORG}', 'board', 'board');
    CREATE ROLE cic_app_keys NOLOGIN NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO cic_app_keys;
    SET SESSION AUTHORIZATION cic_app_keys;`);
  const db: Database = { connect: async () => ({ query: (q, v) => sql.query<Record<string, unknown>>(q, v), release: () => {} }) };
  const identities: Record<string, Identity> = { 'Bearer admin': { subject: 'admin', mfa: true },
    'Bearer board': { subject: 'board', mfa: false } };
  const env = EnvSchema.parse({ DATABASE_URL: 'postgresql://localhost/test', CIC_ORG_ID: ORG,
    CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev', APP_ORIGIN: 'http://localhost:4200' });
  const app = express();
  app.use(express.json(), createApiKeyRouter(env, db, async (h) => {
    const identity = identities[h ?? ''];
    if (!identity) throw new HttpError(401);
    return identity;
  }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error instanceof HttpError ? error.status : 503).json({ error: 'x' });
  };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const call = (method: string, path: string, who?: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { ...(who ? { Authorization: `Bearer ${who}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const asOwner = async <T>(q: string) => {
    await sql.exec('SET SESSION AUTHORIZATION postgres;'); // PGlite ignores RESET SESSION AUTHORIZATION
    const rows = (await sql.query<T>(q)).rows;
    await sql.exec('SET SESSION AUTHORIZATION cic_app_keys;');
    return rows;
  };
  return { call, asOwner };
}

test('an admin creates a key that is shown once and stored only as its hash', async (t) => {
  const { call, asOwner } = await setup(t);
  const res = await call('POST', '/api/v1/api-keys', 'admin', { name: 'Org dashboard' });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.match(created.key, /^cic_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.hint, created.key.slice(0, 13));
  assert.equal(created.name, 'Org dashboard');
  const [stored] = await asOwner<{ key_hash: string; created_by: string }>('SELECT key_hash, created_by FROM api_keys');
  assert.deepEqual(stored, { key_hash: hashApiKey(created.key), created_by: ADMIN });
  const list = await (await call('GET', '/api/v1/api-keys', 'admin')).json();
  assert.equal(list.items.length, 1);
  assert.ok(!JSON.stringify(list).includes(created.key) && !JSON.stringify(list).includes(stored.key_hash));
  assert.deepEqual(Object.keys(list.items[0]).sort(), ['created_at', 'created_by', 'hint', 'id', 'name', 'revoked_at', 'scopes']);
  const audits = await asOwner<{ action: string }>('SELECT action FROM audit_events');
  assert.deepEqual(audits.map((a) => a.action), ['api_key.create']);
});

test('board members and anonymous callers cannot see, create or revoke keys', async (t) => {
  const { call } = await setup(t);
  const created = await (await call('POST', '/api/v1/api-keys', 'admin', { name: 'Org dashboard' })).json();
  assert.equal((await call('GET', '/api/v1/api-keys', 'board')).status, 403);
  assert.equal((await call('POST', '/api/v1/api-keys', 'board', { name: 'x' })).status, 403);
  assert.equal((await call('POST', `/api/v1/api-keys/${created.id}/revoke`, 'board')).status, 403);
  assert.equal((await call('GET', '/api/v1/api-keys')).status, 401);
  for (const body of [{}, { name: '' }, { name: 'x'.repeat(101) }, { name: 'ok', scopes: ['admin'] }]) {
    assert.equal((await call('POST', '/api/v1/api-keys', 'admin', body)).status, 400, JSON.stringify(body));
  }
});

test('revocation is one-way: revoked once, then 409; unknown keys 404', async (t) => {
  const { call, asOwner } = await setup(t);
  const created = await (await call('POST', '/api/v1/api-keys', 'admin', { name: 'Org dashboard' })).json();
  const revoked = await call('POST', `/api/v1/api-keys/${created.id}/revoke`, 'admin');
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).id, created.id);
  assert.equal((await call('POST', `/api/v1/api-keys/${created.id}/revoke`, 'admin')).status, 409);
  assert.equal((await call('POST', `/api/v1/api-keys/${id(99)}/revoke`, 'admin')).status, 404);
  assert.equal((await call('POST', '/api/v1/api-keys/nope/revoke', 'admin')).status, 400);
  const [row] = await asOwner<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM api_keys');
  assert.equal(row.revoked, true);
  const audits = (await asOwner<{ action: string }>('SELECT action FROM audit_events ORDER BY created_at')).map((a) => a.action);
  assert.deepEqual(audits, ['api_key.create', 'api_key.revoke']);
});

test('the key routes are mounted in the real app behind its session and origin checks', async (t) => {
  const { createApp } = await import('./app.ts');
  const env = EnvSchema.parse({ DATABASE_URL: 'postgresql://localhost/test', CIC_ORG_ID: ORG,
    CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev', APP_ORIGIN: 'http://localhost:4200' });
  const db: Database = { connect: async () => assert.fail('unauthenticated requests must not reach the database') };
  const server = createApp(env, db, async () => { throw new HttpError(401); }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/v1/api-keys`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/api-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x' }) })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/api-keys`, { headers: { Origin: 'https://evil.example' } })).status, 403);
});
