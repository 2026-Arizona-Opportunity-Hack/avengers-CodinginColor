import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../db/migrate.ts';
import { createApp } from './app.ts';
import { EnvSchema, HttpError } from './env.ts';
import type { Database } from './db.ts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('only MFA admins list active same-org owners, including owners with no donors', async t => {
  const sql = new PGlite(); t.after(() => sql.close());
  await migrate({ query: async (q, v) => v ? sql.query(q, v) : (await sql.exec(q)).at(-1)! },
    fileURLToPath(new URL('../../db/migrations/', import.meta.url)));
  await sql.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','CIC'),('${id(2)}','Other');
    INSERT INTO memberships(id,org_id,clerk_subject,role,active) VALUES
    ('${id(10)}','${id(1)}','admin','admin',true),('${id(11)}','${id(1)}','board','board',true),
    ('${id(12)}','${id(1)}','empty','board',true),('${id(13)}','${id(1)}','inactive','board',false),
    ('${id(14)}','${id(2)}','foreign','board',true);
    CREATE ROLE owner_test NOLOGIN NOINHERIT; GRANT cic_runtime TO owner_test;
    SET SESSION AUTHORIZATION owner_test;`);
  const db: Database = { connect: async () => ({ query: (q,v) => sql.query<Record<string,unknown>>(q,v), release() {} }) };
  const env = EnvSchema.parse({ DATABASE_URL:'postgresql://localhost/test', CIC_ORG_ID:id(1), CLERK_SECRET_KEY:'sk_test_fixture',
    CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev', APP_ORIGIN:'http://localhost:4200' });
  const server = createApp(env, db, async header => {
    const who = header?.replace('Bearer ', '');
    if (!who) throw new HttpError(401);
    return { subject: who === 'admin-no-mfa' ? 'admin' : who, mfa: who === 'admin' };
  }).listen(0, '127.0.0.1');
  await once(server,'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const get = (who?: string) => fetch(`http://127.0.0.1:${address.port}/api/v1/owners`, { headers: who ? { Authorization:`Bearer ${who}` } : {} });
  assert.deepEqual(await (await get('admin')).json(), { items: [
    {id:id(11),role:'board',active:true}, {id:id(12),role:'board',active:true},
  ] });
  for (const who of ['board','foreign','inactive','admin-no-mfa']) assert.equal((await get(who)).status,403);
  assert.equal((await get()).status,401);
  await sql.exec('BEGIN; SET LOCAL ROLE cic_runtime');
  await sql.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id','board',true)",[id(1)]);
  await assert.rejects(sql.query('SELECT * FROM public.assignable_owners()'), /admin/);
  await sql.exec('ROLLBACK');
});
