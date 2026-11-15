import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { registerImportSuggestions } from './import-suggestions.ts';
import { importFixture, iid } from './import-fixture.ts';
import type { ImportAccess } from './import-plans.ts';
import type { Client, Member } from './db.ts';

test('live suggestions require admin MFA, a scoped staged batch and an unresolved header', async t => {
  const { call } = await importFixture(t);
  const batch = await (await call('POST', '', 'email,Mystery\navery@example.org,private-cell')).json() as { batch_id: string };
  const path = `/${batch.batch_id}/suggestion`;
  for (const [who, status] of [[null, 401], ['board', 403], ['admin-no-mfa', 403], ['foreign', 403]] as const)
    assert.equal((await call('POST', path, { header: 'Mystery' }, who)).status, status);
  assert.equal((await call('POST', `/${iid(90)}/suggestion`, { header: 'Mystery' })).status, 404);
  for (const body of [{ header: 'email' }, { header: 'missing' }, { header: 'Mystery', samples: ['private-cell'] }])
    assert.equal((await call('POST', path, body)).status, 400);
  await call('POST', `/${batch.batch_id}/layout`, { mapping: { Mystery: null } });
  assert.equal((await call('POST', path, { header: 'Mystery' })).status, 400);
  await call('POST', `/${batch.batch_id}/abandon`);
  assert.equal((await call('POST', path, { header: 'Mystery' })).status, 409);
});

test('advice receives only one header after access ends, never writes, and fails closed to manual review', async t => {
  let inTransaction = false, failProvider = false;
  const queries: string[] = [];
  const batch = { id: iid(91), org_id: iid(1), source: 'zeffy', filename: 'test.csv', status: 'reviewing',
    layout: {}, raw_csv: Buffer.from('email,Mystery\navery@example.org,private-cell') };
  const client = { query: async (q: string) => { queries.push(q); return { rows: q.startsWith('SELECT *') ? [batch] : [] }; } } as unknown as Client;
  const access: ImportAccess = async (_header, action) => {
    inTransaction = true;
    try { return await action(client, { id: iid(10) } as Member); } finally { inTransaction = false; }
  };
  const app = express(); app.use(express.json());
  registerImportSuggestions(app, access, iid(1), async column => {
    assert.equal(inTransaction, false);
    assert.deepEqual(column, { header: 'Mystery', samples: [] });
    if (failProvider) throw Error('private provider failure');
    return { approval_required: true, target: 'company', confidence: 0.2 };
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = () => fetch(`http://127.0.0.1:${address.port}/${batch.id}/suggestion`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ header: 'Mystery' }),
  });
  assert.deepEqual(await (await call()).json(), { suggestion: { approval_required: true, target: 'company', confidence: 0.2 } });
  failProvider = true;
  assert.deepEqual(await (await call()).json(), { suggestion: null, unavailable: true });
  assert.deepEqual(batch.layout, {});
  assert.ok(queries.every(q => q.startsWith('SELECT')));
});
