import { Client } from 'pg';
import { z } from 'zod';

interface SeedClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export class SeedError extends Error {}
export type SeedResult = { programs: number; campaigns: number; donors: number; gifts: number };

// Deterministic, recognizable demo IDs so re-runs insert nothing new.
const id = (kind: 'a' | 'b' | 'c' | 'd', n: number) => `de300000-0000-4000-8000-${kind}${n.toString(16).padStart(11, '0')}`;

const PROGRAMS = ['AI Academy', 'Summer Camp', 'Day of Compute'];
// [title, program index or null]: Giving Tuesday and AZ Gives are general, not program-restricted.
const CAMPAIGNS: Array<[string, number | null]> = [
  ['AI Academy Fund', 0], ['Summer Camp 2026', 1], ['Day of Compute 2026', 2],
  ['Giving Tuesday 2025', null], ['AZ Gives 2026', null],
];
const FIRST = ['Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Quinn', 'Rowan', 'Skyler', 'Emerson', 'Finley', 'Harper', 'Jules'];
const LAST = ['Rivera', 'Chen', 'Okafor', 'Nguyen', 'Patel', 'Garcia', 'Kim', 'Haddad', 'Silva', 'Novak', 'Mensah', 'Ortiz'];
const SOURCES = ['zeffy', 'benevity', 'spreadsheet'];

type Pattern = 'new' | 'reactivated' | 'increased' | 'flat' | 'decreased' | 'lapsed' | 'dormant';
const PATTERNS: Pattern[] = ['new', 'reactivated', 'increased', 'flat', 'decreased', 'lapsed', 'dormant'];
type GiftSpec = { day: string; cents: number; refund?: number; status?: 'settled' | 'pending'; campaign: number | null };

/** Gifts per pattern, as of Nov 14 2026: YTD 2026 vs YTD 2025 lands each donor in its intended segment. */
function giftsFor(pattern: Pattern, a: number, c: (k: number) => number | null): GiftSpec[] {
  switch (pattern) {
    case 'new': return [{ day: '2026-03-12', cents: a, campaign: c(0) },
      { day: '2026-11-10', cents: a, status: 'pending', campaign: c(1) }];
    case 'reactivated': return [{ day: '2023-11-28', cents: a, campaign: c(0) }, { day: '2026-05-06', cents: a, campaign: c(1) }];
    case 'increased': return [{ day: '2025-04-15', cents: a, campaign: c(0) }, { day: '2026-04-15', cents: a * 2, campaign: c(1) },
      { day: '2026-09-02', cents: a / 2, campaign: c(2) }];
    case 'flat': return [{ day: '2025-06-10', cents: a, campaign: c(0) }, { day: '2026-06-10', cents: a, campaign: c(1) },
      { day: '2026-07-01', cents: a, refund: a, campaign: c(2) }];
    case 'decreased': return [{ day: '2025-02-20', cents: a * 2, campaign: c(0) }, { day: '2026-02-20', cents: a, campaign: c(1) }];
    case 'lapsed': return [{ day: '2025-09-30', cents: a, campaign: c(0) }];
    case 'dormant': return [{ day: '2024-12-03', cents: a, campaign: c(0) }];
  }
}

async function assertPrivileged(client: SeedClient) {
  const [who] = (await client.query(`SELECT r.rolsuper AS superuser,
      pg_has_role(current_user, 'cic_runtime', 'MEMBER') AS runtime
    FROM pg_roles r WHERE r.rolname = current_user`)).rows;
  if (!who?.superuser && who?.runtime) throw new SeedError('Refusing to seed with the runtime login; use MIGRATION_DATABASE_URL');
}

/**
 * Insert a deterministic, entirely fictional demo dataset for a provisioned organization.
 * Refuses to touch an organization that already holds any non-demo donor.
 */
export async function seedDemo(client: SeedClient, orgId: string): Promise<SeedResult> {
  if (!z.uuid().safeParse(orgId).success) throw new SeedError('CIC_ORG_ID must be a UUID');
  await assertPrivileged(client);
  await client.query('BEGIN');
  try {
    if ((await client.query('SELECT 1 FROM organizations WHERE id = $1', [orgId])).rows.length === 0) {
      throw new SeedError('Organization not found: run db/provision.ts first');
    }
    const owners = (await client.query(`SELECT id FROM memberships
      WHERE org_id = $1 AND active AND role = 'board' ORDER BY clerk_subject`, [orgId])).rows.map((r) => r.id as string);
    if (owners.length === 0) throw new SeedError('No active board members: provision at least one with db/provision.ts');
    if ((await client.query(`SELECT 1 FROM donors WHERE org_id = $1
        AND coalesce(metadata->>'demo', '') <> 'true' LIMIT 1`, [orgId])).rows.length > 0) {
      throw new SeedError('Refusing to seed: this organization already has non-demo donors');
    }
    const result: SeedResult = { programs: 0, campaigns: 0, donors: 0, gifts: 0 };
    const inserted = async (sql: string, values: unknown[]) => (await client.query(sql, values)).rows.length;

    for (const [i, title] of PROGRAMS.entries()) {
      result.programs += await inserted(`INSERT INTO programs (id, org_id, title) VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING RETURNING id`, [id('a', i), orgId, title]);
    }
    for (const [i, [title, program]] of CAMPAIGNS.entries()) {
      result.campaigns += await inserted(`INSERT INTO campaigns (id, org_id, program_id, title) VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO NOTHING RETURNING id`, [id('b', i), orgId, program === null ? null : id('a', program), title]);
    }

    type Donor = { name: string; email: string | null; phone: string | null; kind: string; gifts: GiftSpec[] };
    const donors: Donor[] = [];
    for (let i = 0; i < 24; i++) {
      const first = FIRST[i % FIRST.length], last = LAST[(i * 5) % LAST.length];
      // Campaign rotates per gift; every sixth slot is unattributed (no campaign).
      const campaign = (k: number) => ((i + k) % 6 === 5 ? null : (i + k) % 6);
      donors.push({ name: `${first} ${last}`, email: `${first}.${last}@example.org`.toLowerCase(),
        phone: `602-555-01${String(i).padStart(2, '0')}`, kind: 'individual',
        gifts: giftsFor(PATTERNS[i % PATTERNS.length], ((i % 5) + 1) * 2500, campaign) });
    }
    donors.push({ name: 'Example Foundation', email: null, phone: null, kind: 'foundation', gifts: [
      { day: '2025-03-15', cents: 2_500_000, campaign: 0 }, { day: '2026-03-15', cents: 3_000_000, campaign: 0 }] });
    donors.push({ name: 'Desert Utility Community Fund', email: null, phone: null, kind: 'foundation', gifts: [
      { day: '2025-08-01', cents: 1_000_000, campaign: 1 }, { day: '2026-08-03', cents: 1_000_000, campaign: 1 }] });

    let giftNo = 0;
    for (const [i, d] of donors.entries()) {
      result.donors += await inserted(`INSERT INTO donors (id, org_id, owner_id, name, email, phone, consent, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id('c', i), orgId, owners[i % owners.length], d.name, d.email, d.phone,
        i % 3 === 0 ? 'unknown' : 'granted', JSON.stringify({ demo: true, kind: d.kind })]);
      for (const g of d.gifts) {
        const n = giftNo++;
        result.gifts += await inserted(`INSERT INTO gifts (id, org_id, donor_id, campaign_id, amount_cents, refund_cents,
            currency, occurred_at, status, source, external_id)
          VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id('d', n), orgId, id('c', i), g.campaign === null ? null : id('b', g.campaign), g.cents, g.refund ?? 0,
          `${g.day}T12:00:00-07:00`, g.status ?? 'settled', SOURCES[n % SOURCES.length], `demo-${n}`]);
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

if (import.meta.main) {
  let client: Client | undefined;
  try {
    if (!process.argv.includes('--yes-demo-data')) {
      throw new SeedError('Writes fictional demo donors and gifts. Re-run with --yes-demo-data to confirm.');
    }
    const url = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new SeedError('Invalid MIGRATION_DATABASE_URL');
    client = new Client({ connectionString: url.href, connectionTimeoutMillis: 10000 });
    await client.connect();
    const r = await seedDemo(client, process.env.CIC_ORG_ID ?? '');
    console.log(`Inserted ${r.programs} programs, ${r.campaigns} campaigns, ${r.donors} donors, ${r.gifts} gifts (existing rows skipped)`);
  } catch (error) {
    // Driver errors can contain connection details; only our own messages are printed.
    console.error(error instanceof SeedError ? `Seeding failed: ${error.message}`
      : 'Seeding failed; check the migration connection. No credentials are logged.');
    process.exitCode = 1;
  } finally { await client?.end(); }
}
