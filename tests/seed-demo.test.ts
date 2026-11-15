import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../db/migrate.ts';
import { provision } from '../db/provision.ts';
import { seedDemo } from '../db/seed-demo.ts';
import { retentionReport, ytdWindows } from '../packages/reporting/retention.ts';
import { buildQueue, type OutreachTask } from '../packages/outreach/queue.ts';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const migrations = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const roster = {
  organization: { name: 'Coding in Color (demo)' },
  members: [
    { clerk_subject: 'user_demoAdmin', role: 'admin' as const },
    { clerk_subject: 'user_demoJordan', role: 'board' as const },
    { clerk_subject: 'user_demoTaylor', role: 'board' as const },
    { clerk_subject: 'user_demoRiley', role: 'board' as const },
    { clerk_subject: 'user_demoGone', role: 'board' as const, active: false },
  ],
};

async function database(t: test.TestContext, withRoster = true) {
  const db = new PGlite();
  t.after(() => db.close());
  const client = { query: async (sql: string, values?: unknown[]) => values
    ? db.query<Record<string, unknown>>(sql, values)
    : (await db.exec(sql)).at(-1)! };
  await migrate(client, migrations);
  if (withRoster) await provision(client, ORG, roster);
  return { db, client };
}

test('seeds fictional donors, gifts, programs and campaigns, and is idempotent', async (t) => {
  const { db, client } = await database(t);
  const first = await seedDemo(client, ORG);
  assert.ok(first.donors >= 20 && first.gifts >= 50, JSON.stringify(first));
  assert.deepEqual(await seedDemo(client, ORG), { programs: 0, campaigns: 0, donors: 0, gifts: 0, follow_ups: 0 });
  const [{ n }] = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM gifts')).rows;
  assert.equal(n, first.gifts);
  // Fictional contact data only: reserved example domain and 555-01xx phone numbers.
  const contacts = (await db.query<{ email: string | null; phone: string | null }>('SELECT email, phone FROM donors')).rows;
  for (const c of contacts) {
    assert.ok(c.email === null || c.email.endsWith('@example.org'), c.email ?? '');
    assert.ok(c.phone === null || /^602-555-01\d\d$/.test(c.phone), c.phone ?? '');
  }
});

test('two organizations each get their own full demo dataset (IDs are scoped per org)', async (t) => {
  // Review on #36: global fixed IDs made a second org's seed "succeed" with zero rows.
  const OTHER = '00000000-0000-4000-8000-0000000000c2';
  const { db, client } = await database(t);
  await provision(client, OTHER, roster);
  const a = await seedDemo(client, ORG);
  const b = await seedDemo(client, OTHER);
  assert.deepEqual(b, a);
  assert.ok(b.donors >= 20 && b.gifts >= 50, JSON.stringify(b));
  const counts = (await db.query<{ org_id: string; donors: number; gifts: number }>(`
    SELECT o.id AS org_id, (SELECT count(*) FROM donors d WHERE d.org_id = o.id)::int AS donors,
      (SELECT count(*) FROM gifts g WHERE g.org_id = o.id)::int AS gifts FROM organizations o ORDER BY o.id`)).rows;
  assert.deepEqual(counts, [{ org_id: ORG, donors: a.donors, gifts: a.gifts }, { org_id: OTHER, donors: a.donors, gifts: a.gifts }]);
  // Every donor's owner belongs to the donor's own organization.
  assert.equal((await db.query(`SELECT 1 FROM donors d JOIN memberships m ON m.id = d.owner_id
    WHERE m.org_id <> d.org_id`)).rows.length, 0);
  assert.deepEqual(await seedDemo(client, OTHER), { programs: 0, campaigns: 0, donors: 0, gifts: 0, follow_ups: 0 });
});

test('every donor is owned by an active member and ownership is balanced', async (t) => {
  const { db, client } = await database(t);
  await seedDemo(client, ORG);
  const loads = (await db.query<{ subject: string; role: string; active: boolean; n: number }>(`
    SELECT m.clerk_subject AS subject, m.role, m.active, count(d.id)::int AS n
    FROM memberships m LEFT JOIN donors d ON d.owner_id = m.id GROUP BY 1, 2, 3`)).rows;
  assert.equal((await db.query('SELECT 1 FROM donors WHERE owner_id IS NULL')).rows.length, 0);
  assert.equal(loads.find((l) => !l.active)!.n, 0);
  assert.equal(loads.find((l) => l.role === 'admin')!.n, 0);
  const board = loads.filter((l) => l.active && l.role === 'board').map((l) => l.n);
  assert.ok(Math.max(...board) - Math.min(...board) <= 1, JSON.stringify(loads));
});

test('the seeded ledger exercises every retention segment and the funder packet edge cases', async (t) => {
  const { db, client } = await database(t);
  await seedDemo(client, ORG);
  // YTD 2026 through Nov 14 vs the same 2025 window, Phoenix time (matches packages/reporting ytdWindows).
  const rows = (await db.query<{ prior: number; current: number; earlier: boolean }>(`
    SELECT
      coalesce(sum(net) FILTER (WHERE occurred_at >= '2025-01-01T00:00:00-07:00' AND occurred_at < '2025-11-15T00:00:00-07:00'), 0)::int AS prior,
      coalesce(sum(net) FILTER (WHERE occurred_at >= '2026-01-01T00:00:00-07:00' AND occurred_at < '2026-11-15T00:00:00-07:00'), 0)::int AS current,
      bool_or(net > 0 AND occurred_at < '2026-01-01T00:00:00-07:00') AS earlier
    FROM (SELECT donor_id, occurred_at,
            CASE WHEN status = 'settled' THEN amount_cents - refund_cents ELSE 0 END AS net FROM gifts) g
    GROUP BY donor_id`)).rows;
  const segments = new Set<string>(rows.map(({ prior, current, earlier }) =>
    prior === 0 ? (current === 0 ? 'none' : earlier ? 'reactivated' : 'new')
      : current === 0 ? 'lapsed' : current > prior ? 'increased' : current < prior ? 'decreased' : 'flat'));
  for (const s of ['new', 'reactivated', 'increased', 'flat', 'decreased', 'lapsed', 'none']) {
    assert.ok(segments.has(s), `missing segment ${s}`);
  }
  const [edges] = (await db.query<Record<string, number>>(`SELECT
      count(*) FILTER (WHERE refund_cents > 0)::int AS refunds,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE campaign_id IS NULL)::int AS unattributed,
      count(DISTINCT source)::int AS sources FROM gifts`)).rows;
  assert.ok(edges.refunds >= 1 && edges.pending >= 1 && edges.unattributed >= 1 && edges.sources >= 3, JSON.stringify(edges));
  const [funder] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gifts g
    JOIN donors d ON d.id = g.donor_id JOIN campaigns c ON c.id = g.campaign_id JOIN programs p ON p.id = c.program_id
    WHERE d.metadata->>'kind' = 'foundation' AND p.title = 'AI Academy'`)).rows;
  assert.ok(funder.n >= 2, 'a foundation funder needs AI Academy gifts for the packet demo');
});

test('a non-superuser CREATEROLE migration owner can seed (same guard as provisioning)', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE ROLE migration_owner NOLOGIN CREATEROLE BYPASSRLS;
    ALTER DATABASE postgres OWNER TO migration_owner; GRANT CREATE ON SCHEMA public TO migration_owner;
    SET SESSION AUTHORIZATION migration_owner;`);
  const client = { query: async (sql: string, values?: unknown[]) => values
    ? db.query<Record<string, unknown>>(sql, values)
    : (await db.exec(sql)).at(-1)! };
  await migrate(client, migrations);
  await provision(client, ORG, roster);
  assert.ok((await seedDemo(client, ORG)).gifts >= 50);
});

test('the real retention calculation puts each seeded donor in its designed segment', async (t) => {
  const { db, client } = await database(t);
  await seedDemo(client, ORG);
  const gifts = (await db.query<Record<string, string>>(`SELECT donor_id, amount_cents::text AS amount_cents,
      refund_cents::text AS refund_cents, currency, status,
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at FROM gifts`)).rows
    .map((g) => ({ donor_id: g.donor_id, currency: g.currency, occurred_at: g.occurred_at,
      amount_cents: Number(g.amount_cents), refund_cents: Number(g.refund_cents),
      status: g.status as 'settled' | 'pending' | 'void' }));
  const usd = retentionReport(gifts, ytdWindows('2026-11-14', '-07:00')).byCurrency.USD;
  // 24 individuals cycle through 7 patterns (dormant donors are omitted) plus two foundations.
  assert.deepEqual(Object.fromEntries(Object.entries(usd.segments).map(([k, v]) => [k, v.donors])),
    { new: 4, reactivated: 4, increased: 5, flat: 4, decreased: 3, lapsed: 3 });
  assert.deepEqual(usd.retention, { retained_donors: 12, prior_donors: 15 });
});

test('the demo has outreach work: a Q4 touch per donor plus overdue, this-week and upcoming next steps', async (t) => {
  const { db, client } = await database(t);
  const seeded = await seedDemo(client, ORG);
  assert.equal(seeded.follow_ups, 32);   // 26 quarterly touches + 6 next actions
  const rows = (await db.query<OutreachTask & { donor_owner: string }>(`SELECT f.id, f.donor_id, f.owner_id, f.kind,
      f.quarter, f.title, f.status, to_char(f.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_at,
      d.owner_id AS donor_owner FROM follow_ups f JOIN donors d ON d.id = f.donor_id`)).rows;
  assert.equal(rows.filter((r) => r.kind === 'quarterly' && r.quarter === '2026-Q4').length, 26);
  assert.ok(rows.every((r) => r.owner_id === r.donor_owner && r.status === 'open'), 'tasks belong to the donor owner');
  // On demo day, the queue shows every urgency bucket.
  const queue = buildQueue(rows, { now: '2026-11-15T09:00:00-07:00' });
  assert.ok(queue.overdue.length >= 2 && queue.due_this_week.length >= 2 && queue.upcoming.length >= 28, JSON.stringify(
    [queue.overdue.length, queue.due_this_week.length, queue.upcoming.length]));
  assert.equal((await seedDemo(client, ORG)).follow_ups, 0);
});

test('refuses to run without provisioning, against real data, or on the runtime login', async (t) => {
  const bare = await database(t, false);
  await assert.rejects(seedDemo(bare.client, ORG), /provision/i);

  const { db, client } = await database(t);
  await db.query(`INSERT INTO donors (org_id, owner_id, name, metadata)
    SELECT $1, id, 'A real donor', '{}' FROM memberships WHERE clerk_subject = 'user_demoJordan'`, [ORG]);
  await assert.rejects(seedDemo(client, ORG), /non-demo/);
  assert.equal((await db.query('SELECT 1 FROM gifts')).rows.length, 0);

  await db.exec(`CREATE ROLE cic_app_seed NOLOGIN NOINHERIT NOBYPASSRLS; GRANT cic_runtime TO cic_app_seed;
    SET SESSION AUTHORIZATION cic_app_seed;`);
  await assert.rejects(seedDemo(client, ORG), /runtime/);
  await db.exec('RESET SESSION AUTHORIZATION;');
});
