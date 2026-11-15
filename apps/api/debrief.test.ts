import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import { debrief } from './debrief.ts';
import { EnvSchema, HttpError } from './env.ts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('reviewed debrief is scoped, atomic, replay-safe and never approves or sends its optional draft', async t => {
  const sql = new PGlite(); t.after(() => sql.close());
  await migrate({ query: async (q, v) => v ? sql.query(q, v) : (await sql.exec(q)).at(-1)! },
    fileURLToPath(new URL('../../db/migrations/', import.meta.url)));
  await sql.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES
      ('${id(10)}','${id(1)}','admin','admin'),('${id(11)}','${id(1)}','board','board'),
      ('${id(12)}','${id(1)}','other','board');
    INSERT INTO donors(id,org_id,owner_id,name,email,consent) VALUES
      ('${id(30)}','${id(1)}','${id(11)}','Avery','a@example.org','granted'),
      ('${id(31)}','${id(1)}','${id(12)}','Jordan','b@example.org','granted');
    CREATE ROLE debrief_login NOLOGIN NOINHERIT; GRANT cic_runtime TO debrief_login;
    SET SESSION AUTHORIZATION debrief_login;`);
  const env = EnvSchema.parse({ DATABASE_URL: 'postgresql://localhost/test', CIC_ORG_ID: id(1),
    CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev', APP_ORIGIN: 'http://localhost:4200' });
  const app = express();
  app.use(debrief(env, { connect: async () => ({ query: (q, v) => sql.query<Record<string, unknown>>(q, v), release() {} }) }, async h => {
    if (!h) throw new HttpError(401);
    return { subject: h.replace('Bearer ', ''), mfa: true };
  }));
  const errors: ErrorRequestHandler = (e, _req, res, _next) => res.status(e instanceof HttpError ? e.status : 503).json({ error: 'rejected' });
  app.use(errors);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const body = { request_id: id(70), reviewed: true, note: 'Discussed a class visit.', occurred_at: '2026-01-01T12:00:00-07:00',
    next_action: { title: 'Arrange visit', due_at: '2026-01-15T12:00:00-07:00' },
    draft: { channel: 'email', subject: 'Class visit', body: 'Thank you for meeting. Shall we arrange a visit?' } };
  const call = (input: unknown, who = 'board', donor = id(30)) => fetch(`http://127.0.0.1:${addr.port}/api/v1/donors/${donor}/debrief`, {
    method: 'POST', headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  assert.equal((await call({ ...body, reviewed: false })).status, 400);
  assert.equal((await call(body, 'other')).status, 404);
  assert.equal((await call(body, 'board', id(31))).status, 404);
  assert.equal((await call({ ...body, occurred_at: '2099-01-01T00:00:00Z' })).status, 400);
  assert.equal((await call(body)).status, 201);
  const repeat = await call(body); assert.equal(repeat.status, 200); assert.equal((await repeat.json()).replayed, true);
  assert.equal((await call({ ...body, note: 'Changed facts' })).status, 409);
  await sql.exec('SET SESSION AUTHORIZATION postgres');
  assert.equal((await sql.query('SELECT * FROM communications')).rows.length, 1);
  assert.equal((await sql.query('SELECT * FROM follow_ups')).rows.length, 1);
  assert.equal((await sql.query<{ status: string }>('SELECT status FROM drafts')).rows[0].status, 'draft');
  await sql.exec(`CREATE FUNCTION reject_debrief_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='debrief.save' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_debrief_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_debrief_audit();
    SET SESSION AUTHORIZATION debrief_login;`);
  assert.equal((await call({ ...body, request_id: id(71) })).status, 503);
  await sql.exec('SET SESSION AUTHORIZATION postgres');
  for (const table of ['communications', 'follow_ups', 'drafts', 'debrief_requests']) {
    assert.equal((await sql.query(`SELECT * FROM ${table}`)).rows.length, 1, table);
  }
});
