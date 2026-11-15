BEGIN;

-- Outreach (#47): follow-up tasks, message drafts and an append-only communications log.
-- Design reviewed on issue #47. Rules live in packages/outreach; these tables add database-level
-- guards: visibility follows donor visibility (board members: own donors; admins: the org),
-- no deletes, one record per approved message, and frozen history once a message is sent or logged.

CREATE TABLE follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  donor_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('quarterly', 'next_action')),
  quarter text CHECK (quarter ~ '^\d{4}-Q[1-4]$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  completed_at timestamptz,
  completed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'quarterly') = (quarter IS NOT NULL)),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, donor_id) REFERENCES donors(org_id, id),
  FOREIGN KEY (org_id, owner_id) REFERENCES memberships(org_id, id),
  FOREIGN KEY (org_id, completed_by) REFERENCES memberships(org_id, id)
);
-- One quarterly touch per donor per quarter; generation uses ON CONFLICT ... DO NOTHING.
CREATE UNIQUE INDEX follow_ups_quarterly ON follow_ups (org_id, donor_id, quarter) WHERE kind = 'quarterly';
CREATE INDEX follow_ups_queue ON follow_ups (org_id, owner_id, due_at) WHERE status = 'open';

CREATE TABLE drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  donor_id uuid NOT NULL,
  author_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 320),
  subject text CHECK (subject IS NULL OR (length(subject) <= 200 AND subject !~ '[\r\n]')),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'failed', 'logged')),
  approval_hash text CHECK (approval_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Every non-draft state carries the hash of the exact content that was approved.
  CHECK ((status = 'draft') = (approval_hash IS NULL)),
  UNIQUE (org_id, id),
  -- Lets communications prove a referenced draft belongs to the same donor.
  UNIQUE (org_id, donor_id, id),
  FOREIGN KEY (org_id, donor_id) REFERENCES donors(org_id, id),
  FOREIGN KEY (org_id, author_id) REFERENCES memberships(org_id, id),
  FOREIGN KEY (org_id, approved_by) REFERENCES memberships(org_id, id)
);

CREATE TABLE communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  donor_id uuid NOT NULL,
  draft_id uuid,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'call', 'meeting')),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('delivered', 'failed', 'logged_manual', 'logged_contact')),
  approval_hash text CHECK (approval_hash ~ '^[0-9a-f]{64}$'),
  qualifying boolean NOT NULL,
  note text CHECK (note IS NULL OR length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Sent and manually logged messages always reference an approval.
  CHECK (status NOT IN ('delivered', 'logged_manual') OR approval_hash IS NOT NULL),
  -- A failed delivery is never a qualifying contact.
  CHECK (status <> 'failed' OR NOT qualifying),
  FOREIGN KEY (org_id, donor_id) REFERENCES donors(org_id, id),
  -- A logged message can only reference a draft written for this same donor (review on #55).
  FOREIGN KEY (org_id, donor_id, draft_id) REFERENCES drafts(org_id, donor_id, id),
  FOREIGN KEY (org_id, actor_id) REFERENCES memberships(org_id, id)
);
-- A repeated send of the same approved message cannot create a second record.
CREATE UNIQUE INDEX communications_once ON communications (org_id, approval_hash)
  WHERE status IN ('delivered', 'logged_manual');
CREATE INDEX communications_timeline ON communications (org_id, donor_id, occurred_at);

-- Sent or logged drafts are history; editing approved content drops the approval.
CREATE FUNCTION public.cic_drafts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status IN ('sent', 'logged') THEN
    RAISE EXCEPTION 'Message was already sent or logged' USING ERRCODE = '55000';
  END IF;
  IF NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.status := 'draft';
    NEW.approval_hash := NULL;
    NEW.approved_by := NULL;
    NEW.approved_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER drafts_guard BEFORE UPDATE ON drafts FOR EACH ROW EXECUTE FUNCTION public.cic_drafts_guard();

ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups FORCE ROW LEVEL SECURITY;
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications FORCE ROW LEVEL SECURITY;

-- Visibility follows donors (whose own policy limits board members to donors they own).
CREATE POLICY follow_ups_read ON follow_ups FOR SELECT TO cic_runtime
  USING (org_id = cic_org_id() AND EXISTS (SELECT FROM donors d WHERE d.org_id = follow_ups.org_id AND d.id = follow_ups.donor_id));
CREATE POLICY follow_ups_create ON follow_ups FOR INSERT TO cic_runtime
  WITH CHECK (org_id = cic_org_id() AND status = 'open' AND completed_by IS NULL
    AND EXISTS (SELECT FROM donors d WHERE d.org_id = follow_ups.org_id AND d.id = follow_ups.donor_id
      AND d.owner_id = follow_ups.owner_id));
CREATE POLICY follow_ups_update ON follow_ups FOR UPDATE TO cic_runtime
  USING (org_id = cic_org_id() AND EXISTS (SELECT FROM donors d WHERE d.org_id = follow_ups.org_id AND d.id = follow_ups.donor_id))
  WITH CHECK (org_id = cic_org_id() AND (completed_by IS NULL OR completed_by = cic_member_id()));

CREATE POLICY drafts_read ON drafts FOR SELECT TO cic_runtime
  USING (org_id = cic_org_id() AND EXISTS (SELECT FROM donors d WHERE d.org_id = drafts.org_id AND d.id = drafts.donor_id));
CREATE POLICY drafts_create ON drafts FOR INSERT TO cic_runtime
  WITH CHECK (org_id = cic_org_id() AND author_id = cic_member_id() AND status = 'draft'
    AND EXISTS (SELECT FROM donors d WHERE d.org_id = drafts.org_id AND d.id = drafts.donor_id));
CREATE POLICY drafts_update ON drafts FOR UPDATE TO cic_runtime
  USING (org_id = cic_org_id() AND EXISTS (SELECT FROM donors d WHERE d.org_id = drafts.org_id AND d.id = drafts.donor_id))
  WITH CHECK (org_id = cic_org_id() AND (approved_by IS NULL OR approved_by = cic_member_id()));

CREATE POLICY communications_read ON communications FOR SELECT TO cic_runtime
  USING (org_id = cic_org_id() AND EXISTS (SELECT FROM donors d WHERE d.org_id = communications.org_id AND d.id = communications.donor_id));
CREATE POLICY communications_create ON communications FOR INSERT TO cic_runtime
  WITH CHECK (org_id = cic_org_id() AND actor_id = cic_member_id()
    AND EXISTS (SELECT FROM donors d WHERE d.org_id = communications.org_id AND d.id = communications.donor_id));

GRANT SELECT ON follow_ups, drafts, communications TO cic_runtime;
GRANT INSERT (org_id, donor_id, owner_id, kind, quarter, title, due_at) ON follow_ups TO cic_runtime;
GRANT UPDATE (status, completed_at, completed_by) ON follow_ups TO cic_runtime;
GRANT INSERT (org_id, donor_id, author_id, channel, recipient, subject, body) ON drafts TO cic_runtime;
GRANT UPDATE (subject, body, status, approval_hash, approved_by, approved_at, updated_at) ON drafts TO cic_runtime;
GRANT INSERT (org_id, donor_id, draft_id, channel, actor_id, occurred_at, status, approval_hash, qualifying, note)
  ON communications TO cic_runtime;

COMMIT;
