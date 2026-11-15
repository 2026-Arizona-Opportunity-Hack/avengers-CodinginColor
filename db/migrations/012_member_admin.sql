BEGIN;
GRANT INSERT, UPDATE(role,active) ON memberships TO cic_assignment;
CREATE POLICY membership_admin_insert ON memberships FOR INSERT TO cic_assignment
  WITH CHECK (org_id=public.cic_org_id());
CREATE POLICY membership_admin_update ON memberships FOR UPDATE TO cic_assignment
  USING (org_id=public.cic_org_id()) WITH CHECK (org_id=public.cic_org_id());

CREATE FUNCTION public.admin_members()
RETURNS TABLE(id uuid,clerk_subject text,role text,active boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT public.cic_is_admin() THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT m.id,m.clerk_subject,m.role,m.active FROM public.memberships m
    WHERE m.org_id=public.cic_org_id() ORDER BY m.created_at,m.id;
END $$;

CREATE FUNCTION public.manage_member(p_id uuid,p_subject text,p_role text,p_active boolean)
RETURNS TABLE(id uuid,clerk_subject text,role text,active boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_org uuid:=public.cic_org_id(); v_actor uuid:=public.cic_member_id();
  v_target public.memberships%ROWTYPE; v_action text;
BEGIN
  IF NOT public.cic_is_admin() THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501'; END IF;
  IF p_role NOT IN ('admin','board') OR p_active IS NULL THEN RAISE EXCEPTION 'Invalid membership' USING ERRCODE='22023'; END IF;
  -- Share assignment's lock, so an owner cannot become ineligible during assignment.
  INSERT INTO public.assignment_cursors(org_id) VALUES(v_org) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.assignment_cursors c WHERE c.org_id=v_org FOR UPDATE;
  IF NOT public.cic_is_admin() THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501'; END IF;
  IF p_id IS NULL THEN
    IF p_subject IS NULL OR length(btrim(p_subject))=0 THEN RAISE EXCEPTION 'Subject required' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT FROM public.memberships m WHERE m.org_id=v_org AND m.clerk_subject=p_subject) THEN
      RAISE EXCEPTION 'Member exists' USING ERRCODE='P0001';
    END IF;
    INSERT INTO public.memberships(org_id,clerk_subject,role,active) VALUES(v_org,p_subject,p_role,p_active) RETURNING * INTO v_target;
    v_action:='membership.create';
  ELSE
    SELECT * INTO v_target FROM public.memberships m WHERE m.org_id=v_org AND m.id=p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown member' USING ERRCODE='P0002'; END IF;
    IF p_subject IS NOT NULL THEN RAISE EXCEPTION 'Immutable subject' USING ERRCODE='22023'; END IF;
    IF v_target.id=v_actor AND (NOT p_active OR p_role<>'admin') THEN
      RAISE EXCEPTION 'Another admin must change your access' USING ERRCODE='P0001';
    END IF;
    IF v_target.active AND v_target.role='admin' AND (NOT p_active OR p_role<>'admin') AND
      (SELECT count(*) FROM public.memberships m WHERE m.org_id=v_org AND m.active AND m.role='admin')<=1 THEN
      RAISE EXCEPTION 'Last admin required' USING ERRCODE='P0001';
    END IF;
    IF (NOT p_active OR p_role<>'board') AND EXISTS(SELECT FROM public.donors d
      WHERE d.org_id=v_org AND d.owner_id=p_id AND d.archived_at IS NULL) THEN
      RAISE EXCEPTION 'Reassign active donors first' USING ERRCODE='P0001';
    END IF;
    UPDATE public.memberships m SET role=p_role,active=p_active WHERE m.org_id=v_org AND m.id=p_id RETURNING * INTO v_target;
    v_action:='membership.update';
  END IF;
  INSERT INTO public.audit_events(org_id,actor_id,action,target_id,status) VALUES(v_org,v_actor,v_action,v_target.id,'success');
  RETURN QUERY SELECT v_target.id,v_target.clerk_subject,v_target.role,v_target.active;
END $$;

GRANT cic_assignment TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO cic_assignment;
ALTER FUNCTION public.admin_members() OWNER TO cic_assignment;
ALTER FUNCTION public.manage_member(uuid,text,text,boolean) OWNER TO cic_assignment;
REVOKE CREATE ON SCHEMA public FROM cic_assignment;
REVOKE cic_assignment FROM CURRENT_USER;
REVOKE ALL ON FUNCTION public.admin_members(),public.manage_member(uuid,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_members(),public.manage_member(uuid,text,text,boolean) TO cic_runtime;
COMMIT;
