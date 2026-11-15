import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveImports, XLSX_MIME, importTotals } from '../apps/web/src/app/core/import-live.ts';
import type { Request } from '../apps/web/src/app/core/outreach-live.ts';

test('live import uploads original bytes with required source and MIME headers', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const request: Request = async <T>(path: string, init: RequestInit = {}) => {
    calls.push({ path, init }); return { batch_id: 'batch', status: 'reviewing' } as T;
  };
  const client = new LiveImports(request);
  for (const [name, mime] of [['sample.csv', 'text/csv; charset=utf-8'], ['sample.xlsx', XLSX_MIME]]) {
    const file = new File(['original bytes'], name);
    await client.upload(file, 'zeffy');
    const call = calls.at(-1)!;
    assert.equal(call.path, '/api/v1/imports');
    assert.equal(call.init.body, file);
    assert.equal(new Headers(call.init.headers).get('Content-Type'), mime);
    assert.equal(new Headers(call.init.headers).get('X-Import-Source'), 'zeffy');
    assert.equal(new Headers(call.init.headers).get('X-Import-Filename'), name);
  }
  for (const file of [new File([], 'empty.csv'), new File(['x'], 'macro.xlsm'), new File(['x'], '../path.csv'),
    new File([new Uint8Array(4194305)], 'large.xlsx')]) assert.throws(() => client.upload(file, 'zeffy'));
  assert.equal(calls.length, 2);
});

test('live import follows actual row offsets and refuses stalled pagination', async () => {
  const calls: string[] = [];
  const client = new LiveImports((async (path: string) => {
    calls.push(path);
    return path.endsWith('offset=0') ? { items: ['a'], total: 3, next_offset: 1 }
      : { items: ['b', 'c'], total: 3, next_offset: 3 };
  }) as Request);
  assert.deepEqual(await client.rows('batch/id', 'donor', true), ['a', 'b', 'c']);
  assert.deepEqual(calls, ['/api/v1/imports/batch%2Fid/plan/rows?kind=donor&limit=200&offset=0',
    '/api/v1/imports/batch%2Fid/plan/rows?kind=donor&limit=200&offset=1']);
  const stalled = new LiveImports((async () => ({ items: [], total: 5, next_offset: 0 })) as Request);
  await assert.rejects(stalled.rows('batch', 'preview'), /incomplete/);
});

test('live review and commit send only human decisions and current plan hashes', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = new LiveImports((async (path: string, init: RequestInit) => {
    calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return { status: 'ready' };
  }) as Request);
  const plan = { plan_hash: 'gift-hash', donor_plan_hash: 'donor-hash', counts: {}, excluded: 0, unresolved: [] };
  await client.review('batch', 'gift', plan, [{ kind: 'gift', row: 1, action: 'skip' }]);
  await client.commit('batch', plan);
  await client.abandon('batch');
  assert.deepEqual(calls, [
    { path: '/api/v1/imports/batch/gifts/review', body: { plan_hash: 'gift-hash', donor_plan_hash: 'donor-hash',
      decisions: [{ kind: 'gift', row: 1, action: 'skip' }] } },
    { path: '/api/v1/imports/batch/commit', body: { donor_plan_hash: 'donor-hash', plan_hash: 'gift-hash' } },
    { path: '/api/v1/imports/batch/abandon', body: undefined },
  ]);
});

test('import reconciliation separates source totals and canonical deltas by currency', () => {
  const gift = { amount_cents: 1000, refund_cents: 200, currency: 'USD', status: 'settled' };
  const row = { row: 0, action: 'insert', reason: '', existingIds: [], matchingRows: [], draft: gift, candidates: [] };
  const totals = importTotals([row, { ...row, row: 1, action: 'skip' }, { ...row, row: 2,
    action: 'review', candidates: [{ ...gift, id: 'prior', amount_cents: 500, refund_cents: 0, currency: 'EUR' }] },
    { ...row, row: 3, draft: {} }], { 2: 'correct:prior' });
  assert.deepEqual(totals, { currencies: [
    { currency: 'USD', source_cents: '2400', delta_cents: '1600' },
    { currency: 'EUR', source_cents: '0', delta_cents: '-500' },
  ], unavailable: 1 });
});
