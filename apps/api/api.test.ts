import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { EnvSchema, HttpError } from './env.ts';
import { createVerifier, type AuthProvider } from './auth.ts';
import { withMember, type Client } from './db.ts';
import { createApp } from './app.ts';

const id = '550e8400-e29b-41d4-a716-446655440000';
const env = EnvSchema.parse({ DATABASE_URL: 'postgresql://localhost/cic', CIC_ORG_ID: id,
  CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev',
  APP_ORIGIN: 'http://localhost:4200' });
const claims = { sub: 'user_fixture', sid: 'sess_fixture', iss: env.CLERK_JWT_ISSUER, azp: env.APP_ORIGIN, fva: [0, 1] };
const session = { status: 'active', userId: claims.sub, expireAt: Date.now() + 60000 };
const user = { id: claims.sub, banned: false, locked: false, twoFactorEnabled: true,
  primaryEmailAddressId: 'email_fixture', emailAddresses: [{ id: 'email_fixture', verification: { status: 'verified' } }] };
const provider: AuthProvider = { verify: async () => claims, session: async () => session, user: async () => user };
const rejected = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;
const member = { id, org_id: id, role: 'board' };
function database(rows: Record<string, unknown>[] = [member], rollbackFails = false) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  let destroyed: boolean | undefined;
  const client: Client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (rollbackFails && sql === 'ROLLBACK') throw new Error('connection lost');
      return { rows: sql.startsWith('SELECT id') ? rows : [] };
    },
    release: (value) => { destroyed = value; },
  };
  return { connect: async () => client, calls, destroyed: () => destroyed };
}

test('environment rejects missing org, arbitrary web origins and migration-style non-Postgres URLs', () => {
  for (const change of [{ CIC_ORG_ID: undefined }, { DATABASE_URL: 'https://example.com' },
    { APP_ORIGIN: 'https://example.com/path' }, { APP_ORIGIN: 'http://example.com' }, { PORT: 0 }]) {
    assert.equal(EnvSchema.safeParse({ ...env, ...change }).success, false);
  }
});

test('verified token requires live active session, matching subject, verified primary email and trusted claims', async () => {
  assert.deepEqual(await createVerifier(env, provider)('Bearer fixture'), { subject: claims.sub, mfa: true });
  for (const authorization of [undefined, 'Basic fixture', 'Bearer a b']) {
    await assert.rejects(createVerifier(env, provider)(authorization), rejected(401));
  }
  const invalid: AuthProvider[] = [
    { ...provider, verify: async () => { throw new Error('bad signature'); } },
    { ...provider, verify: async () => ({ ...claims, iss: 'https://attacker.example' }) },
    { ...provider, verify: async () => ({ ...claims, azp: undefined }) },
    { ...provider, session: async () => ({ ...session, status: 'revoked' }) },
    { ...provider, session: async () => ({ ...session, expireAt: 0 }) },
    { ...provider, session: async () => ({ ...session, userId: 'other' }) },
    { ...provider, user: async () => ({ ...user, banned: true }) },
    { ...provider, user: async () => ({ ...user, locked: true }) },
    { ...provider, user: async () => ({ ...user, primaryEmailAddressId: 'unverified-primary' }) },
    { ...provider, user: async () => ({ ...user, emailAddresses: [] }) },
  ];
  for (const bad of invalid) await assert.rejects(createVerifier(env, bad)('Bearer fixture'), rejected(401));
  await assert.rejects(createVerifier(env, { ...provider, session: async () => { throw new Error('outage'); } })('Bearer fixture'), rejected(503));
  assert.equal((await createVerifier(env, { ...provider, verify: async () => ({ ...claims, fva: [0, -1] }) })('Bearer fixture')).mfa, false);
});

test('transaction scopes verified identity locally; rejects absent membership and admin without MFA; rolls back safely', async () => {
  const db = database();
  assert.deepEqual(await withMember(db, id, { subject: claims.sub, mfa: false }, async (_client, row) => row), member);
  assert.deepEqual(db.calls.map((call) => call.sql.split(' ')[0]), ['BEGIN', 'SET', 'SELECT', 'SELECT', 'COMMIT']);
  assert.deepEqual(db.calls[2].values, [id, claims.sub]);
  assert.deepEqual(db.calls[3].values, [id, claims.sub]);
  assert.equal(db.destroyed(), false);
  for (const rows of [[], [{ ...member, role: 'admin' }]]) {
    const denied = database(rows);
    await assert.rejects(withMember(denied, id, { subject: claims.sub, mfa: false }, async () => assert.fail()), rejected(403));
    assert.equal(denied.calls.at(-1)?.sql, 'ROLLBACK');
  }
  const admin = database([{ ...member, role: 'admin' }]);
  assert.equal(await withMember(admin, id, { subject: claims.sub, mfa: true }, async (_client, row) => row.role), 'admin');
  const broken = database([member], true);
  await assert.rejects(withMember(broken, id, { subject: claims.sub, mfa: true }, async () => { throw new Error('write failed'); }), /write failed/);
  assert.equal(broken.destroyed(), true);
});

test('HTTP me endpoint enforces bearer authentication and exact CORS; errors disclose no internals', async () => {
  const db = database();
  const server = createApp(env, db, createVerifier(env, provider)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/me`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { Authorization: 'Bearer fixture', Origin: env.APP_ORIGIN } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), env.APP_ORIGIN);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), member);
    assert.equal((await fetch(url, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(url, { method: 'OPTIONS', headers: { Origin: env.APP_ORIGIN } })).status, 204);
    const denied = await fetch(url.replace('/me', '/unknown'));
    assert.deepEqual(await denied.json(), { error: 'Request rejected' });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
