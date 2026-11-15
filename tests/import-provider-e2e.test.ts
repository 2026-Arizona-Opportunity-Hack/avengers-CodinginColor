import assert from 'node:assert/strict';
import test from 'node:test';
import { importFixture } from '../apps/api/import-fixture.ts';

const labels = ['spreadsheet', 'zeffy', 'benevity', 'az_gives', 'united_way'];
const layout = { mapping: {}, batch_values: { currency: 'USD', status: 'settled', refund_cents: 0,
  occurred_at: '2026-11-15T12:34:56.123456Z' } };

test('synthetic source labels complete the real CSV API transaction and exact upload replay', async t => {
  const { call, sql } = await importFixture(t);
  for (const [index, source] of labels.entries()) {
    // Generic labels only: these rows do not assert any provider's export schema.
    const csv = `first name,last name,email,donation amount,external id\nDonor,${index},donor${index}@example.org,12.34,tx-${index}`;
    const headers = { 'X-Import-Source': source };
    const upload = await call('POST', '', csv, 'admin', headers);
    assert.equal(upload.status, 201, source);
    const { batch_id } = await upload.json() as { batch_id: string };
    assert.equal((await call('POST', `/${batch_id}/layout`, layout)).status, 200);
    const { plan_hash: donor_plan_hash } = await (await call('POST', `/${batch_id}/donors/plan`)).json() as { plan_hash: string };
    assert.equal((await call('POST', `/${batch_id}/donors/review`, { plan_hash: donor_plan_hash, decisions: [] })).status, 200);
    const { plan_hash } = await (await call('POST', `/${batch_id}/gifts/plan`)).json() as { plan_hash: string };
    assert.equal((await call('POST', `/${batch_id}/gifts/review`, { donor_plan_hash, plan_hash, decisions: [] })).status, 200);
    const commit = await call('POST', `/${batch_id}/commit`, { donor_plan_hash, plan_hash });
    assert.equal(commit.status, 200, source);
    assert.equal((await commit.json() as { counts: { gifts_inserted: number } }).counts.gifts_inserted, 1);
    const replay = await call('POST', '', csv, 'admin', headers);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
  }
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.equal((await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM gifts')).rows[0].n, labels.length);
});
