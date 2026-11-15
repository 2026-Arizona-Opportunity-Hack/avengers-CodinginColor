BEGIN;
DO $$BEGIN
  IF EXISTS(SELECT FROM pg_roles r WHERE r.rolname='cic_impact' AND(r.rolsuper OR r.rolbypassrls OR r.rolcanlogin
    OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid))) THEN
    RAISE EXCEPTION 'Unsafe existing impact role';
  END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='cic_impact')THEN
    CREATE ROLE cic_impact NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
END$$;
CREATE TABLE donor_feed_access(
  org_id uuid NOT NULL REFERENCES organizations(id),donor_id uuid NOT NULL,clerk_subject text NOT NULL,
  verified_email text NOT NULL,active boolean NOT NULL DEFAULT false,opted_in boolean NOT NULL DEFAULT false,
  granted_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,donor_id),UNIQUE(org_id,clerk_subject),
  FOREIGN KEY(org_id,donor_id) REFERENCES donors(org_id,id),FOREIGN KEY(org_id,granted_by) REFERENCES memberships(org_id,id)
);
ALTER TABLE program_outcomes ADD UNIQUE(org_id,id);
CREATE TABLE donor_outcome_publications(
  org_id uuid NOT NULL,outcome_id uuid NOT NULL,approved_at timestamptz NOT NULL,
  published_by uuid NOT NULL,published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,outcome_id),FOREIGN KEY(org_id,outcome_id) REFERENCES program_outcomes(org_id,id),
  FOREIGN KEY(org_id,published_by) REFERENCES memberships(org_id,id)
);
CREATE TABLE donor_feed_invitations(
  org_id uuid NOT NULL,id uuid NOT NULL,donor_id uuid NOT NULL,email text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','sent','failed','revoked')),
  clerk_id text,requested_by uuid NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,id),
  FOREIGN KEY(org_id,donor_id) REFERENCES donors(org_id,id),FOREIGN KEY(org_id,requested_by) REFERENCES memberships(org_id,id)
);
ALTER TABLE donor_feed_access ENABLE ROW LEVEL SECURITY;ALTER TABLE donor_feed_access FORCE ROW LEVEL SECURITY;
ALTER TABLE donor_outcome_publications ENABLE ROW LEVEL SECURITY;ALTER TABLE donor_outcome_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE donor_feed_invitations ENABLE ROW LEVEL SECURITY;ALTER TABLE donor_feed_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY feed_access_admin ON donor_feed_access TO cic_runtime USING(org_id=cic_org_id() AND cic_is_admin()) WITH CHECK(org_id=cic_org_id() AND cic_is_admin());
CREATE POLICY feed_publication_admin ON donor_outcome_publications TO cic_runtime USING(org_id=cic_org_id() AND cic_is_admin()) WITH CHECK(org_id=cic_org_id() AND cic_is_admin());
CREATE POLICY feed_invitation_admin ON donor_feed_invitations TO cic_runtime USING(org_id=cic_org_id() AND cic_is_admin()) WITH CHECK(org_id=cic_org_id() AND cic_is_admin());
GRANT SELECT,INSERT,UPDATE ON donor_feed_access,donor_outcome_publications,donor_feed_invitations TO cic_runtime;
GRANT DELETE ON donor_outcome_publications TO cic_runtime;
GRANT USAGE ON SCHEMA public TO cic_impact;
GRANT SELECT(org_id,donor_id,clerk_subject,verified_email,active,opted_in) ON donor_feed_access TO cic_impact;
GRANT SELECT(org_id,donor_id,campaign_id,amount_cents,refund_cents,currency,occurred_at,status) ON gifts TO cic_impact;
GRANT SELECT(org_id,id,title,program_id) ON campaigns TO cic_impact;
GRANT SELECT(org_id,id,title) ON programs TO cic_impact;
GRANT SELECT(org_id,id,program_id,metric,value,unit,denominator,period_from,period_to,approved_at) ON program_outcomes TO cic_impact;
GRANT SELECT(org_id,outcome_id,approved_at) ON donor_outcome_publications TO cic_impact;
CREATE POLICY feed_access_self ON donor_feed_access TO cic_impact USING(org_id=cic_org_id() AND active AND opted_in AND clerk_subject=nullif(current_setting('app.user_id',true),'') AND verified_email=lower(btrim(current_setting('app.verified_email',true))));
CREATE POLICY feed_gifts_self ON gifts FOR SELECT TO cic_impact USING(org_id=cic_org_id() AND EXISTS(SELECT FROM donor_feed_access a WHERE a.org_id=gifts.org_id AND a.donor_id=gifts.donor_id));
CREATE POLICY feed_campaigns ON campaigns FOR SELECT TO cic_impact USING(org_id=cic_org_id() AND EXISTS(SELECT FROM donor_feed_access));
CREATE POLICY feed_programs ON programs FOR SELECT TO cic_impact USING(org_id=cic_org_id() AND EXISTS(SELECT FROM donor_feed_access));
CREATE POLICY feed_publications ON donor_outcome_publications FOR SELECT TO cic_impact USING(org_id=cic_org_id() AND EXISTS(SELECT FROM donor_feed_access));
CREATE POLICY feed_outcomes ON program_outcomes FOR SELECT TO cic_impact USING(org_id=cic_org_id() AND EXISTS(SELECT FROM donor_outcome_publications p WHERE p.org_id=program_outcomes.org_id AND p.outcome_id=program_outcomes.id AND p.approved_at=program_outcomes.approved_at));

CREATE FUNCTION public.donor_impact_feed(p_limit integer,p_offset integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_donor uuid;v_gifts jsonb;v_outcomes jsonb;
BEGIN
  IF p_limit<1 OR p_limit>100 OR p_offset<0 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023';END IF;
  SELECT a.donor_id INTO v_donor FROM public.donor_feed_access a LIMIT 1;
  IF v_donor IS NULL THEN RAISE EXCEPTION 'Donor access required' USING ERRCODE='42501';END IF;
  SELECT coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) INTO v_gifts FROM(
    SELECT g.amount_cents::text,g.refund_cents::text,g.currency,g.status,
      to_char(g.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,c.title AS campaign
    FROM public.gifts g LEFT JOIN public.campaigns c ON c.org_id=g.org_id AND c.id=g.campaign_id
    WHERE g.org_id=public.cic_org_id() AND g.donor_id=v_donor ORDER BY g.occurred_at DESC LIMIT p_limit OFFSET p_offset
  )x;
  SELECT coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) INTO v_outcomes FROM(
    SELECT p.title AS program,o.metric,o.value::text,o.unit,o.denominator::text,
      to_char(o.period_from AT TIME ZONE 'America/Phoenix','YYYY-MM-DD') AS period_from,
      to_char(o.period_to AT TIME ZONE 'America/Phoenix','YYYY-MM-DD') AS period_to
    FROM public.program_outcomes o JOIN public.programs p ON p.org_id=o.org_id AND p.id=o.program_id
    WHERE o.org_id=public.cic_org_id() AND EXISTS(SELECT FROM public.gifts g JOIN public.campaigns c ON c.org_id=g.org_id AND c.id=g.campaign_id
      WHERE g.org_id=o.org_id AND g.donor_id=v_donor AND c.program_id=o.program_id AND g.status='settled' AND g.amount_cents>g.refund_cents)
    ORDER BY o.period_to DESC,o.metric LIMIT 100
  )x;
  RETURN jsonb_build_object('gifts',v_gifts,'outcomes',v_outcomes,'limit',p_limit,'offset',p_offset);
END$$;
GRANT cic_impact TO CURRENT_USER;GRANT CREATE ON SCHEMA public TO cic_impact;
ALTER FUNCTION public.donor_impact_feed(integer,integer) OWNER TO cic_impact;
REVOKE CREATE ON SCHEMA public FROM cic_impact;REVOKE cic_impact FROM CURRENT_USER;
REVOKE ALL ON FUNCTION public.donor_impact_feed(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.donor_impact_feed(integer,integer) TO cic_runtime;
COMMIT;
