// Review stage fingerprints files, binds plans to reviewed facts, and turns human decisions into operations.
// Hashes detect stale or changed plans, not forgery; callers must rebuild, authorize, and apply atomically.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DonorSchema, DonorWriteSchema, GiftSchema, GiftWriteSchema, IdSchema } from '../packages/contracts/index.ts';
import { planDonorMatches, planGiftChanges } from './import-reconcile.ts';

type Kind = 'donor' | 'gift';
type Row = { row: number; action: string; reason: string; existingIds: string[]; matchingRows: number[] };
type DonorResolution = { plan_hash: string; operations: Operation[] };
export type ReviewPlan = { status: 'needs_review'; org_id: string; batch_id: string; file_sha256: string; plan_hash: string;
  donors: { drafts: unknown[]; rows: Row[]; reviewed: unknown[] }; gifts: { drafts: unknown[]; rows: Row[]; reviewed: unknown[] };
  donor_resolution?: DonorResolution };
export type Operation = { kind: Kind; row: number; op: 'create' | 'link' | 'insert' | 'correct';
  reviewer_id: string | null; draft?: unknown; donor_id?: string; gift_id?: string; donor_row?: number };

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const PriorImportSchema = z.strictObject({ org_id: IdSchema, batch_id: IdSchema, file_sha256: Sha256Schema,
  status: z.enum(['reviewing', 'committed', 'abandoned']) });
const PlanInputSchema = z.strictObject({ org_id: IdSchema, batch_id: IdSchema, file_sha256: Sha256Schema,
  donors: z.array(z.unknown()), gifts: z.array(z.unknown()),
  existing_donors: z.array(z.unknown()), existing_gifts: z.array(z.unknown()),
  donor_resolution: z.unknown().optional() });
const DonorOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({ kind: z.literal('donor'), row: z.int().nonnegative(), op: z.literal('create'),
    reviewer_id: IdSchema.nullable(), draft: DonorWriteSchema }),
  z.strictObject({ kind: z.literal('donor'), row: z.int().nonnegative(), op: z.literal('link'),
    reviewer_id: IdSchema.nullable(), donor_id: IdSchema })]);
const ResolutionSchema = z.strictObject({ status: z.literal('ready'), org_id: IdSchema, batch_id: IdSchema,
  file_sha256: Sha256Schema, plan_hash: Sha256Schema, operations: z.array(DonorOperationSchema) });
const DecisionSchema = z.strictObject({ plan_hash: Sha256Schema, kind: z.enum(['donor', 'gift']), row: z.int().nonnegative(),
  action: z.enum(['new', 'link', 'insert', 'correct', 'skip']), reviewer_id: IdSchema,
  donor_id: IdSchema.optional(), gift_id: IdSchema.optional() });

const sha256 = (data: Uint8Array | string) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
// Key order must not change the hash, so objects are serialized with sorted keys.
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : 1).map(([k, item]) => [k, stable(item)]))
  : value;
// The plan hash covers the org, batch, file fingerprint and planned donor/gift rows, so decisions
// made against an older plan are rejected. It detects staleness, not forgery: anyone can recompute it.
const hashPlan = (plan: Omit<ReviewPlan, 'status' | 'plan_hash'>) => sha256(JSON.stringify(stable(
  [plan.org_id, plan.batch_id, plan.file_sha256, plan.donors, plan.gifts,
    ...(plan.donor_resolution === undefined ? [] : [plan.donor_resolution])])));

// A created donor has no stored id yet, so a namespaced placeholder keeps its gifts off stored gifts.
const placeholderDonor = (row: number) => {
  const hex = createHash('sha256').update(`donor_row:${row}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
// A donor_row gift resolves through the phase-one donor operation before matching.
const resolveDonor = (resolution: DonorResolution | undefined, draft: unknown):
  { gift: Record<string, unknown>; donorRow?: number; unresolved?: boolean } => {
  if (!resolution) return { gift: draft as Record<string, unknown> };
  const { donor_row: donorRow, ...gift } = draft as Record<string, unknown> & { donor_row?: number };
  if (donorRow === undefined) return { gift };
  const op = resolution?.operations.find(item => item.row === donorRow);
  if (op?.op === 'link') return { gift: { ...gift, donor_id: op.donor_id } };
  if (op?.op === 'create') return { gift: { ...gift, donor_id: placeholderDonor(donorRow) }, donorRow };
  return { gift, unresolved: true };
};
const donorResolution = (raw: unknown, input: z.infer<typeof PlanInputSchema>): DonorResolution | undefined => {
  if (raw === undefined) return undefined;
  const parsed = ResolutionSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Donor resolution must be a ready review result');
  if (new Set(parsed.data.operations.map(op => op.row)).size !== parsed.data.operations.length)
    throw new Error('Donor resolution has duplicate donor operations');
  if (parsed.data.org_id !== input.org_id || parsed.data.batch_id !== input.batch_id ||
      parsed.data.file_sha256 !== input.file_sha256) throw new Error('Donor resolution belongs to a different import');
  return { plan_hash: parsed.data.plan_hash, operations: parsed.data.operations };
};

/** Fingerprint exact uploaded bytes for replay checks and plan binding. */
export function fingerprintFile(bytes: Uint8Array) {
  return sha256(bytes);
}

/** Classify an exact file as new, resumable, or already committed within one organization. */
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

/** Build a hashed review plan from drafts and a snapshot; this function does not persist it. */
export function createReviewPlan(input: Record<string, unknown>): ReviewPlan {
  const value = PlanInputSchema.parse(input);
  const resolution = donorResolution(value.donor_resolution, value);
  if (resolution && value.donors.length) throw new Error('A donor resolution plans gifts only; pass no donors');
  for (const gift of value.gifts) {
    const draft = gift as { donor_row?: unknown; donor_id?: unknown; source_row?: { batch_id?: unknown } } | null;
    if (resolution ? draft?.donor_id !== undefined || !z.int().nonnegative().safeParse(draft?.donor_row).success
      : draft?.donor_row !== undefined) throw new Error('Gift drafts need exactly one donor reference');
    const batch = draft?.source_row?.batch_id;
    if (batch !== undefined && batch !== value.batch_id) throw new Error('Gift provenance must belong to the reviewed batch');
  }
  const resolved = resolution ? value.gifts.map(gift => resolveDonor(resolution, gift)) : [];
  const donorRows = planDonorMatches(value.org_id, value.donors, value.existing_donors).rows;
  const giftRows = planGiftChanges(value.org_id, resolution ? resolved.map(item => item.gift) : value.gifts,
    value.existing_gifts).rows.map((row, index) => resolved[index]?.unresolved
      ? { row: index, action: 'review', reason: 'donor_unresolved', existingIds: [], matchingRows: [] } : row);
  const body = { org_id: value.org_id, batch_id: value.batch_id, file_sha256: value.file_sha256,
    donors: { drafts: value.donors, rows: donorRows,
      reviewed: referenced(z.array(DonorSchema).parse(value.existing_donors), donorRows) },
    gifts: { drafts: value.gifts, rows: giftRows,
      reviewed: referenced(z.array(GiftSchema).parse(value.existing_gifts), giftRows) },
    ...(resolution ? { donor_resolution: resolution } : {}) };
  return { status: 'needs_review', ...body, plan_hash: hashPlan(body) };
}

// Identity reasons mean the incoming row shares a transaction identity with existingIds.
const identityConflict = new Set(['changed_transaction', 'conflicting_batch_transaction']);

/** Validate plan-bound decisions and return pending review rows or ready write operations. */
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
    for (const row of rows) {
      const decision = chosen.get(`${kind}:${row.row}`);
      const by = decision?.reviewer_id ?? null;
      const { gift, donorRow } = kind === 'gift' ? resolveDonor(plan.donor_resolution, drafts[row.row])
        : { gift: drafts[row.row] as Record<string, unknown>, donorRow: undefined };
      const draft = () => (kind === 'donor' ? DonorWriteSchema : GiftWriteSchema).parse(gift);
      const giftOp = (op: 'insert' | 'correct', reviewerId: string | null, giftId?: string): Operation => {
        const parsed = GiftWriteSchema.parse(gift), { donor_id: _placeholder, ...facts } = parsed;
        return { kind: 'gift', row: row.row, op, ...(giftId ? { gift_id: giftId } : {}),
          ...(donorRow === undefined ? {} : { donor_row: donorRow }), draft: donorRow === undefined ? parsed : facts,
          reviewer_id: reviewerId };
      };
      if (decision?.action === 'skip') continue;
      if (row.action !== 'review') {
        if (decision) throw new Error('Automatic rows accept only a skip decision');
        if (row.action === 'new') operations.push({ kind, row: row.row, op: 'create', draft: draft(), reviewer_id: null });
        if (row.action === 'link') operations.push({ kind, row: row.row, op: 'link', donor_id: row.existingIds[0], reviewer_id: null });
        if (row.action === 'insert') operations.push(giftOp('insert', null));
        continue;
      }
      if (!decision) { pending.push({ kind, row: row.row }); continue; }
      if (row.reason === 'donor_unresolved') throw new Error('Only a skip decision is allowed for an unresolved donor row');
      if (row.reason === 'invalid_donor' || row.reason === 'invalid_gift') throw new Error('Invalid drafts can only be skipped');
      // Any write would duplicate one identity or rewrite a stored one, so only skip is allowed.
      if (row.reason === 'conflicting_identity') throw new Error('Decision is not allowed for conflicting identities');
      const conflict = identityConflict.has(row.reason) && row.existingIds.length > 0;
      if (kind === 'donor' && decision.action === 'new') {
        operations.push({ kind, row: row.row, op: 'create', draft: draft(), reviewer_id: by });
      } else if (kind === 'donor' && decision.action === 'link' && row.existingIds.includes(decision.donor_id ?? '')) {
        operations.push({ kind, row: row.row, op: 'link', donor_id: decision.donor_id, reviewer_id: by });
      } else if (kind === 'gift' && decision.action === 'insert' && !conflict) {
        operations.push(giftOp('insert', by));
      } else if (kind === 'gift' && decision.action === 'correct' && conflict && row.existingIds.includes(decision.gift_id ?? '')) {
        operations.push(giftOp('correct', by, decision.gift_id));
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
