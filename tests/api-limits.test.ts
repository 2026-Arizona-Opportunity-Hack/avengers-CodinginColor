import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../db/migrate.ts';

test('private SQL rate counters enforce runtime boundaries and never reset when limits change', async t => {
  const db = new PGlite(); t.after(() => db.close());
  const client = { query: async (q: string,v?:unknown[]) => v ? db.query<Record<string,unknown>>(q,v) : (await db.exec(q)).at(-1)! };
  const applied = await migrate(client,fileURLToPath(new URL('../db/migrations/',import.meta.url)));
  assert.ok(applied.includes('014_api_limits.sql')); assert.ok(applied.includes('012_member_admin.sql'));
  assert.deepEqual(await migrate(client,fileURLToPath(new URL('../db/migrations/',import.meta.url))),[]);
  await db.exec(`CREATE ROLE limit_test NOLOGIN NOINHERIT; GRANT cic_runtime TO limit_test;
    INSERT INTO api_rate_windows(bucket,window_start,hits) VALUES('expired',date_trunc('minute',clock_timestamp())-interval '3 minutes',1);
    SET SESSION AUTHORIZATION limit_test; SET ROLE cic_runtime;`);
  const consume = async (bucket: string|null,limit: number|null) => (await db.query<{allowed:boolean}>(
    'SELECT public.cic_consume_limit($1,$2) AS allowed',[bucket,limit])).rows[0].allowed;
  assert.equal(await consume('sha256-fixture',3),true);
  assert.equal(await consume('sha256-fixture',3),true);
  assert.equal(await consume('sha256-fixture',3),true);
  assert.equal(await consume('sha256-fixture',1),false);
  assert.equal(await consume('sha256-fixture',3),false,'lowering a limit must not reset an exhausted counter');
  assert.equal(await consume('independent-fixture',1),true); assert.equal(await consume('independent-fixture',1),false);
  await assert.rejects(db.query('SELECT * FROM public.api_rate_windows'),/permission denied/);
  await assert.rejects(db.query("INSERT INTO public.api_rate_windows VALUES('unsafe',now(),1)"),/permission denied/);
  for (const [bucket,limit] of [[null,1],['x'.repeat(161),1],['bucket',null],['bucket',0],['bucket',3001]] as const)
    await assert.rejects(consume(bucket,limit),/Invalid rate limit/);
  await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.equal((await db.query("SELECT * FROM api_rate_windows WHERE bucket='expired'")).rows.length,0);
  const ownership = (await db.query<{prosecdef:boolean;proconfig:string[]}>('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=\'public.cic_consume_limit(text,integer)\'::regprocedure')).rows[0];
  assert.equal(ownership.prosecdef,true); assert.ok(ownership.proconfig.includes('search_path=pg_catalog'));
  await db.exec('CREATE ROLE limit_outsider NOLOGIN NOINHERIT; SET SESSION AUTHORIZATION limit_outsider');
  await assert.rejects(consume('outside',1),/permission denied/);
});
