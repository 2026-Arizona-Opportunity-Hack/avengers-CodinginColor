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
import { createMessageRouter } from './outreach-messages.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = id(1), ADMIN = id(10), BOARD_A = id(11), BOARD_B = id(12);
const DONOR_A = id(40), DONOR_B = id(41), DENIED = id(42);
const NOW = '2026-11-14T12:00:00-07:00';
const thanks = { donor_id: DONOR_A, template: 'thank_you', fields: { first_name: 'Avery', amount: '$50.00', program: 'AI Academy' } };

async function setup(t: test.TestContext) {
  const sql = new PGlite();
  t.after(() => sql.close());
  const owner = { query: async (q: string, v?: unknown[]) => v ? sql.query<Record<string, unknown>>(q, v) : (await sql.exec(q)).at(-1)! };
  await migrate(owner, fileURLToPath(new URL('../../db/migrations/', import.meta.url)));
  await sql.exec(`
    INSERT INTO organizations (id, name) VALUES ('${ORG}', 'CIC');
    INSERT INTO memberships (id, org_id, clerk_subject, role) VALUES ('${ADMIN}', '${ORG}', 'admin', 'admin'),
      ('${BOARD_A}', '${ORG}', 'board-a', 'board'), ('${BOARD_B}', '${ORG}', 'board-b', 'board');
    INSERT INTO donors (id, org_id, owner_id, name, email, phone, consent) VALUES
      ('${DONOR_A}', '${ORG}', '${BOARD_A}', 'Avery Rivera', 'avery@example.org', '602-555-0100', 'granted'),
      ('${DONOR_B}', '${ORG}', '${BOARD_B}', 'Jordan Chen', 'jordan@example.org', NULL, 'granted'),
      ('${DENIED}', '${ORG}', '${BOARD_A}', 'No Contact', 'no@example.org', NULL, 'denied');
    INSERT INTO follow_ups (org_id, donor_id, owner_id, kind, quarter, title, due_at) VALUES
      ('${ORG}', '${DONOR_A}', '${BOARD_A}', 'quarterly', '2026-Q4', 'Quarterly update', '2027-01-01T00:00:00-07:00');
    CREATE ROLE cic_app_msg NOLOGIN NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO cic_app_msg;
    SET SESSION AUTHORIZATION cic_app_msg;`);
  const db: Database = { connect: async () => ({ query: (q, v) => sql.query<Record<string, unknown>>(q, v), release: () => {} }) };
  const identities: Record<string, Identity> = { 'Bearer admin': { subject: 'admin', mfa: true },
    'Bearer board-a': { subject: 'board-a', mfa: false }, 'Bearer board-b': { subject: 'board-b', mfa: false } };
  const env = EnvSchema.parse({ DATABASE_URL: 'postgresql://localhost/test', CIC_ORG_ID: ORG,
    CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev', APP_ORIGIN: 'http://localhost:4200' });
  const app = express();
  app.use(express.json(), createMessageRouter(env, db, async (h) => {
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
  const asOwner = async <T>(q: string) => {
    await sql.exec('SET SESSION AUTHORIZATION postgres;'); // PGlite ignores RESET SESSION AUTHORIZATION
    const rows = (await sql.query<T>(q)).rows;
    await sql.exec('SET SESSION AUTHORIZATION cic_app_msg;');
    return rows;
  };
  return { call, asOwner };
}

test('drafts are rendered from templates for visible donors who allow contact', async (t) => {
  const { call } = await setup(t);
  const res = await call('POST', '/api/v1/drafts', 'board-a', thanks);
  assert.equal(res.status, 201);
  const draft = await res.json();
  assert.deepEqual({ ...draft, id: undefined }, { id: undefined, channel: 'email', recipient: 'avery@example.org',
    subject: 'Thank you from Coding in Color', body: draft.body, status: 'draft' });
  assert.match(draft.body, /^Hi Avery,/);
  assert.equal((await call('POST', '/api/v1/drafts', 'board-b', thanks)).status, 404);
  assert.equal((await call('POST', '/api/v1/drafts', 'board-a', { ...thanks, donor_id: DENIED })).status, 409);
  for (const body of [{ ...thanks, template: 'phishing' }, { ...thanks, fields: { first_name: 'A' } }, { ...thanks, extra: 1 }]) {
    assert.equal((await call('POST', '/api/v1/drafts', 'board-a', body)).status, 400, JSON.stringify(body));
  }
});

test('approval binds content: edits drop it, other owners cannot approve, compose needs approval', async (t) => {
  const { call } = await setup(t);
  const draft = await (await call('POST', '/api/v1/drafts', 'board-a', thanks)).json();
  assert.equal((await call('GET', `/api/v1/drafts/${draft.id}/compose`, 'board-a')).status, 409);
  assert.equal((await call('POST', `/api/v1/drafts/${draft.id}/approve`, 'board-b')).status, 404);
  const approved = await (await call('POST', `/api/v1/drafts/${draft.id}/approve`, 'board-a')).json();
  assert.equal(approved.status, 'approved');
  assert.match(approved.approval_hash, /^[0-9a-f]{64}$/);
  const compose = await (await call('GET', `/api/v1/drafts/${draft.id}/compose`, 'board-a')).json();
  assert.ok(compose.href.startsWith('mailto:avery%40example.org?subject='), compose.href);
  const edited = await (await call('PATCH', `/api/v1/drafts/${draft.id}`, 'board-a', { body: 'Hi Avery, thanks again!' })).json();
  assert.deepEqual([edited.status, edited.approval_hash], ['draft', null]);
  assert.equal((await call('POST', `/api/v1/drafts/${draft.id}/manual-send`, 'board-a', { confirmed: true })).status, 409);
  assert.equal((await call('PATCH', `/api/v1/drafts/${draft.id}`, 'board-a', { subject: 'Hi\r\nBcc: x@evil.test' })).status, 400);
  assert.equal((await call('POST', `/api/v1/drafts/${draft.id}/approve`, 'admin')).status, 200);
});

test('compose rechecks consent, contact and archive after approval', async (t) => {
  const { call, asOwner } = await setup(t);
  const approve = async () => {
    const draft = await (await call('POST', '/api/v1/drafts', 'board-a', thanks)).json();
    assert.equal((await call('POST', `/api/v1/drafts/${draft.id}/approve`, 'board-a')).status, 200);
    return `/api/v1/drafts/${draft.id}/compose`;
  };
  const unchanged = await approve();
  assert.equal((await call('GET', unchanged, 'board-a')).status, 200);
  const consent = await approve();
  await asOwner(`UPDATE donors SET consent = 'denied' WHERE id = '${DONOR_A}'`);
  assert.equal((await call('GET', consent, 'board-a')).status, 409);
  assert.equal((await call('POST', consent.replace('compose', 'manual-send'), 'board-a', { confirmed: true })).status, 409);
  await asOwner(`UPDATE donors SET consent = 'granted' WHERE id = '${DONOR_A}'`);
  const contact = await approve();
  await asOwner(`UPDATE donors SET email = 'avery.new@example.org' WHERE id = '${DONOR_A}'`);
  assert.equal((await call('GET', contact, 'board-a')).status, 409);
  await asOwner(`UPDATE donors SET email = 'avery@example.org' WHERE id = '${DONOR_A}'`);
  const archived = await approve();
  await asOwner(`UPDATE donors SET archived_at = now() WHERE id = '${DONOR_A}'`);
  assert.equal((await call('GET', archived, 'board-a')).status, 409);
  assert.equal((await call('POST', archived.replace('compose', 'manual-send'), 'board-a', { confirmed: true })).status, 409);
});

test('a confirmed manual send is logged once, freezes the draft, and closes the quarter touch', async (t) => {
  const { call, asOwner } = await setup(t);
  const draft = await (await call('POST', '/api/v1/drafts', 'board-a', thanks)).json();
  await call('POST', `/api/v1/drafts/${draft.id}/approve`, 'board-a');
  for (const body of [{}, { confirmed: false }, { confirmed: 'yes' }]) {
    assert.equal((await call('POST', `/api/v1/drafts/${draft.id}/manual-send`, 'board-a', body)).status, 400, JSON.stringify(body));
  }
  const sent = await (await call('POST', `/api/v1/drafts/${draft.id}/manual-send`, 'board-a', { confirmed: true })).json();
  assert.deepEqual(sent, { status: 'logged', closed_follow_ups: 1, already_logged: false });
  const again = await (await call('POST', `/api/v1/drafts/${draft.id}/manual-send`, 'board-a', { confirmed: true })).json();
  assert.deepEqual(again, { status: 'logged', closed_follow_ups: 0, already_logged: true });
  assert.equal((await call('PATCH', `/api/v1/drafts/${draft.id}`, 'board-a', { body: 'x' })).status, 409);
  const comms = await asOwner<{ status: string; qualifying: boolean }>('SELECT status, qualifying FROM communications');
  assert.deepEqual(comms, [{ status: 'logged_manual', qualifying: true }]);
  const touches = await asOwner<{ status: string; completed_by: string }>("SELECT status, completed_by FROM follow_ups");
  assert.deepEqual(touches, [{ status: 'done', completed_by: BOARD_A }]);
  const audits = (await asOwner<{ action: string }>('SELECT action FROM audit_events ORDER BY created_at')).map((r) => r.action);
  assert.deepEqual(audits, ['draft.create', 'draft.approve', 'draft.manual_send']);
});

test('logging a call is a qualifying contact; the timeline shows only visible donors, newest first', async (t) => {
  const { call } = await setup(t);
  const logged = await call('POST', `/api/v1/donors/${DONOR_A}/communications`, 'board-a',
    { channel: 'call', occurred_at: '2026-11-13T15:00:00-07:00', note: 'Interested in visiting a class' });
  assert.equal(logged.status, 201);
  assert.deepEqual(await logged.json(), { status: 'logged_contact', closed_follow_ups: 1 });
  await call('POST', `/api/v1/donors/${DONOR_A}/communications`, 'board-a', { channel: 'meeting', occurred_at: NOW });
  assert.equal((await call('POST', `/api/v1/donors/${DONOR_B}/communications`, 'board-a',
    { channel: 'call', occurred_at: NOW })).status, 404);
  for (const body of [{ channel: 'fax', occurred_at: NOW }, { channel: 'call', occurred_at: 'yesterday' },
    { channel: 'call', occurred_at: NOW, note: 'x'.repeat(2001) }]) {
    assert.equal((await call('POST', `/api/v1/donors/${DONOR_A}/communications`, 'board-a', body)).status, 400, JSON.stringify(body));
  }
  const timeline = await (await call('GET', `/api/v1/donors/${DONOR_A}/communications`, 'board-a')).json();
  assert.deepEqual(timeline.items.map((c: { channel: string }) => c.channel), ['meeting', 'call']);
  assert.equal(timeline.items[1].note, 'Interested in visiting a class');
  assert.equal((await call('GET', `/api/v1/donors/${DONOR_A}/communications`, 'board-b')).status, 404);
});

test('the message routes are mounted in the real app behind its session and origin checks', async (t) => {
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
  const json = { 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/v1/drafts`, { method: 'POST', headers: json, body: JSON.stringify(thanks) })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/donors/${DONOR_A}/communications`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/drafts/${DONOR_A}/compose`, { headers: { Origin: 'https://evil.example' } })).status, 403);
});
