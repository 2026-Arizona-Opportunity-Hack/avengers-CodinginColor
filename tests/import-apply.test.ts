import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { applyReviewedGifts } from '../tools/import-apply.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const org = id(1), other = id(2), alice = id(3), bob = id(4), admin = id(5);
const donorA = id(6), donorB = id(7), unassigned = id(10), giftA = id(8), batch = id(11);
const when = '2026-11-14T09:00:00.123456-07:00';
const huge = 9007199254740991;

const draft = (overrides: Record<string, unknown> = {}) => ({
  donor_id: donorA, campaign_id: null, amount_cents: huge, refund_cents: 0, currency: 'USD',
  occurred_at: when, status: 'settled', source: "zeffy'; drop", external_id: 'tx-1',
  source_row: { batch_id: batch, row_key: '2' }, ...overrides,
});
const insert = (row: number, overrides: Record<string, unknown> = {}, reviewer: string | null = null) =>
  ({ kind: 'gift', row, op: 'insert', reviewer_id: reviewer, draft: draft(overrides) });

async function begin(db: PGlite, subject: string) {
  await db.exec('BEGIN; SET LOCAL ROLE cic_runtime;');
  await db.query(`SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`, [org, subject]);
}

const countGifts = async (db: PGlite) => Number((await db.query(`SELECT count(*)::int AS n FROM gifts`)).rows[0].n);

test('reviewed inserts preserve exact money and do not commit the caller transaction', async () => {
  const db = new PGlite();
  try {
    await databaseSetup(db);
    await begin(db, 'alice');
    const applied = await applyReviewedGifts(db, { org_id: org, operations: [insert(0)] });
    assert.match(applied.applied[0].id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(applied.applied.map(item => [item.row, item.op]), [[0, 'insert']]);
    await db.exec('ROLLBACK');
    assert.equal(await countGifts(db), 0);

    await begin(db, 'alice');
    const committed = await applyReviewedGifts(db, { org_id: org, operations: [insert(0)] });
    await db.exec('COMMIT');
    const stored = (await db.query(`SELECT id::text, amount_cents::text, refund_cents::text, source, external_id,
      source_row, occurred_at = $2::timestamptz AS same_instant
      FROM gifts WHERE id = $1`, [committed.applied[0].id, when])).rows[0];
    assert.equal(stored.amount_cents, String(huge));
    assert.equal(stored.refund_cents, '0');
    assert.equal(stored.source, "zeffy'; drop");
    assert.equal(stored.external_id, 'tx-1');
    assert.equal(stored.same_instant, true);
    assert.deepEqual(stored.source_row, { batch_id: batch, row_key: '2' });
    assert.deepEqual((await db.query(`SELECT actor_id::text, action, target_id::text, status FROM audit_events`)).rows,
      [{ actor_id: alice, action: 'gift.insert', target_id: committed.applied[0].id, status: 'success' }]);
  } finally { await db.close(); }
});

test('a failed apply leaves earlier writes and a usable transaction', async () => {
  const db = new PGlite();
  try {
    await databaseSetup(db);
    await begin(db, 'admin');
    await applyReviewedGifts(db, { org_id: org, operations: [insert(0, { external_id: 'kept', source_row: { batch_id: batch, row_key: 'kept' } })] });
    await assert.rejects(() => applyReviewedGifts(db, { org_id: org, operations: [
      insert(1, { external_id: 'new', source_row: { batch_id: batch, row_key: 'new' } }),
      insert(2, { external_id: 'kept', source_row: { batch_id: batch, row_key: 'other' } }),
    ] }), /identity|duplicate|conflict/i);
    await assert.rejects(() => applyReviewedGifts(db, { org_id: org, operations: [
      insert(3, { external_id: null, source_row: { batch_id: batch, row_key: 'same' } }),
      insert(4, { external_id: null, amount_cents: 2000, source_row: { batch_id: batch, row_key: 'same' } }),
    ] }), /provenance|source row|conflict/i);
    assert.deepEqual((await db.query(`SELECT external_id FROM gifts ORDER BY external_id`)).rows, [{ external_id: 'kept' }]);
    assert.equal((await db.query(`SELECT 1 AS ok`)).rows[0].ok, 1);
    await db.exec('COMMIT');
  } finally { await db.close(); }
});

test('gift writes stay inside the caller scope', async () => {
  const db = new PGlite();
  try {
    await databaseSetup(db);
    await begin(db, 'alice');
    await assert.rejects(() => applyReviewedGifts(db, { org_id: other, operations: [insert(0)] }), /organization/);
    await assert.rejects(() => applyReviewedGifts(db, { org_id: org, operations: [insert(0, { donor_id: donorB })] }));
    assert.equal(await countGifts(db), 0);
    await db.exec('ROLLBACK');

    await begin(db, 'admin');
    const applied = await applyReviewedGifts(db, { org_id: org, operations: [insert(0, {
      donor_id: unassigned, external_id: 'open', source_row: { batch_id: batch, row_key: 'open' } })] });
    await db.exec('COMMIT');
    assert.equal((await db.query(`SELECT donor_id::text FROM gifts WHERE id = $1`, [applied.applied[0].id])).rows[0].donor_id, unassigned);
  } finally { await db.close(); }
});

test('corrections change financial facts only and record the session member', async () => {
  const db = new PGlite();
  try {
    await databaseSetup(db);
    await db.query(`INSERT INTO gifts (id, org_id, donor_id, amount_cents, refund_cents, currency, occurred_at, status, source, external_id, source_row)
      VALUES ($1, $2, $3, 1000, 0, 'USD', $4, 'settled', $6, 'tx-old', $5::jsonb)`,
      [giftA, org, donorA, when, JSON.stringify({ batch_id: batch, row_key: '2' }), "zeffy'; drop"]);
    await begin(db, 'alice');
    const financial = draft({ amount_cents: 2500, refund_cents: 100, status: 'pending', external_id: 'tx-old' });
    const applied = await applyReviewedGifts(db, { org_id: org, operations: [
      { kind: 'gift', row: 0, op: 'correct', gift_id: giftA, reviewer_id: alice, draft: financial }] });
    assert.deepEqual(applied.applied, [{ row: 0, op: 'correct', id: giftA }]);
    await assert.rejects(() => applyReviewedGifts(db, { org_id: org, operations: [
      { kind: 'gift', row: 1, op: 'correct', gift_id: giftA, reviewer_id: alice,
        draft: draft({ external_id: 'tx-new', amount_cents: 1000 }) }] }), /identity/);
    await assert.rejects(() => applyReviewedGifts(db, { org_id: org, operations: [
      { kind: 'gift', row: 2, op: 'correct', gift_id: giftA, reviewer_id: bob, draft: financial }] }), /reviewer/);
    const stored = (await db.query(`SELECT amount_cents::text, refund_cents::text, status, external_id, source_row FROM gifts WHERE id = $1`, [giftA])).rows[0];
    assert.deepEqual(stored, { amount_cents: '2500', refund_cents: '100', status: 'pending', external_id: 'tx-old',
      source_row: { batch_id: batch, row_key: '2' } });
    assert.deepEqual((await db.query(`SELECT actor_id::text, action, target_id::text FROM audit_events`)).rows,
      [{ actor_id: alice, action: 'gift.correct', target_id: giftA }]);
    await db.exec('COMMIT');
  } finally { await db.close(); }
});

test('donor creation and unresolved donor rows are not applied', async () => {
  const db = new PGlite();
  try {
    await databaseSetup(db);
    await begin(db, 'admin');
    const donorCreate = { kind: 'donor', row: 0, op: 'create', reviewer_id: admin, draft: { name: 'New', email: null, phone: null, consent: 'unknown', metadata: {} } };
    const pendingGift = { kind: 'gift', row: 0, op: 'insert', reviewer_id: null, donor_row: 0, draft: draft({ donor_id: undefined }) };
    await assert.rejects(() => applyReviewedGifts(db, { org_id: org, operations: [donorCreate] }), /donor/);
    await assert.rejects(() => applyReviewedGifts(db, { org_id: org, operations: [pendingGift] }), /donor/);
    await applyReviewedGifts(db, { org_id: org, operations: [] });
    assert.equal(await countGifts(db), 0);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM audit_events`)).rows[0].n, 0);
    assert.equal((await db.query(`SELECT 1 AS ok`)).rows[0].ok, 1);
    await db.exec('ROLLBACK');
  } finally { await db.close(); }
});

async function databaseSetup(db: PGlite) {
  await db.exec(readFileSync(new URL('../db/migrations/001_core.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../db/migrations/002_assignment.sql', import.meta.url), 'utf8'));
  await db.query(`INSERT INTO organizations (id, name) VALUES ($1, 'CIC'), ($2, 'Other')`, [org, other]);
  for (const [member, subject, role] of [[alice, 'alice', 'board'], [bob, 'bob', 'board'], [admin, 'admin', 'admin']] as const) {
    await db.query(`INSERT INTO memberships (id, org_id, clerk_subject, role) VALUES ($1, $2, $3, $4)`, [member, org, subject, role]);
  }
  for (const [donor, owner, name] of [[donorA, alice, 'Alex'], [donorB, bob, 'Sam'], [unassigned, null, 'Open']] as const) {
    await db.query(`INSERT INTO donors (id, org_id, owner_id, name) VALUES ($1, $2, $3, $4)`, [donor, org, owner, name]);
  }
}
