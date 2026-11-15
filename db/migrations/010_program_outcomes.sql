BEGIN;

-- Aggregate program facts only; an administrator explicitly approves every upload.
CREATE TABLE program_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  period_from timestamptz NOT NULL,
  period_to timestamptz NOT NULL CHECK (period_to > period_from),
  metric text NOT NULL CHECK (length(btrim(metric)) BETWEEN 1 AND 120),
  value numeric CHECK (value >= 0 AND value <= 9007199254740991),
  unit text NOT NULL CHECK (length(btrim(unit)) BETWEEN 1 AND 60),
  denominator numeric CHECK (denominator > 0 AND denominator <= 9007199254740991),
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 500),
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, approved_by) REFERENCES memberships(org_id, id),
  UNIQUE (org_id, program_id, period_from, period_to, metric)
);
ALTER TABLE program_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE program_outcomes FORCE ROW LEVEL SECURITY;
CREATE POLICY outcomes_admin ON program_outcomes FOR ALL TO cic_runtime
  USING (org_id = cic_org_id() AND cic_is_admin())
  WITH CHECK (org_id = cic_org_id() AND cic_is_admin() AND approved_by = cic_member_id());
GRANT SELECT, INSERT ON program_outcomes TO cic_runtime;
GRANT UPDATE (value, unit, denominator, source, approved_by, approved_at) ON program_outcomes TO cic_runtime;

COMMIT;
