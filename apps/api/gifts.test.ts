import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { GiftSchema } from '../../packages/contracts/index.ts';
import { createApp } from './app.ts';
import type { Database } from './db.ts';
import { EnvSchema, HttpError } from './env.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const json = (method: string, value: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

test('manual gift ledger keeps scope, exact money and time, idempotent replay and atomic audit', async t => {
  const sql = new PGlite();
  t.after(() => sql.close());
  await sql.exec(await readFile(new URL('../../db/migrations/001_core.sql', import.meta.url), 'utf8'));
  await sql.query("INSERT INTO organizations(id,name) VALUES($1,'CIC'),($2,'Other')", [id(1), id(2)]);
  await sql.query("INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES ($1,$4,'board','board'),($2,$4,'other','board'),($3,$4,'admin','admin'),($5,$6,'foreign','board')", [id(3), id(4), id(5), id(1), id(6), id(2)]);
  await sql.query("INSERT INTO programs(id,org_id,title) VALUES($1,$3,'P'),($2,$4,'X')", [id(7), id(8), id(1), id(2)]);
  await sql.query("INSERT INTO campaigns(id,org_id,program_id,title) VALUES($1,$3,$5,'C'),($2,$4,$6,'X')", [id(9), id(10), id(1), id(2), id(7), id(8)]);
  for (const [n, org, owner, name, archived] of [[20, 1, 3, 'Same', true], [21, 1, 4, 'Other', false], [22, 2, 6, 'Foreign', false]] as const)
    await sql.query('INSERT INTO donors(id,org_id,owner_id,name,archived_at) VALUES($1,$2,$3,$4,CASE WHEN $5::boolean THEN now() END)', [id(n), id(org), id(owner), name, archived]);
  await sql.exec('CREATE ROLE gift_test LOGIN NOINHERIT; GRANT cic_runtime TO gift_test; SET SESSION AUTHORIZATION gift_test');
  let failAudit = false;
  const db: Database = { connect: async () => ({
    query: (text, values) => {
      if (failAudit && /INSERT INTO audit_events/i.test(text)) throw new Error('injected audit failure');
      return sql.query<Record<string, unknown>>(text, values);
    },
    release: () => {},
  }) };
  const env = EnvSchema.parse({ DATABASE_URL: 'postgresql://localhost/test', CIC_ORG_ID: id(1), CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev', APP_ORIGIN: 'http://localhost:4200' });
  const server = createApp(env, db, async header => {
    const subject = { 'Bearer board': 'board', 'Bearer other': 'other', 'Bearer admin': 'admin', 'Bearer foreign': 'foreign' }[header ?? ''];
    if (!subject) throw new HttpError(401);
    return { subject, mfa: subject === 'admin' };
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const request = (path: string, options: RequestInit = {}, role: string | null = 'board') =>
    fetch(base + path, { ...options, headers: { ...(role ? { Authorization: `Bearer ${role}` } : {}), ...options.headers } });
  const post = (value: unknown, role: string | null = 'board') => request('/gifts', json('POST', value), role);
  const patch = (value: unknown) => json('PATCH', value);
  const body = (over: Record<string, unknown> = {}) => ({ donor_id: id(20), campaign_id: id(9), amount_cents: 9007199254740991,
    refund_cents: 0, currency: 'USD', occurred_at: '2026-02-01T12:00:00.123456-07:00', status: 'settled', ...over });

  assert.equal((await request('/gifts?donor_id=' + id(20), {}, null)).status, 401);
  assert.equal((await post(body({}), null)).status, 401);
  assert.equal((await request('/gifts/' + id(999), patch({ amount_cents: 1 }), null)).status, 401);
  let response = await request('/gifts?donor_id=' + id(20));
  assert.equal(response.status, 200);
  let list = await response.json() as { items: { id: string, amount_cents: number }[], limit: number, offset: number };
  assert.deepEqual([list.items, list.limit, list.offset], [[], 50, 0]);
  for (const query of ['?donor_id=bad', '?donor_id=' + id(20) + '&limit=0', '?donor_id=' + id(20) + '&limit=101',
    '?donor_id=' + id(20) + '&offset=-1', '?donor_id=' + id(20) + '&extra=1', '?donor_id=' + id(20) + '&donor_id=' + id(21)])
    assert.equal((await request('/gifts' + query)).status, 400, query);
  for (const [who, donor] of [['board', id(21)], ['other', id(20)], ['admin', id(22)]] as const)
    assert.equal((await request('/gifts?donor_id=' + donor, {}, who)).status, 404, who + donor);
  assert.equal((await request('/gifts?donor_id=' + id(20), {}, 'foreign')).status, 403);

  for (const value of [{}, body({ source: 'spreadsheet' }), body({ source_row: { batch_id: id(30), row_key: 'r1' } }),
    body({ org_id: id(2) }), body({ owner_id: id(4) }), body({ role: 'admin' }), body({ id: id(30) }),
    body({ amount_cents: 1.5 }), body({ currency: 'usd' }), body({ occurred_at: '2026-02-01' }),
    body({ amount_cents: 100, refund_cents: 101 }), body({ campaign_id: 'nope' }), body({ extra: true }),
    body({ external_id: 'x'.repeat(301) })])
    assert.equal((await post(value)).status, 400, JSON.stringify(value));
  assert.equal((await post(body({ donor_id: id(21) }))).status, 404);
  assert.equal((await post(body({ campaign_id: id(10) }))).status, 400);
  assert.equal((await post(body({ campaign_id: id(999) }))).status, 400);

  response = await post(body({ external_id: 'm-1' }));
  assert.equal(response.status, 201);
  const created = await response.json() as { id: string, amount_cents: number, occurred_at: string, source: string, source_row: unknown, org_id: string };
  assert.deepEqual([created.amount_cents, created.occurred_at, created.source, created.source_row, created.org_id],
    [9007199254740991, '2026-02-01T19:00:00.123456Z', 'manual', null, id(1)]);
  response = await post(body({ external_id: 'm-1' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { id: string }).id, created.id);
  for (const changed of [body({ external_id: 'm-1', amount_cents: 9007199254740990 }),
    body({ external_id: 'm-1', campaign_id: null }), body({ external_id: 'm-1', occurred_at: '2026-02-01T12:00:00.123457-07:00' }),
    body({ external_id: 'm-1', status: 'void' })])
    assert.equal((await post(changed)).status, 409);
  response = await post(body({ donor_id: id(21), external_id: 'm-1' }), 'other');
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), new RegExp(created.id));
  assert.equal((await post(body({ donor_id: id(22), external_id: 'm-2' }), 'foreign')).status, 403);
  assert.equal((await request('/gifts')).status, 200);
  const mine = await (await request('/gifts?limit=1')).json() as { items: { donor_id: string }[] };
  assert.deepEqual(mine.items.map(g => g.donor_id), [id(20)]);
  assert.deepEqual((await (await request('/gifts', {}, 'other')).json() as {items:unknown[]}).items, []);
  const catalog = await (await request('/catalog')).json() as { programs: {title:string}[]; campaigns:{title:string}[] };
  assert.deepEqual(catalog.programs.map(p=>p.title), ['P']);
  assert.deepEqual(catalog.campaigns.map(c=>c.title), ['C']);
  assert.equal((await request('/catalog', {}, null)).status, 401);
  assert.equal((await request('/catalog', {}, 'foreign')).status, 403);

  const twins = [await post(body({ amount_cents: 2500 })), await post(body({ amount_cents: 2500 }))];
  assert.deepEqual(twins.map(twin => twin.status), [201, 201]);
  const [firstTwin, secondTwin] = [await twins[0].json() as { id: string }, await twins[1].json() as { id: string }];
  assert.notEqual(firstTwin.id, secondTwin.id);

  response = await request('/gifts/' + created.id, patch({ amount_cents: 500, refund_cents: 100 }));
  assert.equal(response.status, 200);
  let corrected = await response.json() as { amount_cents: number, refund_cents: number, occurred_at: string, campaign_id: string | null };
  assert.deepEqual([corrected.amount_cents, corrected.refund_cents, corrected.occurred_at, corrected.campaign_id],
    [500, 100, created.occurred_at, id(9)]);
  for (const value of [{}, { donor_id: id(21) }, { source: 'import' }, { source_row: null }, { external_id: 'x' },
    { org_id: id(2) }, { campaign_id: id(10) }, { refund_cents: 501 }, { amount_cents: 1.5 }, { status: 'lost' }])
    assert.equal((await request('/gifts/' + created.id, patch(value))).status, 400, JSON.stringify(value));
  response = await request('/gifts/' + created.id, patch({ campaign_id: null }));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { campaign_id: string | null }).campaign_id, null);
  assert.equal((await request('/gifts/' + created.id, patch({ amount_cents: 1 }), 'other')).status, 404);
  assert.equal((await request('/gifts/' + id(999), patch({ amount_cents: 1 }))).status, 404);
  assert.equal((await request('/gifts/bad', patch({ amount_cents: 1 }))).status, 400);

  failAudit = true;
  assert.equal((await request('/gifts/' + created.id, patch({ amount_cents: 700 }))).status, 503);
  assert.equal((await post(body({ external_id: 'm-fail' }))).status, 503);
  failAudit = false;

  list = await (await request('/gifts?donor_id=' + id(20))).json() as typeof list;
  assert.equal(list.items.length, 3);
  for (const item of list.items) assert.ok(GiftSchema.safeParse(item).success);
  const page = await (await request('/gifts?donor_id=' + id(20) + '&limit=2&offset=2')).json() as typeof list;
  assert.equal(page.items.length, 1);
  const adminList = await (await request('/gifts?donor_id=' + id(20), {}, 'admin')).json() as typeof list;
  assert.deepEqual([adminList.items.length, adminList.items.find(item => item.id === created.id)?.amount_cents], [3, 500]);
  const again = await (await request('/gifts?donor_id=' + id(20))).json() as typeof list;
  assert.deepEqual(again.items.map(item => item.id), list.items.map(item => item.id));

  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.notEqual((await sql.query<{ archived_at: string | null }>('SELECT archived_at FROM donors WHERE id=$1', [id(20)])).rows[0].archived_at, null);
  const rows = await sql.query<{ source: string, source_row: unknown }>("SELECT source, source_row FROM gifts ORDER BY created_at");
  assert.equal(rows.rows.length, 3);
  assert.ok(rows.rows.every(row => row.source === 'manual' && row.source_row === null));
  assert.deepEqual((await sql.query<{ action: string }>('SELECT action FROM audit_events ORDER BY action')).rows.map(row => row.action),
    ['gift.correct', 'gift.correct', 'gift.insert', 'gift.insert', 'gift.insert']);
  assert.equal((await sql.query('SELECT 1 FROM gifts WHERE external_id=$1', ['m-fail'])).rows.length, 0);
});
