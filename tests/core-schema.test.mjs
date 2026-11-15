import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const org = id(1), otherOrg = id(2), alice = id(3), bob = id(4), admin = id(5);
const donorA = id(6), donorB = id(7), giftA = id(8), giftB = id(9);
const sql = readFileSync(new URL('../db/migrations/001_core.sql', import.meta.url), 'utf8');

test('migration rejects unsafe existing runtime roles instead of retaining privileges', async t => {
  const restricted = 'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION';
  for (const attribute of ['BYPASSRLS', 'SUPERUSER', 'LOGIN', 'CREATEDB', 'CREATEROLE', 'INHERIT', 'REPLICATION', 'membership']) {
    await t.test(attribute, async st => {
      const db = new PGlite();
      st.after(() => db.close());
      await db.exec(`CREATE ROLE cic_runtime ${restricted};`);
      if (attribute === 'membership') {
        await db.exec('CREATE ROLE elevated_role NOLOGIN BYPASSRLS; GRANT elevated_role TO cic_runtime;');
      } else await db.exec(`ALTER ROLE cic_runtime ${attribute};`);
      await assert.rejects(db.exec(sql), /unsafe existing cic_runtime role/i);
    });
  }
  await t.test('safe pre-existing restricted role remains usable', async st => {
    const db = new PGlite();
    st.after(() => db.close());
    await db.exec(`CREATE ROLE cic_runtime ${restricted};`);
    await db.exec(sql);
    const result = await db.query("SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'cic_runtime'");
    assert.deepEqual(result.rows, [{ rolcanlogin: false, rolbypassrls: false, rolsuper: false }]);
  });
});

test('core migration enforces PostgreSQL financial and authorization boundaries', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(sql);
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $3), ($2, $3)', [org, otherOrg, 'Synthetic CIC']);
  for (const [member, subject, role] of [[alice, 'alice', 'board'], [bob, 'bob', 'board'], [admin, 'admin', 'admin']]) {
    await db.query('INSERT INTO memberships (id, org_id, clerk_subject, role) VALUES ($1, $2, $3, $4)', [member, org, subject, role]);
  }
  for (const [donor, owner, name] of [[donorA, alice, 'Alex'], [donorB, bob, 'Sam'], [id(10), null, 'Unassigned']]) {
    await db.query('INSERT INTO donors (id, org_id, owner_id, name) VALUES ($1, $2, $3, $4)', [donor, org, owner, name]);
  }
  const insertGift = `INSERT INTO gifts (id, org_id, donor_id, amount_cents, refund_cents, currency, occurred_at, status, source, external_id)
    VALUES ($1, $2, $3, $4, $5, 'USD', '2026-11-14T00:00:00Z', 'settled', 'fixture', $6)`;
  for (const [gift, donor] of [[giftA, donorA], [giftB, donorB]]) {
    await db.query(insertGift, [gift, org, donor, 1234, 0, gift]);
  }
  async function asUser(subject, run, orgId = org) {
    await db.exec('BEGIN; SET LOCAL ROLE cic_runtime;');
    try {
      if (subject) {
        await db.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [orgId, subject]);
      }
      return await run();
    } finally { await db.exec('ROLLBACK'); }
  }
  const rows = async table => (await db.query(`SELECT id FROM ${table} ORDER BY id`)).rows.map(row => row.id);

  await t.test('board sees and edits only own records, admin sees both owners and unassigned', async () => {
    await asUser('alice', async () => {
      assert.deepEqual(await rows('donors'), [donorA]);
      assert.deepEqual(await rows('gifts'), [giftA]);
      assert.equal((await db.query("UPDATE donors SET name = 'Changed' WHERE id = $1 RETURNING id", [donorA])).rows.length, 1);
      assert.equal((await db.query("UPDATE donors SET name = 'Stolen' WHERE id = $1 RETURNING id", [donorB])).rows.length, 0);
      assert.equal((await db.query('UPDATE gifts SET refund_cents = 5 WHERE id = $1 RETURNING id', [giftB])).rows.length, 0);
    });
    await asUser('admin', async () => {
      assert.equal((await rows('donors')).length, 3);
      assert.equal((await rows('gifts')).length, 2);
      assert.equal((await db.query("UPDATE donors SET name = 'Reviewed' WHERE id = $1 RETURNING id", [donorB])).rows.length, 1);
    });
  });

  await t.test('runtime cannot reassign donors, move gifts, mutate audit or destroy records', async () => {
    for (const statement of [
      `UPDATE donors SET owner_id = '${alice}' WHERE id = '${donorA}'`,
      `UPDATE donors SET owner_id = NULL WHERE id = '${donorA}'`,
      `UPDATE donors SET org_id = '${otherOrg}' WHERE id = '${donorA}'`,
      `UPDATE gifts SET donor_id = '${donorA}' WHERE id = '${giftA}'`,
      `UPDATE gifts SET org_id = '${otherOrg}' WHERE id = '${giftA}'`,
      'DELETE FROM donors', 'DELETE FROM gifts', 'TRUNCATE gifts',
      "UPDATE audit_events SET action = 'hidden'", 'DELETE FROM audit_events',
      "UPDATE memberships SET role = 'admin'",
    ]) await assert.rejects(asUser('alice', () => db.exec(statement)), /permission denied/i);
  });

  await t.test('missing, wrong-organization and inactive contexts deny reads and writes', async () => {
    for (const [subject, organization] of [[null, org], ['alice', otherOrg], ['unknown', org]]) {
      await asUser(subject, async () => {
        assert.deepEqual(await rows('donors'), []);
        assert.deepEqual(await rows('gifts'), []);
      }, organization);
      await assert.rejects(asUser(subject, () => db.query('INSERT INTO donors (org_id, owner_id, name) VALUES ($1, $2, $3)', [org, alice, 'Denied']), organization), /row-level security/i);
    }
    await db.query('UPDATE memberships SET active = false WHERE id = $1', [alice]);
    await asUser('alice', async () => {
      assert.deepEqual(await rows('donors'), []);
      assert.deepEqual(await rows('gifts'), []);
    });
    await assert.rejects(asUser('alice', () => db.query(insertGift, [id(21), org, donorA, 10, 0, 'inactive'])), /row-level security/i);
    await db.query('UPDATE memberships SET active = true WHERE id = $1', [alice]);
    await db.query('UPDATE memberships SET active = false WHERE id = $1', [admin]);
    await asUser('admin', async () => {
      assert.deepEqual(await rows('donors'), []);
      assert.equal((await db.query("UPDATE donors SET name = 'Denied' RETURNING id")).rows.length, 0);
    });
    await db.query('UPDATE memberships SET active = true WHERE id = $1', [admin]);
  });

  await t.test('cross-org foreign keys, money bounds and duplicate financial identities reject writes', async () => {
    await db.query('INSERT INTO campaigns (id, org_id, title) VALUES ($1, $2, $3)', [id(20), otherOrg, 'Other organization']);
    await assert.rejects(db.query('INSERT INTO donors (org_id, owner_id, name) VALUES ($1, $2, $3)', [otherOrg, alice, 'Invalid owner link']), /foreign key/i);
    await assert.rejects(asUser('admin', () => db.query('UPDATE gifts SET campaign_id = $1 WHERE id = $2', [id(20), giftA])), /foreign key/i);
    await assert.rejects(asUser('admin', () => db.query('INSERT INTO donors (org_id, owner_id, name) VALUES ($1, $2, $3)', [otherOrg, alice, 'Invalid'])), /row-level security|foreign key/i);
    for (const [amount, refund] of [[-1, 0], [100, 101], ['9007199254740992', 0]]) {
      await assert.rejects(asUser('alice', () => db.query(insertGift, [id(21), org, donorA, amount, refund, 'invalid'])), /check constraint/i);
    }
    await assert.rejects(asUser('alice', () => db.query(insertGift, [id(21), org, donorA, 1234, 0, giftA])), /unique constraint/i);
    await asUser('alice', async () => {
      await db.query(insertGift, [id(22), org, donorA, 1234, 1234, null]);
      await db.query(insertGift, [id(23), org, donorA, 1234, 0, null]);
      assert.equal((await rows('gifts')).length, 3);
    });
  });

  await t.test('audit is append-only with authenticated actor and failed transaction rolls back gift', async () => {
    await asUser('alice', async () => {
      await db.query("INSERT INTO audit_events (org_id, actor_id, action, target_id, status) VALUES ($1, $2, 'gift.create', $3, 'success')", [org, alice, giftA]);
      assert.equal((await rows('audit_events')).length, 1);
    });
    await assert.rejects(asUser('alice', async () => {
      await db.query(insertGift, [id(24), org, donorA, 100, 0, 'rollback']);
      await db.query("INSERT INTO audit_events (org_id, actor_id, action, target_id, status) VALUES ($1, $2, 'gift.create', $3, 'success')", [org, bob, id(24)]);
    }), /row-level security/i);
    assert.equal((await db.query('SELECT id FROM gifts WHERE id = $1', [id(24)])).rows.length, 0);
    assert.equal((await db.query('SELECT name FROM donors WHERE id = $1', [donorA])).rows[0].name, 'Alex');
  });
});
