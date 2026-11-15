import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';

const digest = value => createHash('sha256').update(value).digest('hex');
const historical = () => readFile('tests/fixtures/staff-invitations-historical.sql','utf8');
const asModule = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('guarded history adoption and ACL hardening on disposable PostgreSQL 17', {skip:!process.env.CIC_PG17_REHEARSAL_URL}, async () => {
  const db = new pg.Client({connectionString:process.env.CIC_PG17_REHEARSAL_URL});
  const dir = await mkdtemp(join(tmpdir(),'cic-repair-test-'));
  const paths = ['owner.json','secdef.json','backup.json','unused.json'].map(n => join(dir,n));
  await db.connect();
  let reference;
  try {
    assert.equal(Math.floor(Number((await db.query('SHOW server_version_num')).rows[0].server_version_num)/10000),17);
    const names=(await readdir('db/migrations')).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort();
    assert.equal(names.length,18);
    const files=Object.fromEntries(await Promise.all(names.map(async n=>[n,await readFile(`db/migrations/${n}`,'utf8')])));
    const old=await historical();
    await db.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    for(const name of names.slice(0,17)) {
      const source=name==='013_staff_invitations.sql'?old:files[name];
      await db.query(source);
      await db.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,digest(source.replaceAll('\r\n','\n'))]);
    }
    await db.query('CREATE DATABASE cic_canonical_reference');
    const referenceUrl=new URL(process.env.CIC_PG17_REHEARSAL_URL); referenceUrl.pathname='/cic_canonical_reference';
    reference=new pg.Client({connectionString:referenceUrl.href}); await reference.connect();
    await reference.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    for(const name of names) await reference.query(files[name]);
    const raw=await readFile('tools/repair-invitation-history.mjs','utf8');
    const helper=await asModule(raw.replace('async function catalog(client)', 'export async function catalog(client)')
      .replace('async function secdefs(client)', 'export async function secdefs(client)'));
    const canonical=await helper.catalog(reference);
    await reference.end(); reference=undefined;
    await db.query(`CREATE ROLE rehearsal_cloud NOLOGIN; CREATE ROLE rehearsal_actor NOLOGIN;
      GRANT cic_assignment,cic_reporting,cic_impact TO rehearsal_cloud WITH ADMIN TRUE;
      SET ROLE rehearsal_cloud;
      GRANT cic_assignment,cic_reporting,cic_impact TO rehearsal_actor WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
      RESET ROLE;
      ALTER TABLE schema_migrations OWNER TO rehearsal_actor;`);
    let funcs=await helper.secdefs(db);
    for(const f of funcs.filter(f=>f.owner.startsWith('cic_'))) {
      await db.query(`REVOKE EXECUTE ON FUNCTION public.${f.signature} FROM cic_runtime`);
      await db.query(`GRANT EXECUTE ON FUNCTION public.${f.signature} TO PUBLIC`);
    }
    await db.query('SET SESSION AUTHORIZATION rehearsal_actor');
    const owner=await helper.catalog(db); funcs=await helper.secdefs(db);
    const ownerBytes=Buffer.from(JSON.stringify(owner,null,2)), funcBytes=Buffer.from(JSON.stringify(funcs,null,2));
    await writeFile(paths[0],ownerBytes); await writeFile(paths[1],funcBytes);
    const testSource=raw.replace('c36e6cba2eff557489df35c6a1ccc6d7a94d69324323395c386b87636d6a156f',digest(ownerBytes))
      .replace('101fc8556bfd099201ec8fa94bfb462f8c6db996149b90376c829e2994bfe7e3',digest(funcBytes));
    const {repairInvitationHistory}=await asModule(testSource);
    const args=[db,files,old,paths[0],paths[1],paths[2]];
    const badFiles={...files,'018_staff_invitation_provider_status.sql':files['018_staff_invitation_provider_status.sql']+'-- tampered'};
    await assert.rejects(repairInvitationHistory(db,badFiles,old,paths[0],paths[1],paths[2]),/Unexpected migration sources/);
    await db.query("UPDATE schema_migrations SET sha256='drift' WHERE name='001_core.sql'");
    await assert.rejects(repairInvitationHistory(...args),/Unexpected catalog/);
    await db.query('UPDATE schema_migrations SET sha256=$1 WHERE name=$2',[owner.ledger[0].sha256,owner.ledger[0].name]);
    await writeFile(paths[0],Buffer.from('tampered'));
    await assert.rejects(repairInvitationHistory(...args),/Unapproved catalog baseline/);
    await writeFile(paths[0],ownerBytes);
    await writeFile(paths[1],Buffer.from('tampered'));
    await assert.rejects(repairInvitationHistory(...args),/Unapproved catalog baseline/);
    await writeFile(paths[1],funcBytes);
    await db.query('GRANT cic_assignment TO rehearsal_actor WITH ADMIN FALSE, INHERIT FALSE, SET TRUE');
    await assert.rejects(repairInvitationHistory(...args),/Unexpected catalog/);
    await db.query('REVOKE cic_assignment FROM rehearsal_actor GRANTED BY rehearsal_actor');
    const drift=async (change,undo) => {
      await db.query('RESET SESSION AUTHORIZATION'); await db.query(change);
      await db.query('SET SESSION AUTHORIZATION rehearsal_actor');
      await assert.rejects(repairInvitationHistory(...args),/Unexpected catalog/);
      await db.query('RESET SESSION AUTHORIZATION'); await db.query(undo);
      await db.query('SET SESSION AUTHORIZATION rehearsal_actor');
      assert.deepEqual(await helper.catalog(db),owner); assert.deepEqual(await helper.secdefs(db),funcs);
    };
    await drift('ALTER FUNCTION public.pending_staff_invitation(text) SET search_path=public',
      'ALTER FUNCTION public.pending_staff_invitation(text) SET search_path=pg_catalog');
    await drift('GRANT CREATE ON SCHEMA public TO rehearsal_actor','REVOKE CREATE ON SCHEMA public FROM rehearsal_actor');
    await drift('REVOKE ADMIN OPTION FOR cic_assignment FROM rehearsal_actor GRANTED BY rehearsal_cloud',
      'GRANT cic_assignment TO rehearsal_actor WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY rehearsal_cloud');
    await writeFile(paths[2],'sentinel');
    await assert.rejects(repairInvitationHistory(...args),error=>error.code==='EEXIST');
    assert.equal(await readFile(paths[2],'utf8'),'sentinel');
    assert.deepEqual(await helper.catalog(db),owner); assert.deepEqual(await helper.secdefs(db),funcs);
    await rm(paths[2]);
    for(const mode of ['failure','notice']) {
      const query=db.query.bind(db); let injected=false;
      db.query=async (...params) => {
        const sql=params[0];
        if(!injected && mode==='failure' && typeof sql==='string' && sql.startsWith('UPDATE schema_migrations SET')) {
          injected=true; throw new Error('injected failure after ACL changes');
        }
        const result=await query(...params);
        if(!injected && mode==='notice' && typeof sql==='string' && sql.startsWith('GRANT EXECUTE ON FUNCTION')) {
          injected=true; db.emit('notice',{message:'injected notice'});
        }
        return result;
      };
      try { await assert.rejects(repairInvitationHistory(...args), mode==='failure'?/injected failure/:/Unexpected PostgreSQL notice/); }
      finally { db.query=query; }
      assert.equal(injected,true);
      assert.deepEqual(await helper.catalog(db),owner);
      assert.deepEqual(await helper.secdefs(db),funcs);
      assert.equal(JSON.parse(await readFile(paths[2],'utf8')).length,17);
      await rm(paths[2]);
    }
    assert.equal(await repairInvitationHistory(...args),'repaired');
    assert.equal((await db.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,18);
    assert.equal((await helper.secdefs(db)).filter(f=>f.public_execute).length,0);
    const repaired=await helper.catalog(db);
    const normalized = value => JSON.stringify(value, (key,v) => key==='proacl' && typeof v==='string'
      ? `{${v.slice(1,-1).split(',').sort().join(',')}}` : v).replaceAll('\\r\\n','\\n');
    for(const key of ['table','columns','constraints','indexes','policies','functions'])
      assert.equal(normalized(repaired[key]),normalized(canonical[key]),`canonical 013+018 ${key}`);

    assert.equal(await repairInvitationHistory(...args),'already_applied');
    assert.equal(JSON.parse(await readFile(paths[2],'utf8')).length,17);
    await db.query('RESET SESSION AUTHORIZATION');
    await db.query('DROP DATABASE cic_canonical_reference');
  } finally {
    if(reference) await reference.end();
    await db.end();
    for(const path of paths) await rm(path,{force:true});
    await rmdir(dir);
  }
});
