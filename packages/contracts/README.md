# Shared donor and gift contracts

Requires Node.js 24+. From the repository root, run `npm ci`,
`npm run typecheck`, and `npm run test:contracts`.

Import schemas and inferred types from `packages/contracts/index.ts`.
Use `DonorWriteSchema.safeParse(input)` or `GiftWriteSchema.safeParse(input)`
at API/import trust boundaries; validation does not authorize persistence.
Record schemas include server-owned identity and organization fields. Write
schemas reject those fields and owner/role injection.

Donors require name, consent (`unknown`, `granted`, `denied`), and a JSON metadata
object. Email and phone may be absent or null. Record ownership may be null;
assignment policy belongs to the backend service.

Gifts require donor ID, nullable campaign ID, integer amount/refund cents,
uppercase currency, a timestamp with timezone, status (`settled`, `pending`,
`void`), and source. Refunds cannot exceed the donation. External transaction ID
and source-row provenance are optional. Provenance, when supplied, requires an
authenticated import batch UUID and nonempty row key; the service must verify
that the caller can access that batch.

Do not invent missing financial facts to pass validation. Keep incomplete rows
in import review. Identity matching, source transaction uniqueness, reviewed
corrections, authorization, and atomic persistence remain service/database work.
Gifts are separate from communications and future follow-ups.

No API or database implementation is included in this contract slice.
