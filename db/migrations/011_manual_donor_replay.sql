BEGIN;

CREATE TABLE manual_donor_requests (
  org_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  donor_id uuid NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (org_id,actor_id,request_id),
  FOREIGN KEY (org_id,actor_id) REFERENCES memberships(org_id,id),
  FOREIGN KEY (org_id,donor_id) REFERENCES donors(org_id,id)
);
ALTER TABLE manual_donor_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_donor_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY manual_request_assignment ON manual_donor_requests TO cic_assignment
  USING (org_id=public.cic_org_id()) WITH CHECK (org_id=public.cic_org_id());
GRANT SELECT,INSERT ON manual_donor_requests TO cic_assignment;

CREATE FUNCTION public.create_donor_once(p_request uuid,p_name text,p_email text,p_phone text,p_consent text,p_metadata jsonb)
RETURNS TABLE (id uuid,owner_id uuid,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_org uuid := public.cic_org_id();
  v_actor uuid := public.cic_member_id();
  v_hash text := encode(sha256(convert_to(jsonb_build_array(p_name,p_email,p_phone,p_consent,p_metadata)::text,'UTF8')),'hex');
  v_prior public.manual_donor_requests%ROWTYPE;
  v_created record;
BEGIN
  IF v_actor IS NULL OR p_request IS NULL THEN
    RAISE EXCEPTION 'Active membership and request ID required' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text||v_actor::text||p_request::text,0));
  SELECT * INTO v_prior FROM public.manual_donor_requests r
    WHERE r.org_id=v_org AND r.actor_id=v_actor AND r.request_id=p_request;
  IF FOUND THEN
    IF v_prior.payload_sha256<>v_hash THEN
      RAISE EXCEPTION 'Request content changed' USING ERRCODE='P0003';
    END IF;
    RETURN QUERY SELECT d.id,d.owner_id,true FROM public.donors d
      WHERE d.org_id=v_org AND d.id=v_prior.donor_id;
    RETURN;
  END IF;
  SELECT * INTO v_created FROM public.create_assigned_donor(p_name,p_email,p_phone,p_consent,p_metadata);
  INSERT INTO public.manual_donor_requests(org_id,actor_id,request_id,donor_id,payload_sha256)
    VALUES(v_org,v_actor,p_request,v_created.id,v_hash);
  RETURN QUERY SELECT v_created.id::uuid,v_created.owner_id::uuid,false;
END $$;

GRANT cic_assignment TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO cic_assignment;
ALTER FUNCTION public.create_donor_once(uuid,text,text,text,text,jsonb) OWNER TO cic_assignment;
REVOKE CREATE ON SCHEMA public FROM cic_assignment;
REVOKE cic_assignment FROM CURRENT_USER;
REVOKE ALL ON FUNCTION public.create_donor_once(uuid,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_donor_once(uuid,text,text,text,text,jsonb) TO cic_runtime;

COMMIT;
