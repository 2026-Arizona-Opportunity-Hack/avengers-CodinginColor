BEGIN;
-- Staff may ground drafts in approved aggregates for programs their authorized donors fund.
CREATE POLICY outcomes_funded_program_read ON program_outcomes FOR SELECT TO cic_runtime
  USING (org_id = cic_org_id() AND cic_member_id() IS NOT NULL AND EXISTS (
    SELECT FROM gifts g JOIN campaigns c ON c.org_id = g.org_id AND c.id = g.campaign_id
    WHERE g.org_id = program_outcomes.org_id AND c.program_id = program_outcomes.program_id
      AND g.status = 'settled' AND g.amount_cents > g.refund_cents
  ));
COMMIT;
