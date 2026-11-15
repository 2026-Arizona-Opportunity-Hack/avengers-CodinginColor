BEGIN;
-- Cast UUID aliases to the same identity; retain exact, case-sensitive row keys.
-- Existing aliases fail this transaction, restoring the old index and all history.
DROP INDEX public.gift_row_identity;
CREATE UNIQUE INDEX gift_row_identity ON public.gifts
  (org_id,((source_row->>'batch_id')::uuid),(source_row->>'row_key'))
  WHERE source_row IS NOT NULL;
COMMIT;
