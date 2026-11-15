BEGIN;

CREATE FUNCTION public.assignable_owners()
RETURNS TABLE (id uuid, role text, active boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT public.cic_is_admin() THEN
    RAISE EXCEPTION 'Active admin membership required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT m.id, m.role, m.active FROM public.memberships m
    WHERE m.org_id = public.cic_org_id() AND m.active AND m.role = 'board' ORDER BY m.id;
END $$;

GRANT cic_assignment TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO cic_assignment;
ALTER FUNCTION public.assignable_owners() OWNER TO cic_assignment;
REVOKE CREATE ON SCHEMA public FROM cic_assignment;
REVOKE cic_assignment FROM CURRENT_USER;
REVOKE ALL ON FUNCTION public.assignable_owners() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assignable_owners() TO cic_runtime;

COMMIT;
