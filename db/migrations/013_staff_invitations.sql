BEGIN;
CREATE TABLE staff_invitations(
  id uuid NOT NULL,org_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL CHECK(email=lower(btrim(email)) AND length(email)<=320),
  role text NOT NULL DEFAULT 'board' CHECK(role IN('admin','board')),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','sent','failed','revoked','claimed')),
  clerk_id text,requested_by uuid NOT NULL,claimed_by text,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,id),FOREIGN KEY(org_id,requested_by) REFERENCES memberships(org_id,id),
  CHECK(state<>'sent' OR clerk_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_pending_staff_email ON staff_invitations(org_id,email) WHERE state IN('queued','sent');
ALTER TABLE staff_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_admin ON staff_invitations TO cic_runtime
  USING(org_id=public.cic_org_id() AND public.cic_is_admin())
  WITH CHECK(org_id=public.cic_org_id() AND public.cic_is_admin());
CREATE POLICY invitation_claim ON staff_invitations TO cic_assignment
  USING(org_id=public.cic_org_id()) WITH CHECK(org_id=public.cic_org_id());
GRANT SELECT,INSERT,UPDATE ON staff_invitations TO cic_runtime;
GRANT SELECT,UPDATE ON staff_invitations TO cic_assignment;

-- The API supplies only the primary email verified by this Clerk instance, never a body field.
CREATE FUNCTION public.claim_staff_invitation(p_verified_email text) RETURNS boolean
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
    AND i.email=lower(btrim(p_verified_email)) AND i.state='sent' AND i.expires_at>now() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.memberships(org_id,clerk_subject,role,active) VALUES(v_org,v_subject,v_invite.role,true) RETURNING id INTO v_member;
  UPDATE public.staff_invitations i SET state='claimed',claimed_by=v_subject WHERE i.org_id=v_org AND i.id=v_invite.id;
  INSERT INTO public.audit_events(org_id,actor_id,action,target_id,status) VALUES(v_org,v_member,'membership.invite_claim',v_invite.id,'success');
  RETURN true;
END $$;
GRANT cic_assignment TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO cic_assignment;
ALTER FUNCTION public.claim_staff_invitation(text) OWNER TO cic_assignment;
REVOKE CREATE ON SCHEMA public FROM cic_assignment;
REVOKE cic_assignment FROM CURRENT_USER;
REVOKE ALL ON FUNCTION public.claim_staff_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_staff_invitation(text) TO cic_runtime;
COMMIT;
