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
import { createReportingRouter } from './reporting.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = id(1), OTHER_ORG = id(2), ADMIN = id(10), BOARD_A = id(11), BOARD_B = id(12), FOREIGN = id(13);
const AI = id(20), CAMP = id(21), AI_FUND = id(30), CAMP_FUND = id(31);
const FUNDER = id(40), DONOR_A = id(41), DONOR_B = id(42), FOREIGN_DONOR = id(43);

async function setup(t: test.TestContext) {
  const sql = new PGlite();
  t.after(() => sql.close());
  const raw = { query: async (q: string, v?: unknown[]) => v ? sql.query<Record<string, unknown>>(q, v) : (await sql.exec(q)).at(-1)! };
  await migrate(raw, fileURLToPath(new URL('../../db/migrations/', import.meta.url)));
  await sql.exec(`
    INSERT INTO organizations (id, name) VALUES ('${ORG}', 'CIC'), ('${OTHER_ORG}', 'Other');
    INSERT INTO memberships (id, org_id, clerk_subject, role) VALUES
      ('${ADMIN}', '${ORG}', 'admin', 'admin'), ('${BOARD_A}', '${ORG}', 'board-a', 'board'),
      ('${BOARD_B}', '${ORG}', 'board-b', 'board'), ('${FOREIGN}', '${OTHER_ORG}', 'foreign', 'board');
    INSERT INTO programs (id, org_id, title) VALUES ('${AI}', '${ORG}', 'AI Academy'), ('${CAMP}', '${ORG}', 'Summer Camp');
    INSERT INTO campaigns (id, org_id, program_id, title) VALUES
      ('${AI_FUND}', '${ORG}', '${AI}', 'AI Academy Fund'), ('${CAMP_FUND}', '${ORG}', '${CAMP}', 'Camp');
    INSERT INTO donors (id, org_id, owner_id, name) VALUES
      ('${FUNDER}', '${ORG}', '${BOARD_A}', '=Example Foundation'), ('${DONOR_A}', '${ORG}', '${BOARD_A}', 'Avery Rivera'),
      ('${DONOR_B}', '${ORG}', '${BOARD_B}', 'Jordan Chen'), ('${FOREIGN_DONOR}', '${OTHER_ORG}', '${FOREIGN}', 'Not CIC');
    INSERT INTO gifts (org_id, donor_id, campaign_id, amount_cents, refund_cents, currency, occurred_at, status, source, external_id) VALUES
      ('${ORG}', '${FUNDER}', '${AI_FUND}', 2500000, 0, 'USD', '2025-03-15T12:00:00-07:00', 'settled', 'sheet', 'f1'),
      ('${ORG}', '${FUNDER}', '${AI_FUND}', 3000000, 0, 'USD', '2026-03-15T12:00:00-07:00', 'settled', 'sheet', 'f2'),
      ('${ORG}', '${FUNDER}', '${CAMP_FUND}', 1000, 0, 'USD', '2026-04-01T12:00:00-07:00', 'settled', 'sheet', 'f3'),
      ('${ORG}', '${FUNDER}', NULL, 500, 0, 'USD', '2026-05-01T12:00:00-07:00', 'settled', 'sheet', 'f4'),
      ('${ORG}', '${DONOR_A}', '${AI_FUND}', 5000, 0, 'USD', '2025-06-01T12:00:00-07:00', 'settled', 'zeffy', 'a1'),
      ('${ORG}', '${DONOR_B}', NULL, 7500, 0, 'USD', '2026-02-01T12:00:00.123456-07:00', 'settled', 'benevity', 'b1'),
      ('${OTHER_ORG}', '${FOREIGN_DONOR}', NULL, 9999, 0, 'USD', '2026-02-01T12:00:00-07:00', 'settled', 'zeffy', 'x1');
    CREATE ROLE cic_api_report NOLOGIN NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO cic_api_report;
    SET SESSION AUTHORIZATION cic_api_report;`);
  const db: Database = { connect: async () => ({
    query: (q, v) => sql.query<Record<string, unknown>>(q, v), release: () => {},
  }) };
  const identities: Record<string, Identity> = {
    'Bearer admin': { subject: 'admin', mfa: true }, 'Bearer board-a': { subject: 'board-a', mfa: false },
    'Bearer board-b': { subject: 'board-b', mfa: false }, 'Bearer foreign': { subject: 'foreign', mfa: false },
  };
  const env = EnvSchema.parse({ DATABASE_URL: 'postgresql://localhost/test', CIC_ORG_ID: ORG,
    CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev', APP_ORIGIN: 'http://localhost:4200' });
  const app = express();
  app.use(createReportingRouter(env, db, async (header) => {
    const identity = identities[header ?? ''];
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
  const get = (path: string, who?: string) => fetch(`http://127.0.0.1:${address.port}${path}`,
    { headers: who ? { Authorization: `Bearer ${who}` } : {} });
  const upload = (body: unknown, who = 'admin') => fetch(`http://127.0.0.1:${address.port}/api/v1/reports/outcomes`,
    { method: 'POST', headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { sql, get, upload };
}

test('approved aggregate uploads are scoped, atomic, audited and included in packets', async t => {
  const { sql, get, upload } = await setup(t);
  const row = { program_id: AI, from: '2026-01-01', to: '2027-01-01', metric: 'Completed', value: 0,
    unit: 'students', denominator: 10, source: 'Approved aggregate workbook' };
  for (const who of ['board-a', 'foreign', '']) assert.notEqual((await upload({ approved: true, outcomes: [row] }, who)).status, 201);
  for (const changed of [
    { approved: false, outcomes: [row] }, { approved: true, outcomes: [{ ...row, from: '2026-02-30' }] },
    { approved: true, outcomes: [{ ...row, denominator: 0 }] }, { approved: true, outcomes: [{ ...row, student: 'private' }] },
  ]) assert.equal((await upload(changed)).status, 400);
  assert.equal((await upload({ approved: true, outcomes: [row, { ...row, program_id: id(999) }] })).status, 404);
  const path = `/api/v1/reports/funder-packet?funderId=${FUNDER}&programId=${AI}&from=2026-01-01&to=2027-01-01`;
  assert.equal((await (await get(path, 'admin')).json()).outcomes_status, 'unavailable', 'failed batch rolls back');
  assert.equal((await upload({ approved: true, outcomes: [row, { ...row, metric: 'Survey', value: null, denominator: null }] })).status, 201);
  assert.equal((await upload({ approved: true, outcomes: [{ ...row, source: 'Corrected aggregate source' }] })).status, 201);
  const packet = await (await get(path, 'admin')).json();
  assert.equal(packet.outcomes_status, 'available'); assert.equal(packet.outcomes.length, 2, 'correction does not duplicate');
  assert.equal(packet.outcomes[0].value, 0); assert.equal(packet.outcomes[0].source, 'Corrected aggregate source');
  assert.equal(packet.outcomes[0].denominator, 10); assert.ok(packet.outcomes[0].approved_at);
  assert.equal(packet.outcomes[1].value, null); assert.equal(packet.outcomes[1].status, 'not_reported');
  const csv = await (await get(path + '&format=csv', 'admin')).text();
  assert.match(csv, /Completed,0,students,10/); assert.match(csv, /Survey,Not reported/);
  assert.equal((await (await get(path.replace(`programId=${AI}`, `programId=${CAMP}`), 'admin')).json()).outcomes_status, 'unavailable');
  assert.equal((await (await get(path.replace('from=2026-01-01&to=2027-01-01', 'from=2027-01-01&to=2028-01-01'), 'admin')).json()).outcomes_status, 'unavailable');
  await sql.exec('SET SESSION AUTHORIZATION postgres;');
  assert.equal((await sql.query("SELECT * FROM audit_events WHERE action = 'report.outcome.approve'")).rows.length, 3);
  await sql.exec(`SET ROLE cic_runtime; SELECT set_config('app.org_id','${ORG}',false),set_config('app.user_id','board-a',false);`);
  assert.equal((await sql.query('SELECT * FROM program_outcomes')).rows.length, 0, 'RLS hides aggregates from board direct reads');
});

test('retention report: admins see every CIC donor, board members only their own, never other orgs', async (t) => {
  const { get } = await setup(t);
  const admin = await (await get('/api/v1/reports/retention?asOf=2026-11-14', 'admin')).json();
  assert.equal(admin.as_of, '2026-11-14');
  assert.deepEqual(admin.windows.current, { from: '2026-01-01T00:00:00-07:00', to: '2026-11-15T00:00:00-07:00' });
  const segments = Object.fromEntries(admin.byCurrency.USD.donors.map((d: { name: string; segment: string }) => [d.name, d.segment]));
  assert.deepEqual(segments, { '=Example Foundation': 'increased', 'Avery Rivera': 'lapsed', 'Jordan Chen': 'new' });
  assert.deepEqual(admin.byCurrency.USD.totals, { prior_cents: 2505000, current_cents: 3009000 });

  const boardA = await (await get('/api/v1/reports/retention?asOf=2026-11-14', 'board-a')).json();
  assert.deepEqual(boardA.byCurrency.USD.donors.map((d: { donor_id: string }) => d.donor_id).sort(), [FUNDER, DONOR_A].sort());
  const boardB = await (await get('/api/v1/reports/retention?asOf=2026-11-14', 'board-b')).json();
  assert.deepEqual(boardB.byCurrency.USD.donors.map((d: { donor_id: string }) => d.donor_id), [DONOR_B]);
});

test('retention report rejects bad input and unauthorized callers', async (t) => {
  const { get } = await setup(t);
  assert.equal((await get('/api/v1/reports/retention?asOf=2026-11-14')).status, 401);
  assert.equal((await get('/api/v1/reports/retention?asOf=2026-11-14', 'foreign')).status, 403);
  for (const q of ['asOf=2026-02-30', 'asOf=2026-11-14&groupBy=x', 'asOf=yesterday', '']) {
    assert.equal((await get(`/api/v1/reports/retention?${q}`, 'admin')).status, 400, q);
  }
});

test('retention filters intersect scoped owners/programs/campaigns/acquisition cohorts and match periods', async t => {
  const { get } = await setup(t);
  const base = '/api/v1/reports/retention?asOf=2026-11-14';
  const filtered = async (query: string, who = 'admin') => {
    const response = await get(base + query, who); assert.equal(response.status, 200); return response.json();
  };
  const program = await filtered(`&programId=${AI}&ownerId=${BOARD_A}&cohort=2025`);
  assert.deepEqual(program.byCurrency.USD.totals, { prior_cents: 2505000, current_cents: 3000000 });
  const campaign = await filtered(`&campaignId=${CAMP_FUND}`);
  assert.deepEqual(campaign.byCurrency.USD.totals, { prior_cents: 0, current_cents: 1000 });
  assert.deepEqual((await filtered(`&ownerId=${BOARD_B}`, 'board-a')).byCurrency, {});
  assert.deepEqual((await filtered(`&programId=${id(999)}`)).byCurrency, {});
  assert.deepEqual((await filtered(`&ownerId=${BOARD_A}&cohort=2026`)).byCurrency, {});
  const period = await filtered('&from=2026-04-01');
  assert.equal(period.windows.current.from, '2026-04-01T00:00:00-07:00');
  assert.equal(period.windows.prior.from, '2025-04-01T00:00:00-07:00');
  assert.deepEqual(period.byCurrency.USD.totals, { prior_cents: 5000, current_cents: 1500 });
  for (const query of ['&from=2026-02-30', '&from=2025-01-01', '&from=2026-12-01', '&cohort=all', '&ownerId=admin'])
    assert.equal((await get(base + query, 'admin')).status, 400, query);
});

test('funder packet: admin-only JSON with program vs unattributed totals and unavailable outcomes', async (t) => {
  const { sql, get } = await setup(t);
  const path = `/api/v1/reports/funder-packet?funderId=${FUNDER}&programId=${AI}&from=2026-01-01&to=2027-01-01`;
  for (const who of ['board-a', 'board-b']) assert.equal((await get(path, who)).status, 403, who);
  const res = await get(path, 'admin');
  assert.equal(res.status, 200);
  const packet = await res.json();
  assert.deepEqual(packet.funder, { name: '=Example Foundation' });
  assert.deepEqual(packet.program, { id: AI, title: 'AI Academy' });
  assert.deepEqual(packet.totals, {
    program: { USD: { gifts: 1, gross_cents: 3000000, refund_cents: 0, net_cents: 3000000 } },
    unattributed: { USD: { gifts: 1, gross_cents: 500, refund_cents: 0, net_cents: 500 } },
  });
  assert.equal(packet.outcomes_status, 'unavailable');
  // PGlite ignores RESET SESSION AUTHORIZATION, so switch back to the superuser explicitly.
  await sql.exec('SET SESSION AUTHORIZATION postgres;');
  assert.deepEqual((await sql.query("SELECT actor_id, action, target_id, status FROM audit_events")).rows,
    [{ actor_id: ADMIN, action: 'report.funder_packet.export', target_id: FUNDER, status: 'success' }]);
});

test('funder packet CSV is a safe attachment; missing funder or program is 404, bad query 400', async (t) => {
  const { get } = await setup(t);
  const base = `/api/v1/reports/funder-packet?programId=${AI}&from=2026-01-01&to=2027-01-01`;
  const res = await get(`${base}&funderId=${FUNDER}&format=csv`, 'admin');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/csv/);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="funder-packet.csv"');
  const csv = await res.text();
  assert.match(csv, /^Funder packet\r\nFunder,'=Example Foundation\r\n/);
  assert.equal((await get(`${base}&funderId=${FOREIGN_DONOR}`, 'admin')).status, 404);
  assert.equal((await get(`/api/v1/reports/funder-packet?funderId=${FUNDER}&programId=${id(99)}&from=2026-01-01&to=2027-01-01`, 'admin')).status, 404);
  for (const q of [`funderId=nope&programId=${AI}&from=2026-01-01&to=2027-01-01`, `funderId=${FUNDER}&programId=${AI}&from=2026-01-01`,
    `funderId=${FUNDER}&programId=${AI}&from=2026-01-01&to=2027-01-01&format=pdf`]) {
    assert.equal((await get(`/api/v1/reports/funder-packet?${q}`, 'admin')).status, 400, q);
  }
});

test('the reporting routes are mounted in the real app behind its auth and origin checks', async (t) => {
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
  for (const path of ['/api/v1/reports/retention?asOf=2026-11-14',
    `/api/v1/reports/funder-packet?funderId=${FUNDER}&programId=${AI}&from=2026-01-01&to=2027-01-01`]) {
    assert.equal((await fetch(base + path)).status, 401, path);
    assert.equal((await fetch(base + path, { headers: { Origin: 'https://evil.example' } })).status, 403, path);
  }
  assert.equal((await fetch(`${base}/api/v1/reports/nope`)).status, 404);
});
