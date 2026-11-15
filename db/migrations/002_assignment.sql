BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles r WHERE r.rolname = 'cic_assignment' AND (
    r.rolsuper OR r.rolbypassrls OR r.rolcanlogin OR r.rolcreatedb OR
    r.rolcreaterole OR r.rolinherit OR r.rolreplication OR
    EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid)
  )) THEN
    RAISE EXCEPTION 'Unsafe existing cic_assignment role';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cic_assignment') THEN
    CREATE ROLE cic_assignment NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO cic_assignment;
GRANT SELECT ON memberships, donors TO cic_assignment;
GRANT INSERT ON donors, audit_events TO cic_assignment;
REVOKE INSERT ON public.donors FROM cic_runtime;
GRANT SELECT, INSERT, UPDATE ON assignment_cursors TO cic_assignment;
CREATE POLICY assignment_members ON memberships FOR SELECT TO cic_assignment
  USING (org_id = cic_org_id());
CREATE POLICY assignment_donors_read ON donors FOR SELECT TO cic_assignment
  USING (org_id = cic_org_id());
CREATE POLICY assignment_donors_insert ON donors FOR INSERT TO cic_assignment
  WITH CHECK (org_id = cic_org_id());
CREATE POLICY assignment_cursor ON assignment_cursors FOR ALL TO cic_assignment
  USING (org_id = cic_org_id()) WITH CHECK (org_id = cic_org_id());
CREATE POLICY assignment_audit ON audit_events FOR INSERT TO cic_assignment
  WITH CHECK (org_id = cic_org_id() AND actor_id = cic_member_id());

CREATE FUNCTION public.create_assigned_donor(
  p_name text, p_email text, p_phone text, p_consent text, p_metadata jsonb
) RETURNS TABLE (id uuid, owner_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_org uuid := public.cic_org_id();
  v_actor uuid := public.cic_member_id();
  v_last uuid;
  v_owner uuid;
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Active organization membership required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.assignment_cursors(org_id) VALUES (v_org) ON CONFLICT DO NOTHING;
  SELECT c.last_owner_id INTO v_last FROM public.assignment_cursors c
    WHERE c.org_id = v_org FOR UPDATE;
  SELECT m.id INTO v_owner FROM public.memberships m
    WHERE m.org_id = v_org AND m.active AND m.role = 'board'
    ORDER BY (SELECT count(*) FROM public.donors d
      WHERE d.org_id = v_org AND d.owner_id = m.id AND d.archived_at IS NULL),
      (m.id > v_last) DESC NULLS LAST, m.id
    LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'No eligible board owner';
  END IF;
  INSERT INTO public.donors AS d(org_id, owner_id, name, email, phone, consent, metadata)
    VALUES (v_org, v_owner, btrim(p_name), p_email, p_phone, p_consent, p_metadata)
    RETURNING d.id INTO v_id;
  UPDATE public.assignment_cursors SET last_owner_id = v_owner WHERE org_id = v_org;
  INSERT INTO public.audit_events(org_id, actor_id, action, target_id, status)
    VALUES (v_org, v_actor, 'donor.create', v_id, 'success');
  RETURN QUERY SELECT v_id, v_owner;
END $$;

-- The function owner has only scoped grants, never table ownership or BYPASSRLS.
GRANT cic_assignment TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO cic_assignment;
ALTER FUNCTION public.create_assigned_donor(text, text, text, text, jsonb) OWNER TO cic_assignment;
REVOKE CREATE ON SCHEMA public FROM cic_assignment;
REVOKE cic_assignment FROM CURRENT_USER;
REVOKE ALL ON FUNCTION public.create_assigned_donor(text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_assigned_donor(text, text, text, text, jsonb) TO cic_runtime;

COMMIT;
