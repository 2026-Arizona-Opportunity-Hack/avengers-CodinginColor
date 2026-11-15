import assert from 'node:assert/strict';
import test from 'node:test';
import { importFixture, iid } from './import-fixture.ts';

test('reviewed aliases bind campaign and new-donor owner while linked donors retain ownership', async t => {
  const { call, sql } = await importFixture(t);
  await sql.exec(`SET SESSION AUTHORIZATION postgres; RESET ROLE;
    INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES('${iid(14)}','${iid(1)}','other-board','board');
    INSERT INTO programs(id,org_id,title) VALUES('${iid(20)}','${iid(1)}','Program');
    INSERT INTO campaigns(id,org_id,program_id,title) VALUES('${iid(21)}','${iid(1)}','${iid(20)}','Campaign');
    SET SESSION AUTHORIZATION import_login;`);
  const file = 'first name,email,donation amount,campaign,contact person,external id\nAvery,a@example.org,12.34,Spring,Pat,alias-1';
  const layout = { mapping: {}, batch_values: { currency: 'USD', occurred_at: '2026-01-01T12:00:00Z', status: 'settled', refund_cents: 0 },
    aliases: { campaign: { Spring: iid(21) }, contact_person: { Pat: iid(14) } } };
  const stage = async (text: string) => (await (await call('POST', '', text)).json() as { batch_id: string }).batch_id;
  const first = await stage(file);
  const unresolved = await (await call('GET', `/${first}/rows?kind=preview`)).json() as { items: { issues: { code: string }[] }[] };
  assert.ok(unresolved.items[0].issues.some(i => i.code === 'unresolved_campaign_alias'));
  assert.equal((await call('GET', `/${first}/aliases`, undefined, 'board')).status, 403);
  for (const aliases of [{ ...layout.aliases, campaign: { Spring: iid(99) } }, { ...layout.aliases, contact_person: { Pat: iid(12) } }])
    assert.equal((await call('POST', `/${first}/layout`, { ...layout, aliases })).status, 400);
  const commit = async (id: string, owner: string) => {
    assert.equal((await call('POST', `/${id}/layout`, { ...layout, aliases: { ...layout.aliases, contact_person: { Pat: owner } } })).status, 200);
    const donor = await (await call('POST', `/${id}/donors/plan`)).json() as { plan_hash: string };
    const reviewed = await (await call('POST', `/${id}/donors/review`, { plan_hash: donor.plan_hash,
      decisions: [] })).json() as { status: string };
    assert.equal(reviewed.status, 'ready');
    const gift = await (await call('POST', `/${id}/gifts/plan`)).json() as { plan_hash: string };
    const hashes = { donor_plan_hash: donor.plan_hash, plan_hash: gift.plan_hash };
    assert.equal((await call('POST', `/${id}/gifts/review`, { ...hashes, decisions: [] })).status, 200);
    assert.equal((await call('POST', `/${id}/commit`, hashes)).status, 200);
  };
  await commit(first, iid(14));
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  const donor = (await sql.query<{ id: string; owner_id: string }>('SELECT id,owner_id FROM donors')).rows[0];
  assert.equal(donor.owner_id, iid(14));
  assert.equal((await sql.query<{ campaign_id: string }>('SELECT campaign_id FROM gifts')).rows[0].campaign_id, iid(21));
  await sql.exec('SET SESSION AUTHORIZATION import_login');
  await commit(await stage(file.replace('alias-1', 'alias-2')), iid(11));
  await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
  assert.equal((await sql.query<{ owner_id: string }>('SELECT owner_id FROM donors')).rows[0].owner_id, iid(14));
  assert.equal((await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM gifts')).rows[0].n, 2);
  await sql.exec('SET SESSION AUTHORIZATION import_login');
  const stale = await stage(file.replace('alias-1', 'alias-stale'));
  assert.equal((await call('POST', `/${stale}/layout`, layout)).status, 200);
  await sql.exec(`SET SESSION AUTHORIZATION postgres; RESET ROLE; UPDATE memberships SET active=false WHERE id='${iid(14)}'; SET SESSION AUTHORIZATION import_login;`);
  assert.equal((await call('POST', `/${stale}/donors/plan`)).status, 400);
});
