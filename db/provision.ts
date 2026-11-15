import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { z } from 'zod';

interface ProvisionClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Errors whose messages are ours and safe to print (no SQL values or credentials). */
export class ProvisionError extends Error {}

const Member = z.strictObject({
  clerk_subject: z.string().regex(/^user_[A-Za-z0-9]{1,64}$/, 'Expected a Clerk user ID (user_…), not an email or name'),
  role: z.enum(['admin', 'board']),
  active: z.boolean().default(true),
});
export const ProvisionSchema = z.strictObject({
  organization: z.strictObject({ name: z.string().trim().min(1, 'Organization name is required').max(200) }),
  members: z.array(Member).min(1),
}).superRefine((input, ctx) => {
  const seen = new Set<string>();
  for (const [i, m] of input.members.entries()) {
    if (seen.has(m.clerk_subject)) ctx.addIssue({ code: 'custom', path: ['members', i], message: `Duplicate member ${i}` });
    seen.add(m.clerk_subject);
  }
  if (!input.members.some((m) => m.role === 'admin' && m.active)) {
    ctx.addIssue({ code: 'custom', path: ['members'], message: 'At least one active admin is required' });
  }
});
export type ProvisionInput = z.input<typeof ProvisionSchema>;
export type ProvisionResult = {
  organization: 'created' | 'updated' | 'unchanged';
  members: { created: number; updated: number; unchanged: number };
  /** Existing memberships not listed in this roster; never changed or deactivated implicitly. */
  untouched: number;
};

/**
 * True when this connection can actually become cic_runtime (SET option), i.e. it is the runtime login.
 * Plain MEMBER is not enough: PostgreSQL 16+ makes a CREATEROLE migration owner that created
 * cic_runtime a member WITH ADMIN but without SET, and that owner must be allowed to provision.
 */
export async function isRuntimeLogin(client: ProvisionClient): Promise<boolean> {
  const [who] = (await client.query(`SELECT r.rolsuper AS superuser,
      pg_has_role(current_user, 'cic_runtime', 'SET') AS can_set
    FROM pg_roles r WHERE r.rolname = current_user`)).rows;
  return !who?.superuser && who?.can_set === true;
}

/** Parse roster file text; never echo it, since JSON errors quote the input. */
export function parseRoster(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new ProvisionError('Roster file is not valid JSON'); }
}

const outcome = (rows: Record<string, unknown>[]) =>
  rows.length === 0 ? 'unchanged' : rows[0].inserted ? 'created' : 'updated';

/**
 * Trusted bootstrap: create or update CIC's organization and memberships keyed by Clerk user ID.
 * Run only on the privileged migration connection; the runtime login is refused.
 */
export async function provision(client: ProvisionClient, orgId: string, raw: ProvisionInput | unknown): Promise<ProvisionResult> {
  if (!z.uuid().safeParse(orgId).success) throw new ProvisionError('CIC_ORG_ID must be a UUID');
  const parsed = ProvisionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProvisionError(parsed.error.issues.map((i) => `${i.path.join('.') || 'roster'}: ${i.message}`).join('; '));
  }
  const input = parsed.data;

  if (await isRuntimeLogin(client)) {
    throw new ProvisionError('Refusing to provision with the runtime login; use MIGRATION_DATABASE_URL');
  }

  await client.query('BEGIN');
  try {
    const org = outcome((await client.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
      WHERE organizations.name IS DISTINCT FROM EXCLUDED.name
      RETURNING (xmax = 0) AS inserted`, [orgId, input.organization.name])).rows);
    const members = { created: 0, updated: 0, unchanged: 0 };
    for (const m of input.members) {
      members[outcome((await client.query(`INSERT INTO memberships (org_id, clerk_subject, role, active)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (org_id, clerk_subject) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active
        WHERE (memberships.role, memberships.active) IS DISTINCT FROM (EXCLUDED.role, EXCLUDED.active)
        RETURNING (xmax = 0) AS inserted`, [orgId, m.clerk_subject, m.role, m.active])).rows)]++;
    }
    const [{ untouched }] = (await client.query(`SELECT count(*)::int AS untouched FROM memberships
      WHERE org_id = $1 AND NOT (clerk_subject = ANY($2::text[]))`,
    [orgId, input.members.map((m) => m.clerk_subject)])).rows as [{ untouched: number }];
    await client.query('COMMIT');
    return { organization: org, members, untouched };
  } catch (error) {
    await client.query('ROLLBACK');
    const pg = error as { code?: string; message?: string };
    if (pg.code === '42501' || /row-level security|permission denied/i.test(pg.message ?? '')) {
      throw new ProvisionError('This connection role cannot bypass row-level security; ' +
        'provision with the migration owner (MIGRATION_DATABASE_URL), never by granting BYPASSRLS to the runtime login');
    }
    throw error;
  }
}

if (import.meta.main) {
  let client: Client | undefined;
  try {
    const path = process.argv[2];
    if (!path) throw new ProvisionError('Usage: node --env-file-if-exists=.env db/provision.ts <roster.json>');
    const roster = parseRoster(await readFile(path, 'utf8'));
    const url = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new ProvisionError('Invalid MIGRATION_DATABASE_URL');
    client = new Client({ connectionString: url.href, connectionTimeoutMillis: 10000 });
    await client.connect();
    const result = await provision(client, process.env.CIC_ORG_ID ?? '', roster);
    console.log(`Organization ${result.organization}; members created ${result.members.created}, ` +
      `updated ${result.members.updated}, unchanged ${result.members.unchanged}; ${result.untouched} not in roster left as-is`);
  } catch (error) {
    // Driver errors can contain connection details; only our own messages are printed.
    console.error(error instanceof ProvisionError
      ? `Provisioning failed: ${error.message}` : 'Provisioning failed; check the migration connection. No credentials are logged.');
    process.exitCode = 1;
  } finally { await client?.end(); }
}
