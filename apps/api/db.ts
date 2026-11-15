import { z } from 'zod';
import { HttpError } from './env.ts';
import type { Identity } from './auth.ts';

export interface Client {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}
export interface Database { connect(): Promise<Client> }
const Membership = z.object({ id: z.uuid(), org_id: z.uuid(), role: z.enum(['admin', 'board']) });
export type Member = z.infer<typeof Membership>;

export async function withMember<T>(db: Database, orgId: string, identity: Identity,
  action: (client: Client, member: Member) => Promise<T>): Promise<T> {
  const org = z.uuid().parse(orgId);
  const subject = z.string().min(1).parse(identity.subject);
  const client = await db.connect();
  let destroy = false;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE cic_runtime');
    await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [org, subject]);
    const result = await client.query(
      'SELECT id, org_id, role FROM memberships WHERE org_id = $1 AND clerk_subject = $2 AND active', [org, subject]);
    if (result.rows.length !== 1) throw new HttpError(403);
    const member = Membership.parse(result.rows[0]);
    if (member.org_id !== org || (member.role === 'admin' && !identity.mfa)) throw new HttpError(403);
    const value = await action(client, member);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroy = true; }
    throw error;
  } finally { client.release(destroy); }
}
