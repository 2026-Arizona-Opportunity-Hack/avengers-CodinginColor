import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import type { Database } from './db.ts';
import { EnvSchema, HttpError } from './env.ts';
import type { Identity } from './auth.ts';
import { createOutreachRouter } from './outreach.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = id(1), ADMIN = id(10), BOARD_A = id(11), BOARD_B = id(12);
const DONOR_A = id(40), DONOR_A2 = id(41), DONOR_B = id(42), DENIED = id(43), ARCHIVED = id(44);
const NOW = '2026-11-14T12:00:00-07:00';

async function setup(t: test.TestContext) {
  const sql = new PGlite();
  t.after(() => sql.close());
  const owner = { query: async (q: string, v?: unknown[]) => v ? sql.query<Record<string, unknown>>(q, v) : (await sql.exec(q)).at(-1)! };
  await migrate(owner, fileURLToPath(new URL('../../db/migrations/', import.meta.url)));
  await sql.exec(`
    INSERT INTO organizations (id, name) VALUES ('${ORG}', 'CIC');
    INSERT INTO memberships (id, org_id, clerk_subject, role) VALUES ('${ADMIN}', '${ORG}', 'admin', 'admin'),
      ('${BOARD_A}', '${ORG}', 'board-a', 'board'), ('${BOARD_B}', '${ORG}', 'board-b', 'board');
    INSERT INTO donors (id, org_id, owner_id, name, consent, archived_at) VALUES
      ('${DONOR_A}', '${ORG}', '${BOARD_A}', 'Avery Rivera', 'granted', NULL),
      ('${DONOR_A2}', '${ORG}', '${BOARD_A}', 'Riley Okafor', 'unknown', NULL),
      ('${DONOR_B}', '${ORG}', '${BOARD_B}', 'Jordan Chen', 'granted', NULL),
      ('${DENIED}', '${ORG}', '${BOARD_B}', 'No Contact', 'denied', NULL),
      ('${ARCHIVED}', '${ORG}', '${BOARD_B}', 'Gone', 'granted', '2026-01-01T00:00:00Z');
    CREATE ROLE cic_app_out NOLOGIN NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO cic_app_out;
    SET SESSION AUTHORIZATION cic_app_out;`);
  const db: Database = { connect: async () => ({ query: (q, v) => sql.query<Record<string, unknown>>(q, v), release: () => {} }) };
  const identities: Record<string, Identity> = { 'Bearer admin': { subject: 'admin', mfa: true },
    'Bearer board-a': { subject: 'board-a', mfa: false }, 'Bearer board-b': { subject: 'board-b', mfa: false } };
  const env = EnvSchema.parse({ DATABASE_URL: 'postgresql://localhost/test', CIC_ORG_ID: ORG,
    CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev', APP_ORIGIN: 'http://localhost:4200' });
  const app = express();
  app.use(express.json(), createOutreachRouter(env, db, async (h) => {
    const identity = identities[h ?? ''];
    if (!identity) throw new HttpError(401);
    return identity;
  }, { now: () => NOW }));
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
  const audits = async () => {
    await sql.exec('SET SESSION AUTHORIZATION postgres;'); // PGlite ignores RESET SESSION AUTHORIZATION
    const rows = (await sql.query<{ action: string }>('SELECT action FROM audit_events ORDER BY created_at, action')).rows.map((r) => r.action);
    await sql.exec('SET SESSION AUTHORIZATION cic_app_out;');
    return rows;
  };
  return { call, audits };
}

test('quarterly generation is admin-only, skips ineligible donors, and is idempotent', async (t) => {
  const { call, audits } = await setup(t);
  assert.equal((await call('POST', '/api/v1/follow-ups/quarterly', 'board-a', { quarter: '2026-Q4' })).status, 403);
  const first = await call('POST', '/api/v1/follow-ups/quarterly', 'admin', { quarter: '2026-Q4' });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { created: 3, skipped: { archived: 1, no_owner: 0, consent_denied: 1, already_planned: 0 } });
  const again = await (await call('POST', '/api/v1/follow-ups/quarterly', 'admin', { quarter: '2026-Q4' })).json();
  assert.deepEqual(again, { created: 0, skipped: { archived: 1, no_owner: 0, consent_denied: 1, already_planned: 3 } });
  for (const body of [{ quarter: '2026-Q5' }, { quarter: '2026-Q4', extra: 1 }, {}]) {
    assert.equal((await call('POST', '/api/v1/follow-ups/quarterly', 'admin', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await audits(), ['follow_up.quarterly', 'follow_up.quarterly']);
});

test('the queue shows each board member only their own open tasks, split by urgency', async (t) => {
  const { call } = await setup(t);
  await call('POST', '/api/v1/follow-ups/quarterly', 'admin', { quarter: '2026-Q4' });
  assert.equal((await call('POST', '/api/v1/follow-ups', 'board-a',
    { donor_id: DONOR_A, title: 'Invite to Day of Compute', due_at: '2026-11-13T09:00:00-07:00' })).status, 201);
  assert.equal((await call('POST', '/api/v1/follow-ups', 'board-a',
    { donor_id: DONOR_A2, title: 'Thank-you call', due_at: '2026-11-18T09:00:00-07:00' })).status, 201);
  const mine = await (await call('GET', '/api/v1/follow-ups', 'board-a')).json();
  assert.deepEqual(mine.overdue.map((t: { title: string; donor_name: string }) => [t.title, t.donor_name]),
    [['Invite to Day of Compute', 'Avery Rivera']]);
  assert.deepEqual(mine.due_this_week.map((t: { title: string }) => t.title), ['Thank-you call']);
  assert.equal(mine.upcoming.length, 2);   // two quarterly touches for board A's donors
  const theirs = await (await call('GET', '/api/v1/follow-ups', 'board-b')).json();
  assert.deepEqual([theirs.overdue.length, theirs.due_this_week.length, theirs.upcoming.length], [0, 0, 1]);
  assert.equal((await call('GET', '/api/v1/follow-ups?scope=all', 'board-a')).status, 403);
  const all = await (await call('GET', '/api/v1/follow-ups?scope=all', 'admin')).json();
  assert.equal(all.overdue.length + all.due_this_week.length + all.upcoming.length, 5);
  assert.equal((await call('GET', '/api/v1/follow-ups?scope=team', 'admin')).status, 400);
  assert.equal((await call('GET', '/api/v1/follow-ups')).status, 401);
});

test('next actions belong to the donor\'s owner; other owners\' donors are 404; bad input 400', async (t) => {
  const { call, audits } = await setup(t);
  const created = await (await call('POST', '/api/v1/follow-ups', 'admin',
    { donor_id: DONOR_B, title: 'Send camp photos', due_at: '2026-11-20T09:00:00-07:00' })).json();
  assert.equal(created.owner_id, BOARD_B);
  assert.equal((await call('POST', '/api/v1/follow-ups', 'board-a',
    { donor_id: DONOR_B, title: 'x', due_at: '2026-11-20T09:00:00-07:00' })).status, 404);
  for (const body of [{ donor_id: DONOR_A, title: '', due_at: NOW }, { donor_id: DONOR_A, title: 'x', due_at: 'tomorrow' },
    { donor_id: DONOR_A, title: 'x', due_at: NOW, owner_id: BOARD_B }, { donor_id: 'nope', title: 'x', due_at: NOW }]) {
    assert.equal((await call('POST', '/api/v1/follow-ups', 'board-a', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await audits(), ['follow_up.create']);
});

test('completing a task records who did it, once; other owners cannot complete it', async (t) => {
  const { call, audits } = await setup(t);
  const task = await (await call('POST', '/api/v1/follow-ups', 'board-a',
    { donor_id: DONOR_A, title: 'Thank-you call', due_at: '2026-11-18T09:00:00-07:00' })).json();
  assert.equal((await call('POST', `/api/v1/follow-ups/${task.id}/complete`, 'board-b')).status, 404);
  const done = await call('POST', `/api/v1/follow-ups/${task.id}/complete`, 'board-a');
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { id: task.id, status: 'done', completed_by: BOARD_A });
  assert.equal((await call('POST', `/api/v1/follow-ups/${task.id}/complete`, 'board-a')).status, 409);
  const mine = await (await call('GET', '/api/v1/follow-ups', 'board-a')).json();
  assert.equal(mine.overdue.length + mine.due_this_week.length + mine.upcoming.length, 0);
  assert.deepEqual(await audits(), ['follow_up.create', 'follow_up.complete']);
});

test('the follow-up routes are mounted in the real app behind its session and origin checks', async (t) => {
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
  assert.equal((await fetch(`${base}/api/v1/follow-ups`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/follow-ups`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ donor_id: DONOR_A, title: 'x', due_at: NOW }) })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/follow-ups`, { headers: { Origin: 'https://evil.example' } })).status, 403);
});
