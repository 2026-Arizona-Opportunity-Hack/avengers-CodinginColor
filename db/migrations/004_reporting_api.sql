BEGIN;

-- Dashboard API keys and an aggregate-only read path (#29). Design reviewed on issue #29.
-- cic_reporting is a non-login definer role: no member can SET ROLE to it, and its column grants
-- exclude every donor contact field, so even a function bug cannot read names, emails or phones.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles r WHERE r.rolname = 'cic_reporting' AND (
    r.rolsuper OR r.rolbypassrls OR r.rolcanlogin OR r.rolcreatedb OR
    r.rolcreaterole OR r.rolinherit OR r.rolreplication OR
    EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid)
  )) THEN
    RAISE EXCEPTION 'Unsafe existing cic_reporting role';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cic_reporting') THEN
    CREATE ROLE cic_reporting NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
END $$;

-- Only the SHA-256 of a key is stored; the raw key is shown once by the issuing tool.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  hint text NOT NULL CHECK (hint ~ '^cic_live_[A-Za-z0-9_-]{4}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['read:aggregates']::text[]),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES memberships(org_id, id)
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

-- Admins manage keys through the runtime role; key_hash is never selectable by runtime.
CREATE POLICY api_keys_admin_read ON api_keys FOR SELECT TO cic_runtime
  USING (org_id = cic_org_id() AND cic_is_admin());
CREATE POLICY api_keys_admin_create ON api_keys FOR INSERT TO cic_runtime
  WITH CHECK (org_id = cic_org_id() AND cic_is_admin() AND created_by = cic_member_id() AND revoked_at IS NULL);
CREATE POLICY api_keys_admin_revoke ON api_keys FOR UPDATE TO cic_runtime
  USING (org_id = cic_org_id() AND cic_is_admin() AND revoked_at IS NULL)
  WITH CHECK (org_id = cic_org_id() AND revoked_at IS NOT NULL);
GRANT SELECT (id, org_id, name, hint, scopes, created_by, created_at, revoked_at) ON api_keys TO cic_runtime;
GRANT INSERT (org_id, name, key_hash, hint, scopes, created_by) ON api_keys TO cic_runtime;
GRANT UPDATE (revoked_at) ON api_keys TO cic_runtime;

-- Narrow read access for the definer role: no donor name, email, phone, consent or metadata.
GRANT USAGE ON SCHEMA public TO cic_reporting;
GRANT SELECT (org_id, key_hash, scopes, revoked_at) ON api_keys TO cic_reporting;
GRANT SELECT (org_id, donor_id, campaign_id, amount_cents, refund_cents, currency, occurred_at, status, source)
  ON gifts TO cic_reporting;
GRANT SELECT (id, org_id, owner_id) ON donors TO cic_reporting;
GRANT SELECT (id, org_id, program_id) ON campaigns TO cic_reporting;
GRANT SELECT (id, org_id, title) ON programs TO cic_reporting;
-- Organization scoping happens inside the functions, which resolve the org from the key.
CREATE POLICY reporting_keys ON api_keys FOR SELECT TO cic_reporting USING (true);
CREATE POLICY reporting_gifts ON gifts FOR SELECT TO cic_reporting USING (true);
CREATE POLICY reporting_donors ON donors FOR SELECT TO cic_reporting USING (true);
CREATE POLICY reporting_campaigns ON campaigns FOR SELECT TO cic_reporting USING (true);
CREATE POLICY reporting_programs ON programs FOR SELECT TO cic_reporting USING (true);

CREATE FUNCTION public.cic_reporting_gifts(p_key_hash text, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (donor_id uuid, program_id uuid, owner_id uuid, amount_cents bigint, refund_cents bigint,
  currency text, occurred_at timestamptz, status text, source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_org uuid;
BEGIN
  SELECT k.org_id INTO v_org FROM public.api_keys k
    WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL AND 'read:aggregates' = ANY (k.scopes);
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Invalid API key' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to OR p_to - p_from > interval '1830 days' THEN
    RAISE EXCEPTION 'Invalid reporting window' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT g.donor_id, c.program_id, d.owner_id, g.amount_cents, g.refund_cents,
      g.currency, g.occurred_at, g.status, g.source
    FROM public.gifts g
    JOIN public.donors d ON d.org_id = g.org_id AND d.id = g.donor_id
    LEFT JOIN public.campaigns c ON c.org_id = g.org_id AND c.id = g.campaign_id
    WHERE g.org_id = v_org AND g.status <> 'void' AND g.occurred_at >= p_from AND g.occurred_at < p_to;
END $$;

CREATE FUNCTION public.cic_reporting_recent(p_key_hash text, p_limit integer)
RETURNS TABLE (donor_id uuid, program_id uuid, owner_id uuid, amount_cents bigint, refund_cents bigint,
  currency text, occurred_at timestamptz, status text, source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_org uuid;
BEGIN
  SELECT k.org_id INTO v_org FROM public.api_keys k
    WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL AND 'read:aggregates' = ANY (k.scopes);
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Invalid API key' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Invalid limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT g.donor_id, c.program_id, d.owner_id, g.amount_cents, g.refund_cents,
      g.currency, g.occurred_at, g.status, g.source
    FROM public.gifts g
    JOIN public.donors d ON d.org_id = g.org_id AND d.id = g.donor_id
    LEFT JOIN public.campaigns c ON c.org_id = g.org_id AND c.id = g.campaign_id
    WHERE g.org_id = v_org AND g.status <> 'void'
    ORDER BY g.occurred_at DESC, g.donor_id
    LIMIT p_limit;
END $$;

CREATE FUNCTION public.cic_reporting_programs(p_key_hash text)
RETURNS TABLE (id uuid, title text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_org uuid;
BEGIN
  SELECT k.org_id INTO v_org FROM public.api_keys k
    WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL AND 'read:aggregates' = ANY (k.scopes);
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Invalid API key' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT p.id, p.title FROM public.programs p WHERE p.org_id = v_org ORDER BY p.title, p.id;
END $$;

-- The functions are owned by the scoped definer role, never by the migration owner (same pattern as 002/003).
GRANT cic_reporting TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO cic_reporting;
ALTER FUNCTION public.cic_reporting_gifts(text, timestamptz, timestamptz) OWNER TO cic_reporting;
ALTER FUNCTION public.cic_reporting_recent(text, integer) OWNER TO cic_reporting;
ALTER FUNCTION public.cic_reporting_programs(text) OWNER TO cic_reporting;
REVOKE CREATE ON SCHEMA public FROM cic_reporting;
REVOKE cic_reporting FROM CURRENT_USER;
REVOKE ALL ON FUNCTION public.cic_reporting_gifts(text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cic_reporting_recent(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cic_reporting_programs(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cic_reporting_gifts(text, timestamptz, timestamptz) TO cic_runtime;
GRANT EXECUTE ON FUNCTION public.cic_reporting_recent(text, integer) TO cic_runtime;
GRANT EXECUTE ON FUNCTION public.cic_reporting_programs(text) TO cic_runtime;

COMMIT;
