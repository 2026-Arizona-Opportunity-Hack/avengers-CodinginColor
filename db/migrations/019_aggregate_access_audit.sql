BEGIN;

CREATE TABLE public.aggregate_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  key_id uuid NOT NULL,
  route text NOT NULL CHECK (route IN ('summary','activity')),
  status integer NOT NULL CHECK (status IN (200,429)),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id,key_id) REFERENCES public.api_keys(org_id,id)
);
CREATE INDEX aggregate_access_org_time ON public.aggregate_access_events(org_id,created_at);
ALTER TABLE public.aggregate_access_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aggregate_access_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.aggregate_access_events FROM PUBLIC,cic_runtime,cic_reporting;
GRANT SELECT ON public.aggregate_access_events TO cic_runtime;
CREATE POLICY aggregate_access_admin_read ON public.aggregate_access_events FOR SELECT TO cic_runtime
  USING (org_id=public.cic_org_id() AND public.cic_is_admin());
GRANT INSERT(org_id,key_id,route,status) ON public.aggregate_access_events TO cic_reporting;
CREATE POLICY aggregate_access_insert ON public.aggregate_access_events FOR INSERT TO cic_reporting WITH CHECK (true);
GRANT SELECT(id) ON public.api_keys TO cic_reporting;

CREATE FUNCTION public.cic_record_aggregate_access(p_key_hash text,p_route text,p_status integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_org uuid; v_key uuid;
BEGIN
  IF p_route IS NULL OR p_route NOT IN ('summary','activity') OR p_status IS NULL OR p_status NOT IN (200,429)
    OR p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid audit input' USING ERRCODE='22023';
  END IF;
  SELECT k.org_id,k.id INTO v_org,v_key FROM public.api_keys k
    WHERE k.key_hash=p_key_hash AND k.revoked_at IS NULL AND 'read:aggregates'=ANY(k.scopes);
  IF v_key IS NULL THEN RAISE EXCEPTION 'Invalid API key' USING ERRCODE='42501'; END IF;
  INSERT INTO public.aggregate_access_events(org_id,key_id,route,status) VALUES(v_org,v_key,p_route,p_status);
END $$;

-- Managed grants may come from another grantor; remove only our temporary SET grant.
DO $$
DECLARE
  actor name:=current_user;
  need_set boolean:=NOT pg_has_role(current_user,'cic_reporting','SET');
  need_create boolean:=NOT has_schema_privilege('cic_reporting','public','CREATE');
  memberships jsonb;
  schema_acl aclitem[];
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor),'[]') INTO memberships
    FROM pg_auth_members m WHERE m.roleid='cic_reporting'::regrole;
  SELECT nspacl INTO schema_acl FROM pg_namespace WHERE oid='public'::regnamespace;
  IF need_set THEN
    IF EXISTS(SELECT FROM pg_auth_members WHERE roleid='cic_reporting'::regrole
      AND member=actor::regrole AND grantor=actor::regrole) THEN
      RAISE EXCEPTION 'Unexpected self-grant; preserve existing membership';
    END IF;
    EXECUTE format('GRANT cic_reporting TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',actor);
  END IF;
  IF need_create THEN GRANT CREATE ON SCHEMA public TO cic_reporting; END IF;
  ALTER FUNCTION public.cic_record_aggregate_access(text,text,integer) OWNER TO cic_reporting;
  SET LOCAL ROLE cic_reporting;
  REVOKE ALL ON FUNCTION public.cic_record_aggregate_access(text,text,integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.cic_record_aggregate_access(text,text,integer) TO cic_runtime;
  EXECUTE format('SET LOCAL ROLE %I',actor);
  IF need_create THEN REVOKE CREATE ON SCHEMA public FROM cic_reporting; END IF;
  IF need_set THEN EXECUTE format('REVOKE cic_reporting FROM %I GRANTED BY %I',actor,actor); END IF;
  IF memberships IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor),'[]')
      FROM pg_auth_members m WHERE m.roleid='cic_reporting'::regrole)
    OR schema_acl IS DISTINCT FROM (SELECT nspacl FROM pg_namespace WHERE oid='public'::regnamespace) THEN
    RAISE EXCEPTION 'Managed role or schema privileges changed';
  END IF;
  IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid='public.cic_record_aggregate_access(text,text,integer)'::regprocedure
    AND p.proowner='cic_reporting'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'])
    OR EXISTS(SELECT FROM pg_proc p,aclexplode(p.proacl) a
      WHERE p.oid='public.cic_record_aggregate_access(text,text,integer)'::regprocedure
      AND a.grantee NOT IN ('cic_reporting'::regrole,'cic_runtime'::regrole))
    OR NOT has_function_privilege('cic_runtime','public.cic_record_aggregate_access(text,text,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected audit function privileges';
  END IF;
END $$;
COMMIT;
