BEGIN;

-- Replace the published email-only claim path after live provider verification is enforced.
GRANT cic_assignment TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO cic_assignment;
DROP FUNCTION public.claim_staff_invitation(text);

CREATE FUNCTION public.pending_staff_invitation(p_verified_email text)
RETURNS TABLE(id uuid,clerk_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF nullif(current_setting('app.user_id',true),'') IS NULL OR EXISTS(SELECT FROM public.memberships m
    WHERE m.org_id=public.cic_org_id() AND m.clerk_subject=current_setting('app.user_id',true)) THEN RETURN; END IF;
  RETURN QUERY SELECT i.id,i.clerk_id FROM public.staff_invitations i WHERE i.org_id=public.cic_org_id()
    AND i.email=lower(btrim(p_verified_email)) AND i.state='sent' AND i.expires_at>now();
END $$;
CREATE FUNCTION public.claim_staff_invitation(p_verified_email text,p_id uuid,p_clerk_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_org uuid:=public.cic_org_id();v_subject text:=nullif(current_setting('app.user_id',true),'');
  v_invite public.staff_invitations%ROWTYPE;v_member uuid;
BEGIN
  IF v_subject IS NULL OR p_verified_email IS NULL THEN RETURN false; END IF;
  INSERT INTO public.assignment_cursors(org_id) VALUES(v_org) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.assignment_cursors c WHERE c.org_id=v_org FOR UPDATE;
  -- A new invitation cannot reactivate or elevate an existing membership.
  IF EXISTS(SELECT FROM public.memberships m WHERE m.org_id=v_org AND m.clerk_subject=v_subject) THEN RETURN false; END IF;
  SELECT * INTO v_invite FROM public.staff_invitations i WHERE i.org_id=v_org
    AND i.email=lower(btrim(p_verified_email)) AND i.id=p_id AND i.clerk_id=p_clerk_id
    AND i.state='sent' AND i.expires_at>now() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.memberships(org_id,clerk_subject,role,active) VALUES(v_org,v_subject,v_invite.role,true) RETURNING id INTO v_member;
  UPDATE public.staff_invitations i SET state='claimed',claimed_by=v_subject WHERE i.org_id=v_org AND i.id=v_invite.id;
  INSERT INTO public.audit_events(org_id,actor_id,action,target_id,status) VALUES(v_org,v_member,'membership.invite_claim',v_invite.id,'success');
  RETURN true;
END $$;
ALTER FUNCTION public.pending_staff_invitation(text) OWNER TO cic_assignment;
ALTER FUNCTION public.claim_staff_invitation(text,uuid,text) OWNER TO cic_assignment;
REVOKE CREATE ON SCHEMA public FROM cic_assignment;
REVOKE cic_assignment FROM CURRENT_USER;
REVOKE ALL ON FUNCTION public.pending_staff_invitation(text),public.claim_staff_invitation(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pending_staff_invitation(text),public.claim_staff_invitation(text,uuid,text) TO cic_runtime;
COMMIT;
