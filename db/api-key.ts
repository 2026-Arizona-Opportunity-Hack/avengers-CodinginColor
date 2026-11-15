import { Client } from 'pg';
import { z } from 'zod';
import { generateApiKey } from '../packages/reporting/summary.ts';

interface KeyClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
/** Errors whose messages are ours and safe to print. */
export class KeyToolError extends Error {}

const orgId = z.uuid();
const name = z.string().trim().min(1).max(100);

/**
 * Issue a dashboard key for an organization, recorded as created by an active admin.
 * Only the SHA-256 hash and a short hint are stored; the raw key is returned once to show the operator.
 */
export async function createKey(client: KeyClient, org: string, input: { name: string; adminSubject: string }) {
  if (!orgId.safeParse(org).success) throw new KeyToolError('CIC_ORG_ID must be a UUID');
  const label = name.safeParse(input.name);
  if (!label.success) throw new KeyToolError('Key name must be 1-100 characters');
  const [admin] = (await client.query(`SELECT id FROM memberships
    WHERE org_id = $1 AND clerk_subject = $2 AND active AND role = 'admin'`, [org, input.adminSubject])).rows;
  if (!admin) throw new KeyToolError('The creator must be an active admin of this organization');
  const key = generateApiKey();
  await client.query(`INSERT INTO api_keys (org_id, name, key_hash, hint, scopes, created_by)
    VALUES ($1, $2, $3, $4, ARRAY['read:aggregates'], $5)`, [org, label.data, key.hash, key.hint, admin.id]);
  return key;
}

/** Revoke the single active key with this hint. Returns how many keys were revoked (0 or 1). */
export async function revokeKey(client: KeyClient, org: string, hint: string): Promise<number> {
  if (!orgId.safeParse(org).success) throw new KeyToolError('CIC_ORG_ID must be a UUID');
  const active = (await client.query('SELECT id FROM api_keys WHERE org_id = $1 AND hint = $2 AND revoked_at IS NULL',
    [org, hint])).rows;
  if (active.length > 1) throw new KeyToolError('More than one active key has this hint; revoke by id instead');
  if (active.length === 0) return 0;
  await client.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [active[0].id]);
  return 1;
}

export async function listKeys(client: KeyClient, org: string) {
  return (await client.query(`SELECT name, hint, created_at, revoked_at FROM api_keys
    WHERE org_id = $1 ORDER BY created_at`, [org])).rows;
}

if (import.meta.main) {
  let client: Client | undefined;
  try {
    const [command, ...args] = process.argv.slice(2);
    const org = process.env.CIC_ORG_ID ?? '';
    if (!['create', 'revoke', 'list'].includes(command ?? '')) {
      throw new KeyToolError('Usage: db/api-key.ts create "<name>" <admin clerk user ID> | revoke <hint> | list');
    }
    const url = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new KeyToolError('Invalid MIGRATION_DATABASE_URL');
    client = new Client({ connectionString: url.href, connectionTimeoutMillis: 10000 });
    await client.connect();
    if (command === 'create') {
      const key = await createKey(client, org, { name: args[0] ?? '', adminSubject: args[1] ?? '' });
      console.log(`Created key ${key.hint}… Copy it now; it will not be shown again:\n${key.key}`);
    } else if (command === 'revoke') {
      console.log(`Revoked ${await revokeKey(client, org, args[0] ?? '')} key(s)`);
    } else {
      console.table(await listKeys(client, org));
    }
  } catch (error) {
    // Driver errors can contain connection details; only our own messages are printed.
    console.error(error instanceof KeyToolError ? `API key tool failed: ${error.message}`
      : 'API key tool failed; check the migration connection. No credentials are logged.');
    process.exitCode = 1;
  } finally { await client?.end(); }
}
