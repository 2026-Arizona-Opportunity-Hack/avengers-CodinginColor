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

GRANT UPDATE (owner_id, updated_at) ON public.donors TO cic_assignment;
CREATE POLICY assignment_donors_update ON public.donors FOR UPDATE TO cic_assignment
  USING (org_id = public.cic_org_id()) WITH CHECK (org_id = public.cic_org_id());

CREATE FUNCTION public.reassign_donor(p_donor uuid, p_owner uuid)
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
  INSERT INTO public.audit_events(org_id, actor_id, action, target_id, status)
    VALUES (v_org, v_actor, 'donor.reassign', p_donor, 'success');
  RETURN QUERY SELECT p_donor, p_owner;
END $$;

GRANT cic_assignment TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO cic_assignment;
ALTER FUNCTION public.reassign_donor(uuid, uuid) OWNER TO cic_assignment;
REVOKE CREATE ON SCHEMA public FROM cic_assignment;
REVOKE cic_assignment FROM CURRENT_USER;
REVOKE ALL ON FUNCTION public.reassign_donor(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reassign_donor(uuid, uuid) TO cic_runtime;

COMMIT;
