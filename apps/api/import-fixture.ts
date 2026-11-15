// Synthetic integration fixture shared by the import route tests; never loaded by the server.
import { PGlite } from '@electric-sql/pglite';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { migrate } from '../../db/migrate.ts';
import { createApp } from './app.ts';
import { EnvSchema, HttpError } from './env.ts';
import type { Database } from './db.ts';
export const iid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export async function importFixture(t: TestContext) {
  const sql=new PGlite(); t.after(()=>sql.close());
  await migrate({query:async(q,v)=>v?sql.query<Record<string,unknown>>(q,v):(await sql.exec(q)).at(-1)!},
    fileURLToPath(new URL('../../db/migrations/',import.meta.url)));
  await sql.exec(`INSERT INTO organizations(id,name) VALUES('${iid(1)}','CIC'),('${iid(2)}','Other');
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES('${iid(10)}','${iid(1)}','admin','admin'),
    ('${iid(11)}','${iid(1)}','board','board'),('${iid(12)}','${iid(2)}','foreign','admin');
    INSERT INTO import_batches(id,org_id,created_by,source,filename,file_sha256,raw_csv)
    VALUES('${iid(90)}','${iid(2)}','${iid(12)}','zeffy','foreign.csv','sha256:${'f'.repeat(64)}',decode('61','hex'));
    CREATE ROLE import_login NOLOGIN NOINHERIT; GRANT cic_runtime TO import_login;
    SET SESSION AUTHORIZATION import_login;`);
  const db:Database={connect:async()=>({query:(q,v)=>sql.query<Record<string,unknown>>(q,v),release:()=>{}})};
  const env=EnvSchema.parse({DATABASE_URL:'postgresql://localhost/test',CIC_ORG_ID:iid(1),CLERK_SECRET_KEY:'sk_test_fixture',
    CLERK_JWT_ISSUER:'https://example.clerk.accounts.dev',APP_ORIGIN:'http://localhost:4200'});
  const server=createApp(env,db,async h=>{
    const subject=h?.replace('Bearer ','');
    if (!['admin','board','foreign','admin-no-mfa'].includes(subject??'')) throw new HttpError(401);
    return {subject:subject==='admin-no-mfa'?'admin':subject!,mfa:subject!=='admin-no-mfa'&&subject!=='board'};
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r()));});
  const a=server.address(); if (!a||typeof a==='string') throw Error('No port');
  const call=(method:string,path:string,body?:unknown,who:string|null='admin',headers:Record<string,string>={})=>
    fetch(`http://127.0.0.1:${a.port}/api/v1/imports${path}`,{method,headers:{...(who?{Authorization:`Bearer ${who}`} :{}),
      ...(body===undefined?{}:typeof body==='string'?{'Content-Type':'text/csv; charset=utf-8','X-Import-Source':'zeffy','X-Import-Filename':'test.csv'}:{'Content-Type':'application/json'}),...headers},
      body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  return {sql,call};
}
