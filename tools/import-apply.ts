import { GiftWriteSchema } from '../packages/contracts/index.ts';

type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
type Operation = {
  kind: string; row: number; op: string; reviewer_id?: string | null;
  draft: unknown; donor_row?: unknown; gift_id?: string;
};
type Applied = { row: number; op: 'insert' | 'correct'; id: string };

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Operation must be an object');
  }
  return value as Record<string, unknown>;
};

const rowsOf = (result: { rows: unknown[] }) => result.rows as Record<string, unknown>[];

// jsonb returns object keys in its own canonical order, so compare fields, not serialization.
const sameRow = (a: unknown, b: unknown) => {
  if (a == null || b == null) return a == null && b == null;
  const [x, y] = [a, b] as { batch_id?: unknown; row_key?: unknown }[];
  return x.batch_id === y.batch_id && x.row_key === y.row_key;
};

async function applyOne(client: Client, operation: Operation, actor: string): Promise<Applied> {
  const fields = GiftWriteSchema.parse(operation.draft);
  if (operation.op === 'insert') {
    if (fields.source_row) {
      const stored = await client.query(
        `SELECT 1 FROM gifts WHERE org_id = cic_org_id()
          AND source_row->>'batch_id' = $1 AND source_row->>'row_key' = $2 LIMIT 1`,
        [fields.source_row.batch_id, fields.source_row.row_key]);
      if (stored.rows.length) throw new Error('Gift provenance conflicts with a stored source row');
    }
    const inserted = rowsOf(await client.query(
      `INSERT INTO gifts
        (org_id, donor_id, campaign_id, amount_cents, refund_cents, currency,
         occurred_at, status, source, external_id, source_row)
       VALUES (cic_org_id(), $1::uuid, $2::uuid, $3::bigint, $4::bigint, $5,
         $6::timestamptz, $7, $8, $9, $10::jsonb)
       RETURNING id::text AS id`,
      [fields.donor_id, fields.campaign_id ?? null, String(fields.amount_cents),
        String(fields.refund_cents), fields.currency, fields.occurred_at, fields.status,
        fields.source, fields.external_id ?? null,
        fields.source_row ? JSON.stringify(fields.source_row) : null]));
    const id = inserted[0].id as string;
    await client.query(
      `INSERT INTO audit_events (org_id, actor_id, action, target_id, status)
       VALUES (cic_org_id(), $1::uuid, 'gift.insert', $2::uuid, 'success')`, [actor, id]);
    return { row: operation.row, op: 'insert', id };
  }

  if (!operation.gift_id) throw new Error('Correcting a gift requires gift_id');
  const existing = rowsOf(await client.query(
    `SELECT donor_id::text, source, external_id, source_row FROM gifts
      WHERE id = $1::uuid AND org_id = cic_org_id()`, [operation.gift_id]))[0];
  if (!existing) throw new Error('Gift not found');
  const identityChanged = existing.donor_id !== fields.donor_id
    || existing.source !== fields.source
    || (existing.external_id ?? null) !== (fields.external_id ?? null)
    || !sameRow(existing.source_row, fields.source_row ? { ...fields.source_row } : null);
  if (identityChanged) throw new Error('Gift identity fields cannot be changed');
  await client.query(
    `UPDATE gifts SET amount_cents = $2::bigint, refund_cents = $3::bigint,
       currency = $4, occurred_at = $5::timestamptz, status = $6,
       campaign_id = $7::uuid, updated_at = now()
     WHERE id = $1::uuid AND org_id = cic_org_id()`,
    [operation.gift_id, String(fields.amount_cents), String(fields.refund_cents),
      fields.currency, fields.occurred_at, fields.status, fields.campaign_id ?? null]);
  await client.query(
    `INSERT INTO audit_events (org_id, actor_id, action, target_id, status)
     VALUES (cic_org_id(), $1::uuid, 'gift.correct', $2::uuid, 'success')`,
    [actor, operation.gift_id]);
  return { row: operation.row, op: 'correct', id: operation.gift_id };
}

export async function applyReviewedGifts(client: Client,
  input: { org_id: string; operations: unknown[] }): Promise<{ applied: Applied[] }> {
  const scope = rowsOf(await client.query(`SELECT cic_org_id()::text AS org`))[0].org;
  if (scope !== input.org_id) throw new Error('Operations belong to a different organization');
  const actor = rowsOf(await client.query(`SELECT cic_member_id()::text AS actor`))[0].actor as string | null;

  const operations = input.operations.map(asRecord);
  for (const operation of operations) {
    if (operation.kind !== 'gift' || 'donor_row' in operation) {
      throw new Error('Donor operations and unresolved donor rows are not applied here');
    }
    if (operation.op !== 'insert' && operation.op !== 'correct') {
      throw new Error('Only gift insert and gift correct operations are supported');
    }
    const reviewer = (operation.reviewer_id ?? null) as string | null;
    if (reviewer !== null && reviewer !== actor) {
      throw new Error('reviewer does not match the session member');
    }
  }
  if (!operations.length) return { applied: [] };

  const applied: Applied[] = [];
  await client.query('SAVEPOINT reviewed_gifts');
  try {
    for (const operation of operations) {
      applied.push(await applyOne(client, operation as unknown as Operation, actor as string));
    }
    await client.query('RELEASE SAVEPOINT reviewed_gifts');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT reviewed_gifts');
    await client.query('RELEASE SAVEPOINT reviewed_gifts');
    throw error;
  }
  return { applied };
}
