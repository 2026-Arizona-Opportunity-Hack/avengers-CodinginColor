import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../db/migrate.ts';

const org='00000000-0000-4000-8000-000000000001', foreign='00000000-0000-4000-8000-000000000002';
const key='00000000-0000-4000-8000-000000000003', otherKey='00000000-0000-4000-8000-000000000004';
const hash='a'.repeat(64), otherHash='b'.repeat(64);
test('aggregate audit is identifier-only, key authenticated, append-only and admin/org scoped', async t => {
  const db=new PGlite(); t.after(()=>db.close());
  const owner={query:async(sql:string,v?:unknown[])=>v?db.query<Record<string,unknown>>(sql,v):(await db.exec(sql)).at(-1)!};
  const dir=fileURLToPath(new URL('../db/migrations/',import.meta.url));
  assert.ok((await migrate(owner,dir)).includes('019_aggregate_access_audit.sql'));
  assert.deepEqual(await migrate(owner,dir),[]);
  await db.exec(`INSERT INTO organizations(id,name) VALUES('${org}','CIC'),('${foreign}','Other');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES
      ('${org}','${org}','admin','admin'),('${foreign}','${foreign}','foreign','admin'),('${key}','${org}','board','board');
    INSERT INTO api_keys(id,org_id,name,key_hash,hint,scopes,created_by) VALUES
      ('${key}','${org}','Primary','${hash}','cic_live_aaaa',ARRAY['read:aggregates'],'${org}'),
      ('${otherKey}','${foreign}','Foreign','${otherHash}','cic_live_bbbb',ARRAY['read:aggregates'],'${foreign}');
    CREATE ROLE audit_runtime NOLOGIN NOINHERIT; GRANT cic_runtime TO audit_runtime;
    SET SESSION AUTHORIZATION audit_runtime; SET ROLE cic_runtime;`);
  const record=(h:unknown,r:unknown,s:unknown)=>db.query('SELECT public.cic_record_aggregate_access($1,$2,$3)',[h,r,s]);
  await record(hash,'summary',200); await record(hash,'activity',429); await record(otherHash,'summary',200);
  for(const args of [[null,'summary',200],[hash,null,200],[hash,'summary',null],['bad','summary',200],
    [hash,'private?email=x',200],[hash,'summary',503],['c'.repeat(64),'summary',200]])
    await assert.rejects(record(...args as [unknown,unknown,unknown]));
  assert.deepEqual((await db.query('SELECT * FROM aggregate_access_events')).rows,[]);
  await db.query("SELECT set_config('app.org_id',$1,false),set_config('app.user_id','admin',false)",[org]);
  assert.equal((await db.query('SELECT * FROM aggregate_access_events')).rows.length,2);
  await db.query("SELECT set_config('app.user_id','board',false)");
  assert.deepEqual((await db.query('SELECT * FROM aggregate_access_events')).rows,[]);
  await db.query("SELECT set_config('app.org_id',$1,false),set_config('app.user_id','foreign',false)",[foreign]);
  assert.equal((await db.query('SELECT * FROM aggregate_access_events')).rows.length,1);
  for(const sql of ['DELETE FROM aggregate_access_events','UPDATE aggregate_access_events SET status=429',
    `INSERT INTO aggregate_access_events(org_id,key_id,route,status) VALUES('${org}','${key}','summary',200)`])
    await assert.rejects(db.query(sql),/permission denied/);
  await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  await db.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[key]);
  await db.exec('SET SESSION AUTHORIZATION audit_runtime; SET ROLE cic_runtime');
  await assert.rejects(record(hash,'summary',200),/Invalid API key/);
  await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE; ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check');
  await db.query("UPDATE api_keys SET scopes='{}' WHERE id=$1",[otherKey]);
  await db.exec('SET SESSION AUTHORIZATION audit_runtime; SET ROLE cic_runtime');
  await assert.rejects(record(otherHash,'summary',200),/Invalid API key/);
  await db.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  const rows=(await db.query('SELECT * FROM aggregate_access_events ORDER BY created_at,id')).rows;
  assert.equal(rows.length,3);
  assert.deepEqual(Object.keys(rows[0]).sort(),['created_at','id','key_id','org_id','route','status']);
  assert.ok(!JSON.stringify(rows).includes(hash)); assert.ok(!JSON.stringify(rows).includes('Primary'));
  await assert.rejects(db.query('DELETE FROM api_keys WHERE id=$1',[key]),/foreign key/);
  const attrs=(await db.query<{attnotnull:boolean}>(`SELECT attnotnull FROM pg_attribute
    WHERE attrelid='aggregate_access_events'::regclass AND attnum>0 AND NOT attisdropped`)).rows;
  assert.ok(attrs.every(a=>a.attnotnull));
  await db.exec('SET ROLE cic_reporting');
  for(const sql of ['SELECT * FROM aggregate_access_events','UPDATE aggregate_access_events SET status=429','DELETE FROM aggregate_access_events'])
    await assert.rejects(db.query(sql),/permission denied/);
  await assert.rejects(db.query(`INSERT INTO aggregate_access_events(org_id,key_id,route,status)
    VALUES('${foreign}','${key}','summary',200)`),/foreign key/);
  await db.exec('RESET ROLE; CREATE ROLE audit_outsider NOLOGIN; SET SESSION AUTHORIZATION audit_outsider');
  await assert.rejects(record(hash,'summary',200),/permission denied/);
});
