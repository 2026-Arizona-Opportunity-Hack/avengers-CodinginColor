import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DonorSchema, DonorWriteSchema, GiftSchema, GiftWriteSchema, IdSchema } from '../packages/contracts/index.ts';
import { planDonorMatches, planGiftChanges } from './import-reconcile.ts';

type Kind = 'donor' | 'gift';
type Row = { row: number; action: string; reason: string; existingIds: string[]; matchingRows: number[] };
export type ReviewPlan = { status: 'needs_review'; org_id: string; batch_id: string; file_sha256: string; plan_hash: string;
  donors: { drafts: unknown[]; rows: Row[]; reviewed: unknown[] }; gifts: { drafts: unknown[]; rows: Row[]; reviewed: unknown[] } };
export type Operation = { kind: Kind; row: number; op: 'create' | 'link' | 'insert' | 'correct';
  reviewer_id: string | null; draft?: unknown; donor_id?: string; gift_id?: string };

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const PriorImportSchema = z.strictObject({ org_id: IdSchema, batch_id: IdSchema, file_sha256: Sha256Schema,
  status: z.enum(['reviewing', 'committed', 'abandoned']) });
const PlanInputSchema = z.strictObject({ org_id: IdSchema, batch_id: IdSchema, file_sha256: Sha256Schema,
  donors: z.array(z.unknown()), gifts: z.array(z.unknown()),
  existing_donors: z.array(z.unknown()), existing_gifts: z.array(z.unknown()) });
const DecisionSchema = z.strictObject({ plan_hash: Sha256Schema, kind: z.enum(['donor', 'gift']), row: z.int().nonnegative(),
  action: z.enum(['new', 'link', 'insert', 'correct', 'skip']), reviewer_id: IdSchema,
  donor_id: IdSchema.optional(), gift_id: IdSchema.optional() });

const sha256 = (data: Uint8Array | string) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
// Key order must not change the hash, so objects are serialized with sorted keys.
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : 1).map(([k, item]) => [k, stable(item)]))
  : value;
const hashPlan = (plan: Omit<ReviewPlan, 'status' | 'plan_hash'>) => sha256(JSON.stringify(stable(
  [plan.org_id, plan.batch_id, plan.file_sha256, plan.donors, plan.gifts])));

export function fingerprintFile(bytes: Uint8Array) {
  return sha256(bytes);
}

export function checkFileReplay(orgId: string, fingerprint: string, prior: unknown[]):
  { action: 'new' } | { action: 'resume' | 'replay'; batch_id: string } {
  IdSchema.parse(orgId);
  Sha256Schema.parse(fingerprint);
  const imports = z.array(PriorImportSchema).parse(prior);
  if (imports.some(item => item.org_id !== orgId)) throw new Error('Prior imports must be scoped to the selected organization');
  const same = imports.filter(item => item.file_sha256 === fingerprint);
  const committed = same.find(item => item.status === 'committed');
  if (committed) return { action: 'replay', batch_id: committed.batch_id };
  const open = same.filter(item => item.status === 'reviewing');
  if (open.length > 1) throw new Error('A file has more than one open review');
  return open.length ? { action: 'resume', batch_id: open[0].batch_id } : { action: 'new' };
}

// Only stored records a row references were reviewed, so unrelated records must not change the hash.
const referenced = <T extends { id: string }>(records: T[], rows: Row[]) => {
  const ids = new Set(rows.flatMap(row => row.existingIds));
  return records.filter(record => ids.has(record.id)).sort((a, b) => a.id < b.id ? -1 : 1);
};

export function createReviewPlan(input: Record<string, unknown>): ReviewPlan {
  const value = PlanInputSchema.parse(input);
  for (const gift of value.gifts) {
    const batch = (gift as { source_row?: { batch_id?: unknown } } | null)?.source_row?.batch_id;
    if (batch !== undefined && batch !== value.batch_id) throw new Error('Gift provenance must belong to the reviewed batch');
  }
  const donorRows = planDonorMatches(value.org_id, value.donors, value.existing_donors).rows;
  const giftRows = planGiftChanges(value.org_id, value.gifts, value.existing_gifts).rows;
  const body = { org_id: value.org_id, batch_id: value.batch_id, file_sha256: value.file_sha256,
    donors: { drafts: value.donors, rows: donorRows,
      reviewed: referenced(z.array(DonorSchema).parse(value.existing_donors), donorRows) },
    gifts: { drafts: value.gifts, rows: giftRows,
      reviewed: referenced(z.array(GiftSchema).parse(value.existing_gifts), giftRows) } };
  return { status: 'needs_review', ...body, plan_hash: hashPlan(body) };
}

// Identity reasons mean the incoming row shares a transaction identity with existingIds.
const identityConflict = new Set(['changed_transaction', 'conflicting_batch_transaction']);

export function resolveReview(plan: ReviewPlan, decisions: unknown[]):
  { status: 'needs_review'; pending: { kind: Kind; row: number }[] } |
  { status: 'ready'; org_id: string; batch_id: string; file_sha256: string; plan_hash: string; operations: Operation[] } {
  if (hashPlan(plan) !== plan.plan_hash) throw new Error('Review plan was modified after it was created');
  const chosen = new Map<string, z.infer<typeof DecisionSchema>>();
  for (const decision of z.array(DecisionSchema).parse(decisions)) {
    const key = `${decision.kind}:${decision.row}`;
    if (decision.plan_hash !== plan.plan_hash) throw new Error('Decision belongs to a different review plan');
    if (decision.row >= plan[`${decision.kind}s`].rows.length || chosen.has(key)) throw new Error('Invalid decision row');
    chosen.set(key, decision);
  }
  const pending: { kind: Kind; row: number }[] = [], operations: Operation[] = [];
  for (const kind of ['donor', 'gift'] as const) {
    const { drafts, rows } = plan[`${kind}s`];
    const schema = kind === 'donor' ? DonorWriteSchema : GiftWriteSchema;
    for (const row of rows) {
      const decision = chosen.get(`${kind}:${row.row}`);
      const by = decision?.reviewer_id ?? null;
      const draft = () => schema.parse(drafts[row.row]);
      if (decision?.action === 'skip') continue;
      if (row.action !== 'review') {
        if (decision) throw new Error('Automatic rows accept only a skip decision');
        if (row.action === 'new') operations.push({ kind, row: row.row, op: 'create', draft: draft(), reviewer_id: null });
        if (row.action === 'link') operations.push({ kind, row: row.row, op: 'link', donor_id: row.existingIds[0], reviewer_id: null });
        if (row.action === 'insert') operations.push({ kind, row: row.row, op: 'insert', draft: draft(), reviewer_id: null });
        continue;
      }
      if (!decision) { pending.push({ kind, row: row.row }); continue; }
      if (row.reason === 'invalid_donor' || row.reason === 'invalid_gift') throw new Error('Invalid drafts can only be skipped');
      // Any write would duplicate one identity or rewrite a stored one, so only skip is allowed.
      if (row.reason === 'conflicting_identity') throw new Error('Decision is not allowed for conflicting identities');
      const conflict = identityConflict.has(row.reason) && row.existingIds.length > 0;
      if (kind === 'donor' && decision.action === 'new') {
        operations.push({ kind, row: row.row, op: 'create', draft: draft(), reviewer_id: by });
      } else if (kind === 'donor' && decision.action === 'link' && row.existingIds.includes(decision.donor_id ?? '')) {
        operations.push({ kind, row: row.row, op: 'link', donor_id: decision.donor_id, reviewer_id: by });
      } else if (kind === 'gift' && decision.action === 'insert' && !conflict) {
        operations.push({ kind, row: row.row, op: 'insert', draft: draft(), reviewer_id: by });
      } else if (kind === 'gift' && decision.action === 'correct' && conflict && row.existingIds.includes(decision.gift_id ?? '')) {
        operations.push({ kind, row: row.row, op: 'correct', gift_id: decision.gift_id, draft: draft(), reviewer_id: by });
      } else {
        throw new Error('Decision is not allowed for this row');
      }
    }
  }
  // One incoming transaction identity may produce at most one write.
  const written = new Set(operations.filter(op => op.kind === 'gift').map(op => op.row));
  const corrected = operations.flatMap(op => op.gift_id ? [op.gift_id] : []);
  if (plan.gifts.rows.some(row => row.reason === 'conflicting_batch_transaction' && written.has(row.row) &&
      row.matchingRows.some(peer => written.has(peer))) || new Set(corrected).size !== corrected.length) {
    throw new Error('Conflicting rows for one transaction cannot all be written');
  }
  if (pending.length) return { status: 'needs_review', pending };
  return { status: 'ready', org_id: plan.org_id, batch_id: plan.batch_id, file_sha256: plan.file_sha256,
    plan_hash: plan.plan_hash, operations };
}
