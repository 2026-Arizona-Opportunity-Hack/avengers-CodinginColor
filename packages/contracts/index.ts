import { z } from 'zod';

export const IdSchema = z.uuid();
export const ConsentSchema = z.enum(['unknown', 'granted', 'denied']);
const text = z.string().trim().min(1);
const metadata = z.record(z.string(), z.json());

// Ownership and organization come from authorized services, never donor edits.
export const DonorWriteSchema = z.strictObject({
  name: text.max(300),
  email: z.email().nullable().optional(),
  phone: text.max(50).nullable().optional(),
  consent: ConsentSchema,
  metadata,
});

export const DonorSchema = DonorWriteSchema.extend({
  id: IdSchema,
  org_id: IdSchema,
  owner_id: IdSchema.nullable(),
  archived_at: z.iso.datetime({ offset: true }).nullable(),
});

export const SourceRowSchema = z.strictObject({
  batch_id: IdSchema,
  row_key: text,
});

const giftFields = {
  donor_id: IdSchema,
  campaign_id: IdSchema.nullable(),
  amount_cents: z.int().nonnegative(),
  refund_cents: z.int().nonnegative(),
  currency: z.string().refine(
    (code) => /^[A-Z]{3}$/.test(code) && Intl.supportedValuesOf('currency').includes(code),
    'Expected a supported uppercase ISO currency code',
  ),
  occurred_at: z.iso.datetime({ offset: true }),
  status: z.enum(['settled', 'pending', 'void']),
  source: text.max(100),
  external_id: text.max(300).nullable().optional(),
  source_row: SourceRowSchema.nullable().optional(),
};

const validRefund = (gift: { amount_cents: number; refund_cents: number }) =>
  gift.refund_cents <= gift.amount_cents;
const refundError = { message: 'Refund exceeds donation amount', path: ['refund_cents'] };

export const GiftWriteSchema = z.strictObject(giftFields).refine(validRefund, refundError);
export const GiftSchema = z.strictObject({
  ...giftFields,
  id: IdSchema,
  org_id: IdSchema,
}).refine(validRefund, refundError);

export type Donor = z.infer<typeof DonorSchema>;
export type DonorWrite = z.infer<typeof DonorWriteSchema>;
export type Gift = z.infer<typeof GiftSchema>;
export type GiftWrite = z.infer<typeof GiftWriteSchema>;
