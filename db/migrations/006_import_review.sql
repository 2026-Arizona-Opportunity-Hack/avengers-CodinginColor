BEGIN;
CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('spreadsheet','zeffy','benevity','az_gives','united_way')),
  filename text NOT NULL CHECK (filename ~ '^[ -~]{1,255}$' AND filename !~ '[/\\]' AND filename NOT IN ('.','..')),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  raw_csv bytea,
  status text NOT NULL DEFAULT 'reviewing' CHECK (status IN ('reviewing','committed','abandoned')),
  layout jsonb DEFAULT '{}' CHECK (layout IS NULL OR jsonb_typeof(layout)='object'),
  donor_decisions jsonb DEFAULT '[]' CHECK (donor_decisions IS NULL OR jsonb_typeof(donor_decisions)='array'),
  gift_decisions jsonb DEFAULT '[]' CHECK (gift_decisions IS NULL OR jsonb_typeof(gift_decisions)='array'),
  donor_plan_hash text CHECK (donor_plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  gift_plan_hash text CHECK (gift_plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  reviewer_id uuid,
  committed_by uuid,
  committed_at timestamptz,
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  UNIQUE(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,id),
  FOREIGN KEY(org_id,reviewer_id) REFERENCES memberships(org_id,id),
  FOREIGN KEY(org_id,committed_by) REFERENCES memberships(org_id,id),
  CHECK ((status='reviewing' AND raw_csv IS NOT NULL AND octet_length(raw_csv) BETWEEN 1 AND 4194304)
    OR (status<>'reviewing' AND raw_csv IS NULL AND layout IS NULL AND donor_decisions IS NULL AND gift_decisions IS NULL)),
  CHECK ((status='committed' AND committed_by IS NOT NULL AND committed_at IS NOT NULL AND result IS NOT NULL)
    OR (status<>'committed' AND committed_by IS NULL AND committed_at IS NULL AND result IS NULL))
);
-- The same bytes cannot bypass replay protection by changing the source label or owner.
CREATE UNIQUE INDEX import_file_identity ON import_batches(org_id,file_sha256) WHERE status<>'abandoned';
CREATE UNIQUE INDEX gift_row_identity ON gifts(org_id,(source_row->>'batch_id'),(source_row->>'row_key'))
  WHERE source_row IS NOT NULL;

CREATE FUNCTION public.cic_import_terminal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.status<>'reviewing' THEN RAISE EXCEPTION 'Import is terminal'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_terminal BEFORE UPDATE ON import_batches FOR EACH ROW EXECUTE FUNCTION public.cic_import_terminal();
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY import_read ON import_batches FOR SELECT TO cic_runtime
  USING (org_id=cic_org_id() AND cic_is_admin());
CREATE POLICY import_create ON import_batches FOR INSERT TO cic_runtime
  WITH CHECK (org_id=cic_org_id() AND cic_is_admin() AND created_by=cic_member_id() AND status='reviewing');
CREATE POLICY import_update ON import_batches FOR UPDATE TO cic_runtime
  USING (org_id=cic_org_id() AND cic_is_admin())
  WITH CHECK (org_id=cic_org_id() AND cic_is_admin() AND (reviewer_id IS NULL OR reviewer_id=cic_member_id())
    AND (committed_by IS NULL OR committed_by=cic_member_id()));
GRANT SELECT ON import_batches TO cic_runtime;
GRANT INSERT(org_id,created_by,source,filename,file_sha256,raw_csv) ON import_batches TO cic_runtime;
GRANT UPDATE(raw_csv,status,layout,donor_decisions,gift_decisions,donor_plan_hash,gift_plan_hash,
  reviewer_id,committed_by,committed_at,result) ON import_batches TO cic_runtime;
COMMIT;
