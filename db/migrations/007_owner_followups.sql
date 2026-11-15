BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cic_assignment') OR EXISTS (
    SELECT FROM pg_roles r WHERE r.rolname = 'cic_assignment' AND (
      r.rolsuper OR r.rolbypassrls OR r.rolcanlogin OR r.rolcreatedb OR
      r.rolcreaterole OR r.rolinherit OR r.rolreplication OR
      EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid) OR
      EXISTS (SELECT FROM pg_auth_members m WHERE m.roleid = r.oid AND NOT (
        m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option))
    )
  ) THEN
    RAISE EXCEPTION 'Unsafe existing cic_assignment role';
  END IF;
END $$;

GRANT SELECT (org_id,donor_id,status,owner_id), UPDATE(owner_id) ON public.follow_ups TO cic_assignment;
CREATE POLICY assignment_followups_read ON public.follow_ups FOR SELECT TO cic_assignment
  USING (org_id=public.cic_org_id());
CREATE POLICY assignment_followups_update ON public.follow_ups FOR UPDATE TO cic_assignment
  USING (org_id=public.cic_org_id()) WITH CHECK (org_id=public.cic_org_id());
-- Temporary role membership permits replacing its function; runtime never gains this role.
GRANT cic_assignment TO CURRENT_USER;
CREATE OR REPLACE FUNCTION public.reassign_donor(p_donor uuid, p_owner uuid)
RETURNS TABLE (id uuid, owner_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_org uuid := public.cic_org_id();
  v_actor uuid := public.cic_member_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT FROM public.memberships m
      WHERE m.id = v_actor AND m.org_id = v_org AND m.active AND m.role = 'admin') THEN
    RAISE EXCEPTION 'Active admin membership required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.assignment_cursors(org_id) VALUES (v_org) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.assignment_cursors c WHERE c.org_id = v_org FOR UPDATE;
  IF NOT EXISTS (SELECT FROM public.donors d WHERE d.org_id = v_org AND d.id = p_donor) THEN
    RAISE EXCEPTION 'Donor not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT FROM public.memberships m WHERE m.org_id = v_org
      AND m.id = p_owner AND m.active AND m.role = 'board') THEN
    RAISE EXCEPTION 'Owner is not an active board member' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.donors d SET owner_id = p_owner, updated_at = now()
    WHERE d.org_id = v_org AND d.id = p_donor;
  UPDATE public.follow_ups f SET owner_id = p_owner
    WHERE f.org_id = v_org AND f.donor_id = p_donor AND f.status = 'open';
  INSERT INTO public.audit_events(org_id, actor_id, action, target_id, status)
    VALUES (v_org, v_actor, 'donor.reassign', p_donor, 'success');
  RETURN QUERY SELECT p_donor, p_owner;
END $$;

REVOKE cic_assignment FROM CURRENT_USER;
COMMIT;
