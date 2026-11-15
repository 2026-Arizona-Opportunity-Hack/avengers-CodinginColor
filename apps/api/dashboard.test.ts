import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import { createKey, revokeKey } from '../../db/api-key.ts';
import { generateApiKey } from '../../packages/reporting/summary.ts';
import type { Database } from './db.ts';
import { HttpError } from './env.ts';
import { createDashboardRouter } from './dashboard.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = id(1), OTHER = id(2), ADMIN = id(10), BOARD = id(11), OTHER_ADMIN = id(12), AI = id(20), FUND = id(30);
const migrations = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

async function setup(t: test.TestContext, limitPerMinute = 60) {
  const db = new PGlite();
  t.after(() => db.close());
  const owner = { query: async (s: string, v?: unknown[]) => v ? db.query<Record<string, unknown>>(s, v) : (await db.exec(s)).at(-1)! };
  await migrate(owner, migrations);
  const donors = Array.from({ length: 5 }, (_, i) => id(40 + i));
  await db.exec(`
    INSERT INTO organizations (id, name) VALUES ('${ORG}', 'CIC'), ('${OTHER}', 'Other');
    INSERT INTO memberships (id, org_id, clerk_subject, role) VALUES ('${ADMIN}', '${ORG}', 'user_admin', 'admin'),
      ('${BOARD}', '${ORG}', 'user_board', 'board'), ('${OTHER_ADMIN}', '${OTHER}', 'user_other', 'admin');
    INSERT INTO programs (id, org_id, title) VALUES ('${AI}', '${ORG}', 'AI Academy');
    INSERT INTO campaigns (id, org_id, program_id, title) VALUES ('${FUND}', '${ORG}', '${AI}', 'AI Fund');
    INSERT INTO donors (id, org_id, owner_id, name, email) VALUES
      ${donors.map((d, i) => `('${d}', '${ORG}', '${BOARD}', 'Donor ${i}', 'donor${i}@example.org')`).join(',')},
      ('${id(60)}', '${OTHER}', '${OTHER_ADMIN}', 'Other donor', NULL);
    INSERT INTO gifts (org_id, donor_id, campaign_id, amount_cents, refund_cents, currency, occurred_at, status, source, external_id) VALUES
      ${donors.map((d, i) => `('${ORG}', '${d}', '${FUND}', ${1000 * (i + 1)}, 0, 'USD', '2026-0${i + 1}-15T12:00:00-07:00', 'settled', 'zeffy', 'g${i}')`).join(',')},
      ('${ORG}', '${donors[0]}', NULL, 700, 0, 'USD', '2026-06-01T12:00:00-07:00', 'settled', 'sheet', 'g9'),
      ('${OTHER}', '${id(60)}', NULL, 99999, 0, 'USD', '2026-02-01T12:00:00-07:00', 'settled', 'zeffy', 'x1');`);
  const key = await createKey(owner, ORG, { name: 'Org dashboard', adminSubject: 'user_admin' });
  const otherKey = await createKey(owner, OTHER, { name: 'Other', adminSubject: 'user_other' });
  // From here on, the API's connection is a restricted login that can only become cic_runtime.
  await db.exec(`CREATE ROLE cic_app_test NOLOGIN NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO cic_app_test;
    SET SESSION AUTHORIZATION cic_app_test;`);
  const api: Database = { connect: async () => ({ query: (s, v) => db.query<Record<string, unknown>>(s, v), release: () => {} }) };
  const start = async () => {
    const app = express();
    app.use(createDashboardRouter(api, { offset: '-07:00', minDonors: 3, limitPerMinute }));
    const errors: ErrorRequestHandler = (error, _req, res, _next) => {
      res.status(error instanceof HttpError ? error.status : 503).json({ error: 'x' });
    };
    app.use(errors);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
  };
  return { db, owner, key, otherKey, get: await start(), start };
}

test('summary returns suppressed, per-currency aggregates for a valid key and nothing identifying', async (t) => {
  const { key, get } = await setup(t);
  const res = await get('/api/v1/summary?from=2026-01-01&to=2027-01-01&groupBy=program', { Authorization: `Bearer ${key.key}` });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(body.window, { from: '2026-01-01T00:00:00-07:00', to: '2027-01-01T00:00:00-07:00' });
  assert.deepEqual(body.groups, [
    { key: AI, label: 'AI Academy', suppressed: false, donors: 5, currencies: { USD: { gifts: 5, net_cents: 15000 } } },
    { key: 'unattributed', label: 'Unattributed', suppressed: true },
  ]);
  assert.deepEqual(body.totals, { suppressed: false, donors: 5, currencies: { USD: { gifts: 6, net_cents: 15700 } } });
  const text = JSON.stringify(body);
  for (const leak of ['Donor 0', 'donor0@', id(40), 'Other donor']) assert.ok(!text.includes(leak), leak);
  const months = await (await get('/api/v1/summary?from=2026-01-01&to=2026-04-01', { 'X-API-Key': key.key })).json();
  assert.deepEqual(months.groups.map((g: { key: string; suppressed: boolean }) => [g.key, g.suppressed]),
    [['2026-01', true], ['2026-02', true], ['2026-03', true]]);
});

test('summary retention compares prior-year windows per currency and suppresses small cohorts', async (t) => {
  const { db, key, otherKey, get } = await setup(t);
  await db.exec(`SET SESSION AUTHORIZATION postgres;
    INSERT INTO donors(id,org_id,owner_id,name) VALUES
      ${[70, 71, 72, 73].map(n => `('${id(n)}','${ORG}','${BOARD}','Prior donor')`).join(',')};
    INSERT INTO gifts(org_id,donor_id,amount_cents,refund_cents,currency,occurred_at,status,source) VALUES
      ${[40, 41, 42, 70, 71, 72].map(n => `('${ORG}','${id(n)}',100,0,'USD','2025-12-15T12:00:00-07:00','settled','sheet')`).join(',')},
      ('${ORG}','${id(40)}',100,0,'EUR','2025-12-15T12:00:00-07:00','settled','sheet'),
      ('${ORG}','${id(73)}',100,0,'USD','2026-02-15T12:00:00-07:00','settled','sheet'),
      ('${ORG}','${id(40)}',100,0,'EUR','2026-02-15T12:00:00-07:00','settled','sheet');
    SET SESSION AUTHORIZATION cic_app_test;`);
  const path = '/api/v1/summary?from=2026-01-01&to=2027-01-01';
  const body = await (await get(path, { 'X-API-Key': key.key })).json();
  assert.deepEqual(body.retention, {
    windows: { current: body.window, prior: { from: '2025-01-01T00:00:00-07:00', to: '2026-01-01T00:00:00-07:00' } },
    byCurrency: { USD: { suppressed: false, retained_donors: 3, prior_donors: 6 }, EUR: { suppressed: true } },
  });
  const partial = await (await get('/api/v1/summary?from=2026-01-01&to=2026-07-01', { 'X-API-Key': key.key })).json();
  assert.deepEqual(partial.retention.windows.prior, { from: '2025-01-01T00:00:00-07:00', to: '2025-07-01T00:00:00-07:00' });
  const leap = await (await get('/api/v1/summary?from=2024-02-29&to=2024-03-01', { 'X-API-Key': key.key })).json();
  assert.deepEqual(leap.retention.windows.prior, { from: '2023-02-28T00:00:00-07:00', to: '2023-03-01T00:00:00-07:00' });
  const leapEnd = await (await get('/api/v1/summary?from=2024-02-28&to=2024-02-29', { 'X-API-Key': key.key })).json();
  assert.deepEqual(leapEnd.retention.windows.prior, { from: '2023-02-28T00:00:00-07:00', to: '2023-03-01T00:00:00-07:00' });
  const multi = await (await get('/api/v1/summary?from=2025-01-01&to=2027-01-01', { 'X-API-Key': key.key })).json();
  assert.deepEqual(multi.retention.windows.prior, { from: '2024-01-01T00:00:00-07:00', to: '2026-01-01T00:00:00-07:00' });
  const other = await (await get(path, { 'X-API-Key': otherKey.key })).json();
  assert.deepEqual(other.retention.byCurrency, { USD: { suppressed: true } });
  await db.exec(`SET SESSION AUTHORIZATION postgres;
    UPDATE gifts SET status='pending' WHERE donor_id='${id(73)}';
    SET SESSION AUTHORIZATION cic_app_test;`);
  const currentOnly = await (await get(path, { 'X-API-Key': key.key })).json();
  assert.deepEqual(currentOnly.retention.byCurrency.USD, { suppressed: true });
  await db.exec(`SET SESSION AUTHORIZATION postgres;
    UPDATE gifts SET status='settled' WHERE donor_id='${id(73)}';
    DELETE FROM gifts WHERE donor_id='${id(42)}' AND occurred_at >= '2026-01-01';
    SET SESSION AUTHORIZATION cic_app_test;`);
  const small = await (await get(path, { 'X-API-Key': key.key })).json();
  assert.deepEqual(small.retention.byCurrency.USD, { suppressed: true });
  for (const leak of ['Prior donor', id(40), id(70)]) assert.ok(!JSON.stringify(body).includes(leak));
});

test('activity is newest-first, bounded, and donor-free; each key sees only its own org', async (t) => {
  const { key, otherKey, get } = await setup(t);
  const items = await (await get('/api/v1/activity?limit=2', { Authorization: `Bearer ${key.key}` })).json();
  assert.deepEqual(items.items, [
    { date: '2026-06-01', program: 'Unattributed', source: 'sheet', status: 'settled', currency: 'USD', net_cents: 700 },
    { date: '2026-05-15', program: 'AI Academy', source: 'zeffy', status: 'settled', currency: 'USD', net_cents: 5000 },
  ]);
  const other = await (await get('/api/v1/activity', { Authorization: `Bearer ${otherKey.key}` })).json();
  assert.deepEqual(other.items.map((i: { net_cents: number }) => i.net_cents), [99999]);
  for (const q of ['limit=0', 'limit=101', 'limit=abc', 'limit=5&x=1']) {
    assert.equal((await get(`/api/v1/activity?${q}`, { Authorization: `Bearer ${key.key}` })).status, 400, q);
  }
});

test('missing, malformed, unknown and revoked keys are 401; bad queries 400', async (t) => {
  const { owner, key, get } = await setup(t);
  const path = '/api/v1/summary?from=2026-01-01&to=2027-01-01';
  const badHeaders: Record<string, string>[] = [{}, { Authorization: 'Bearer nope' },
    { Authorization: `Bearer ${generateApiKey().key}` }, { Authorization: `Bearer ${key.key}`, 'X-API-Key': key.key }];
  for (const headers of badHeaders) {
    assert.equal((await get(path, headers)).status, 401, JSON.stringify(headers));
  }
  for (const q of ['from=2026-01-01', 'from=2026-02-30&to=2026-03-01', 'from=2026-01-01&to=2027-01-01&groupBy=donor',
    'from=2020-01-01&to=2026-01-02']) {
    assert.equal((await get(`/api/v1/summary?${q}`, { Authorization: `Bearer ${key.key}` })).status, 400, q);
  }
  await owner.query('SET SESSION AUTHORIZATION postgres');
  assert.equal(await revokeKey(owner, ORG, key.hint), 1);
  await owner.query('SET SESSION AUTHORIZATION cic_app_test');
  assert.equal((await get(path, { Authorization: `Bearer ${key.key}` })).status, 401);
});

test('unknown keys leave no rate-limit state behind', async (t) => {
  const { db, get } = await setup(t);
  for (let i = 0; i < 30; i++) {
    const res = await get('/api/v1/summary?from=2026-01-01&to=2027-01-01', { Authorization: `Bearer ${generateApiKey().key}` });
    assert.equal(res.status, 401);
  }
  await db.exec('SET SESSION AUTHORIZATION postgres');
  assert.deepEqual((await db.query('SELECT * FROM api_rate_windows')).rows, []);
});

test('two app instances share quota across routes and commit rejected attempts', async (t) => {
  const { db, key, otherKey, get, start } = await setup(t, 2);
  const other = await start();
  const auth = { 'X-API-Key': key.key };
  assert.equal((await get('/api/v1/activity', auth)).status, 200);
  assert.equal((await other('/api/v1/summary?from=2026-01-01&to=2027-01-01', auth)).status, 200);
  const rejected = await get('/api/v1/activity', auth);
  assert.equal(rejected.status, 429);
  assert.ok(Number(rejected.headers.get('retry-after')) >= 1);
  assert.ok(Number(rejected.headers.get('retry-after')) <= 60);
  assert.equal((await other('/api/v1/activity', auth)).status, 429);
  assert.equal((await other('/api/v1/activity', { 'X-API-Key': otherKey.key })).status, 200);
  await db.exec('SET SESSION AUTHORIZATION postgres');
  const counters = (await db.query<{ bucket: string; hits: number }>('SELECT bucket,hits FROM api_rate_windows')).rows;
  assert.deepEqual(counters.find(row => row.bucket === `aggregate:${key.hash}`), { bucket: `aggregate:${key.hash}`, hits: 4 });
  assert.ok(!JSON.stringify(counters).includes(key.key));
  const events=(await db.query<{org_id:string;route:string;status:number}>('SELECT org_id,route,status FROM aggregate_access_events ORDER BY created_at,id')).rows;
  assert.equal(events.filter(e=>e.org_id===ORG&&e.status===200).length,2);
  assert.equal(events.filter(e=>e.org_id===ORG&&e.status===429).length,2);
  assert.ok(events.some(e=>e.route==='summary')); assert.ok(events.some(e=>e.route==='activity'));
  await revokeKey({ query: (sql, values) => db.query(sql, values) }, ORG, key.hint);
  await db.exec('SET SESSION AUTHORIZATION cic_app_test');
  assert.equal((await other('/api/v1/activity', auth)).status, 401, 'revocation takes precedence over exhausted quota');
});

test('audit failure returns no aggregates and rolls back allowed and rejected quota attempts', async t=>{
  const {db,key,get}=await setup(t,1);
  const auth={'X-API-Key':key.key};
  const deny=async()=>db.exec(`SET SESSION AUTHORIZATION postgres;
    REVOKE EXECUTE ON FUNCTION public.cic_record_aggregate_access(text,text,integer) FROM cic_runtime;
    SET SESSION AUTHORIZATION cic_app_test;`);
  await deny();
  const failed=await get('/api/v1/summary?from=2026-01-01&to=2027-01-01',auth);
  assert.equal(failed.status,503); assert.deepEqual(await failed.json(),{error:'x'});
  await db.exec('SET SESSION AUTHORIZATION postgres');
  assert.deepEqual((await db.query('SELECT * FROM api_rate_windows')).rows,[]);
  assert.deepEqual((await db.query('SELECT * FROM aggregate_access_events')).rows,[]);
  await db.exec(`SET ROLE cic_reporting;
    GRANT EXECUTE ON FUNCTION public.cic_record_aggregate_access(text,text,integer) TO cic_runtime;
    RESET ROLE; SET SESSION AUTHORIZATION cic_app_test;`);
  assert.equal((await get('/api/v1/activity',auth)).status,200);
  await deny();
  assert.equal((await get('/api/v1/activity',auth)).status,503);
  await db.exec('SET SESSION AUTHORIZATION postgres');
  assert.equal((await db.query<{hits:number}>('SELECT hits FROM api_rate_windows')).rows[0].hits,1);
  assert.equal((await db.query('SELECT * FROM aggregate_access_events')).rows.length,1);
});

test('quota dependency failure is closed and leaves no counter', async (t) => {
  const { db, key, get } = await setup(t);
  await db.exec(`SET SESSION AUTHORIZATION postgres;
    REVOKE EXECUTE ON FUNCTION public.cic_consume_limit(text,integer) FROM cic_runtime;
    SET SESSION AUTHORIZATION cic_app_test;`);
  assert.equal((await get('/api/v1/activity', { 'X-API-Key': key.key })).status, 503);
  await db.exec('SET SESSION AUTHORIZATION postgres');
  assert.deepEqual((await db.query('SELECT * FROM api_rate_windows')).rows, []);
});

test('overflowing report totals fail before a successful audit can commit', async t=>{
  const {db,key,get}=await setup(t);
  await db.exec(`SET SESSION AUTHORIZATION postgres;
    UPDATE gifts SET amount_cents=9007199254740991 WHERE external_id='g0';
    SET SESSION AUTHORIZATION cic_app_test;`);
  const failed=await get('/api/v1/summary?from=2026-01-01&to=2027-01-01',{'X-API-Key':key.key});
  assert.equal(failed.status,503); assert.deepEqual(await failed.json(),{error:'x'});
  await db.exec('SET SESSION AUTHORIZATION postgres');
  assert.deepEqual((await db.query('SELECT * FROM aggregate_access_events')).rows,[]);
  assert.deepEqual((await db.query('SELECT * FROM api_rate_windows')).rows,[]);
});

test('each key is rate limited and told when to retry', async (t) => {
  const { key, get } = await setup(t, 2);
  const path = '/api/v1/summary?from=2026-01-01&to=2027-01-01';
  const auth = { Authorization: `Bearer ${key.key}` };
  assert.equal((await get(path, auth)).status, 200);
  assert.equal((await get(path, auth)).status, 200);
  const limited = await get(path, auth);
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/);
});

test('the key tool stores only the hash, needs an active admin, and revokes by hint', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const owner = { query: async (s: string, v?: unknown[]) => v ? db.query<Record<string, unknown>>(s, v) : (await db.exec(s)).at(-1)! };
  await migrate(owner, migrations);
  await db.exec(`INSERT INTO organizations (id, name) VALUES ('${ORG}', 'CIC');
    INSERT INTO memberships (id, org_id, clerk_subject, role, active) VALUES ('${ADMIN}', '${ORG}', 'user_admin', 'admin', true),
      ('${BOARD}', '${ORG}', 'user_board', 'board', true), ('${id(13)}', '${ORG}', 'user_gone', 'admin', false);`);
  const made = await createKey(owner, ORG, { name: 'Org dashboard', adminSubject: 'user_admin' });
  assert.match(made.key, /^cic_live_/);
  const [stored] = (await db.query<Record<string, string>>('SELECT key_hash, hint, created_by FROM api_keys')).rows;
  assert.deepEqual(stored, { key_hash: made.hash, hint: made.hint, created_by: ADMIN });
  assert.ok(!JSON.stringify((await db.query('SELECT * FROM api_keys')).rows).includes(made.key));
  await assert.rejects(createKey(owner, ORG, { name: 'x', adminSubject: 'user_board' }), /active admin/);
  await assert.rejects(createKey(owner, ORG, { name: 'x', adminSubject: 'user_gone' }), /active admin/);
  assert.equal(await revokeKey(owner, ORG, made.hint), 1);
  assert.equal(await revokeKey(owner, ORG, made.hint), 0);
});

test('the dashboard routes are mounted in the real app and never need a Clerk session', async (t) => {
  const { createApp } = await import('./app.ts');
  const { EnvSchema } = await import('./env.ts');
  const env = EnvSchema.parse({ DATABASE_URL: 'postgresql://localhost/test', CIC_ORG_ID: ORG,
    CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev', APP_ORIGIN: 'http://localhost:4200' });
  const db: Database = { connect: async () => assert.fail('requests without a valid key must not reach the database') };
  const server = createApp(env, db, async () => assert.fail('dashboard routes must not call Clerk')).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/v1/summary?from=2026-01-01&to=2027-01-01`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/activity`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/activity`, { headers: { Origin: 'https://evil.example' } })).status, 403);
});
