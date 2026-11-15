import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../db/migrate.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = id(1), ADMIN = id(10), BOARD_A = id(11), BOARD_B = id(12), DONOR_A = id(40), DONOR_B = id(41);
const HASH = 'a'.repeat(64), HASH2 = 'b'.repeat(64);
const migrations = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const runner = (db: PGlite) => ({ query: async (s: string, v?: unknown[]) =>
  v ? db.query<Record<string, unknown>>(s, v) : (await db.exec(s)).at(-1)! });

async function setup(t: test.TestContext) {
  const db = new PGlite();
  t.after(() => db.close());
  await migrate(runner(db), migrations);
  await db.exec(`
    INSERT INTO organizations (id, name) VALUES ('${ORG}', 'CIC');
    INSERT INTO memberships (id, org_id, clerk_subject, role) VALUES ('${ADMIN}', '${ORG}', 'admin', 'admin'),
      ('${BOARD_A}', '${ORG}', 'board-a', 'board'), ('${BOARD_B}', '${ORG}', 'board-b', 'board');
    INSERT INTO donors (id, org_id, owner_id, name, email) VALUES
      ('${DONOR_A}', '${ORG}', '${BOARD_A}', 'Avery', 'avery@example.org'),
      ('${DONOR_B}', '${ORG}', '${BOARD_B}', 'Jordan', 'jordan@example.org');
    CREATE ROLE cic_app_test NOLOGIN NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO cic_app_test;`);
  /** The API's path: restricted login, SET LOCAL ROLE cic_runtime, verified member context. */
  const as = async (subject: string, sql: string, values: unknown[] = []) => {
    await db.exec('SET SESSION AUTHORIZATION cic_app_test; BEGIN; SET LOCAL ROLE cic_runtime;');
    try {
      await db.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [ORG, subject]);
      const rows = (await db.query<Record<string, unknown>>(sql, values)).rows;
      await db.exec('COMMIT;');
      return rows;
    } catch (error) { await db.exec('ROLLBACK;'); throw error; } finally {
      await db.exec('SET SESSION AUTHORIZATION postgres;'); // PGlite ignores RESET SESSION AUTHORIZATION
    }
  };
  return { db, as };
}

const nextAction = (donor: string, owner: string) => `INSERT INTO follow_ups (org_id, donor_id, owner_id, kind, title, due_at)
  VALUES ('${ORG}', '${donor}', '${owner}', 'next_action', 'Invite to Day of Compute', '2026-11-20T09:00:00-07:00') RETURNING id`;
const quarterly = (donor: string, owner: string) => `INSERT INTO follow_ups (org_id, donor_id, owner_id, kind, quarter, title, due_at)
  VALUES ('${ORG}', '${donor}', '${owner}', 'quarterly', '2026-Q4', 'Quarterly update', '2027-01-01T00:00:00-07:00')
  ON CONFLICT (org_id, donor_id, quarter) WHERE kind = 'quarterly' DO NOTHING RETURNING id`;

test('follow-ups: board members work only their own donors; quarterly touches are unique per quarter', async (t) => {
  const { as } = await setup(t);
  assert.equal((await as('board-a', nextAction(DONOR_A, BOARD_A))).length, 1);
  await assert.rejects(as('board-a', nextAction(DONOR_B, BOARD_A)), /row-level security/);
  assert.equal((await as('admin', quarterly(DONOR_A, BOARD_A))).length, 1);
  assert.equal((await as('admin', quarterly(DONOR_A, BOARD_A))).length, 0);   // idempotent
  assert.equal((await as('admin', quarterly(DONOR_B, BOARD_B))).length, 1);
  assert.equal((await as('board-a', 'SELECT id FROM follow_ups')).length, 2);
  assert.equal((await as('board-b', 'SELECT id FROM follow_ups')).length, 1);
  assert.equal((await as('admin', 'SELECT id FROM follow_ups')).length, 3);
  await assert.rejects(as('admin', `INSERT INTO follow_ups (org_id, donor_id, owner_id, kind, quarter, title, due_at)
    VALUES ('${ORG}', '${DONOR_A}', '${BOARD_A}', 'quarterly', NULL, 'x', now())`), /check constraint/);
});

test('follow-ups: completion is recorded by the actor; owner changes and deletes are not runtime powers', async (t) => {
  const { as } = await setup(t);
  await as('board-a', nextAction(DONOR_A, BOARD_A));
  const done = await as('board-a', `UPDATE follow_ups SET status = 'done', completed_at = now(), completed_by = $1
    WHERE donor_id = $2 RETURNING status`, [BOARD_A, DONOR_A]);
  assert.deepEqual(done, [{ status: 'done' }]);
  await assert.rejects(as('board-a', `UPDATE follow_ups SET completed_by = $1`, [BOARD_B]), /row-level security/);
  await assert.rejects(as('admin', `UPDATE follow_ups SET owner_id = $1`, [BOARD_B]), /permission denied/);
  await assert.rejects(as('admin', 'DELETE FROM follow_ups'), /permission denied/);
  assert.equal((await as('board-b', `UPDATE follow_ups SET status = 'cancelled' RETURNING id`)).length, 0);
});

test('drafts: approval needs a hash, any content edit drops it, sent drafts are frozen', async (t) => {
  const { as } = await setup(t);
  const [draft] = await as('board-a', `INSERT INTO drafts (org_id, donor_id, author_id, channel, recipient, subject, body)
    VALUES ('${ORG}', '${DONOR_A}', '${BOARD_A}', 'email', 'avery@example.org', 'Thank you', 'Hi Avery') RETURNING id`);
  await assert.rejects(as('board-a', `UPDATE drafts SET status = 'approved' WHERE id = $1`, [draft.id]), /check constraint/);
  await as('board-a', `UPDATE drafts SET status = 'approved', approval_hash = $2, approved_by = $3, approved_at = now()
    WHERE id = $1`, [draft.id, HASH, BOARD_A]);
  const [edited] = await as('board-a', `UPDATE drafts SET body = 'Hi Avery!' WHERE id = $1
    RETURNING status, approval_hash, approved_by`, [draft.id]);
  assert.deepEqual(edited, { status: 'draft', approval_hash: null, approved_by: null });
  await as('board-a', `UPDATE drafts SET status = 'approved', approval_hash = $2, approved_by = $3, approved_at = now()
    WHERE id = $1`, [draft.id, HASH, BOARD_A]);
  await as('board-a', `UPDATE drafts SET status = 'logged' WHERE id = $1`, [draft.id]);
  await assert.rejects(as('board-a', `UPDATE drafts SET body = 'changed after send' WHERE id = $1`, [draft.id]), /already sent/);
  await assert.rejects(as('admin', `UPDATE drafts SET status = 'draft', approval_hash = NULL WHERE id = $1`, [draft.id]), /already sent/);
  assert.deepEqual(await as('board-b', 'SELECT id FROM drafts'), []);
  await assert.rejects(as('board-a', `UPDATE drafts SET recipient = 'x@evil.test' WHERE id = $1`, [draft.id]), /permission denied/);
});

test('communications: append-only, scoped to visible donors, and one record per approved message', async (t) => {
  const { as } = await setup(t);
  const log = (donor: string, actor: string, hash: string | null, status = 'logged_manual') =>
    `INSERT INTO communications (org_id, donor_id, channel, actor_id, occurred_at, status, approval_hash, qualifying)
     VALUES ('${ORG}', '${donor}', 'email', '${actor}', now(), '${status}', ${hash ? `'${hash}'` : 'NULL'},
       ${status !== 'failed'}) RETURNING id`;
  assert.equal((await as('board-a', log(DONOR_A, BOARD_A, HASH))).length, 1);
  await assert.rejects(as('board-a', log(DONOR_A, BOARD_A, HASH)), /duplicate key/);   // double send
  assert.equal((await as('board-a', log(DONOR_A, BOARD_A, HASH2, 'failed'))).length, 1);
  assert.equal((await as('board-a', log(DONOR_A, BOARD_A, HASH2))).length, 1);         // a retry after failure
  await assert.rejects(as('board-a', log(DONOR_B, BOARD_A, null, 'logged_contact')), /row-level security/);
  await assert.rejects(as('board-a', log(DONOR_A, BOARD_B, null, 'logged_contact')), /row-level security/);
  await assert.rejects(as('board-a', `UPDATE communications SET qualifying = false`), /permission denied/);
  // A failed delivery can never count as a qualifying contact.
  await assert.rejects(as('board-a', `INSERT INTO communications (org_id, donor_id, channel, actor_id, occurred_at, status, qualifying)
    VALUES ('${ORG}', '${DONOR_A}', 'email', '${BOARD_A}', now(), 'failed', true)`), /check constraint/);
  await assert.rejects(as('admin', 'DELETE FROM communications'), /permission denied/);
  assert.equal((await as('board-b', 'SELECT id FROM communications')).length, 0);
  assert.equal((await as('admin', 'SELECT id FROM communications')).length, 3);
});

test('a communication can only reference a draft written for the same donor', async (t) => {
  // Review on #55: an org-only FK let another donor's draft be attached to this donor's history.
  const { as } = await setup(t);
  const [draftB] = await as('admin', `INSERT INTO drafts (org_id, donor_id, author_id, channel, recipient, subject, body)
    VALUES ('${ORG}', '${DONOR_B}', '${ADMIN}', 'email', 'jordan@example.org', 'Hi', 'Hi Jordan') RETURNING id`);
  const [draftA] = await as('admin', `INSERT INTO drafts (org_id, donor_id, author_id, channel, recipient, subject, body)
    VALUES ('${ORG}', '${DONOR_A}', '${ADMIN}', 'email', 'avery@example.org', 'Hi', 'Hi Avery') RETURNING id`);
  const link = (donor: string, draft: unknown) => `INSERT INTO communications
    (org_id, donor_id, draft_id, channel, actor_id, occurred_at, status, qualifying)
    VALUES ('${ORG}', '${donor}', '${draft}', 'email', '${ADMIN}', now(), 'logged_contact', true) RETURNING id`;
  await assert.rejects(as('admin', link(DONOR_A, draftB.id)), /foreign key/);
  assert.equal((await as('admin', link(DONOR_A, draftA.id))).length, 1);
});

test('a non-superuser CREATEROLE migration owner can apply 001-005', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE ROLE migration_owner NOLOGIN CREATEROLE BYPASSRLS;
    ALTER DATABASE postgres OWNER TO migration_owner; GRANT CREATE ON SCHEMA public TO migration_owner;
    SET SESSION AUTHORIZATION migration_owner;`);
  assert.ok((await migrate(runner(db), migrations)).includes('005_outreach.sql'));
});
