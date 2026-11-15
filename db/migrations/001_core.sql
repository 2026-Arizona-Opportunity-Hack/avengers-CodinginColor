BEGIN;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Run as a migration owner; grant cic_runtime to a separate application login.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cic_runtime') THEN
    CREATE ROLE cic_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  clerk_subject text NOT NULL CHECK (length(btrim(clerk_subject)) > 0),
  role text NOT NULL CHECK (role IN ('admin', 'board')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, clerk_subject)
);

CREATE TABLE programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  UNIQUE (org_id, id)
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id)
);

CREATE TABLE donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  owner_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  email text,
  phone text,
  consent text NOT NULL DEFAULT 'unknown' CHECK (consent IN ('unknown', 'granted', 'denied')),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, owner_id) REFERENCES memberships(org_id, id)
);
CREATE INDEX donors_owner ON donors(org_id, owner_id) WHERE archived_at IS NULL;

CREATE TABLE gifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  donor_id uuid NOT NULL,
  campaign_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 9007199254740991),
  refund_cents bigint NOT NULL CHECK (refund_cents BETWEEN 0 AND amount_cents),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('settled', 'pending', 'void')),
  source text NOT NULL CHECK (length(btrim(source)) > 0),
  external_id text CHECK (external_id IS NULL OR length(btrim(external_id)) > 0),
  source_row jsonb CHECK (source_row IS NULL OR (
    jsonb_typeof(source_row) = 'object'
    AND source_row ? 'batch_id' AND source_row ? 'row_key'
    AND jsonb_typeof(source_row->'batch_id') = 'string'
    AND (source_row->>'batch_id')::uuid IS NOT NULL
    AND jsonb_typeof(source_row->'row_key') = 'string'
    AND length(btrim(source_row->>'row_key')) > 0
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, donor_id) REFERENCES donors(org_id, id),
  FOREIGN KEY (org_id, campaign_id) REFERENCES campaigns(org_id, id)
);
CREATE UNIQUE INDEX gifts_source_identity ON gifts(org_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX gifts_donor_date ON gifts(org_id, donor_id, occurred_at, id);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  target_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'failure')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, actor_id) REFERENCES memberships(org_id, id)
);

CREATE TABLE assignment_cursors (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  last_owner_id uuid,
  FOREIGN KEY (org_id, last_owner_id) REFERENCES memberships(org_id, id)
);

-- Context is set with SET LOCAL inside the API transaction after session verification.
CREATE FUNCTION cic_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;
CREATE FUNCTION cic_member_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM public.memberships
  WHERE org_id = public.cic_org_id() AND active
    AND clerk_subject = nullif(current_setting('app.user_id', true), '')
$$;
CREATE FUNCTION cic_is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT FROM public.memberships
    WHERE org_id = public.cic_org_id() AND active AND role = 'admin'
      AND clerk_subject = nullif(current_setting('app.user_id', true), ''))
$$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE donors ENABLE ROW LEVEL SECURITY;
ALTER TABLE donors FORCE ROW LEVEL SECURITY;
ALTER TABLE programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE programs FORCE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gifts FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE assignment_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_cursors FORCE ROW LEVEL SECURITY;

-- Membership reads never call membership helpers, avoiding recursive RLS evaluation.
CREATE POLICY membership_self ON memberships FOR SELECT TO cic_runtime
  USING (org_id = cic_org_id() AND active
    AND clerk_subject = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY organization_member ON organizations FOR SELECT TO cic_runtime
  USING (id = cic_org_id() AND cic_member_id() IS NOT NULL);
CREATE POLICY donor_scope ON donors FOR ALL TO cic_runtime
  USING (org_id = cic_org_id() AND (cic_is_admin() OR owner_id = cic_member_id()))
  WITH CHECK (org_id = cic_org_id() AND (cic_is_admin() OR owner_id = cic_member_id()));
CREATE POLICY gift_scope ON gifts FOR ALL TO cic_runtime
  USING (org_id = cic_org_id() AND EXISTS (
    SELECT FROM donors d WHERE d.org_id = gifts.org_id AND d.id = gifts.donor_id))
  WITH CHECK (org_id = cic_org_id() AND EXISTS (
    SELECT FROM donors d WHERE d.org_id = gifts.org_id AND d.id = gifts.donor_id));
CREATE POLICY program_read ON programs FOR SELECT TO cic_runtime
  USING (org_id = cic_org_id() AND cic_member_id() IS NOT NULL);
CREATE POLICY campaign_read ON campaigns FOR SELECT TO cic_runtime
  USING (org_id = cic_org_id() AND cic_member_id() IS NOT NULL);
CREATE POLICY audit_read ON audit_events FOR SELECT TO cic_runtime
  USING (org_id = cic_org_id() AND (cic_is_admin() OR actor_id = cic_member_id()));
CREATE POLICY audit_insert ON audit_events FOR INSERT TO cic_runtime
  WITH CHECK (org_id = cic_org_id() AND actor_id = cic_member_id());
CREATE POLICY cursor_admin ON assignment_cursors FOR ALL TO cic_runtime
  USING (org_id = cic_org_id() AND cic_is_admin())
  WITH CHECK (org_id = cic_org_id() AND cic_is_admin());

GRANT USAGE ON SCHEMA public TO cic_runtime;
GRANT SELECT ON organizations, memberships, programs, campaigns TO cic_runtime;
GRANT SELECT, INSERT ON donors, gifts TO cic_runtime;
GRANT UPDATE (name, email, phone, consent, metadata, archived_at, updated_at) ON donors TO cic_runtime;
GRANT UPDATE (campaign_id, amount_cents, refund_cents, currency, occurred_at, status, updated_at) ON gifts TO cic_runtime;
GRANT SELECT, INSERT ON audit_events TO cic_runtime;
GRANT SELECT, INSERT, UPDATE ON assignment_cursors TO cic_runtime;

COMMIT;
