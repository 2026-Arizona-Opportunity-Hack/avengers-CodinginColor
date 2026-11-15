BEGIN;

CREATE TABLE debrief_requests (
  org_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  communication_id uuid NOT NULL REFERENCES communications(id),
  follow_up_id uuid REFERENCES follow_ups(id),
  draft_id uuid REFERENCES drafts(id),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (org_id, actor_id, request_id),
  FOREIGN KEY (org_id, actor_id) REFERENCES memberships(org_id, id)
);
ALTER TABLE debrief_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE debrief_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY debrief_actor ON debrief_requests TO cic_runtime
  USING (org_id = cic_org_id() AND actor_id = cic_member_id())
  WITH CHECK (org_id = cic_org_id() AND actor_id = cic_member_id());
GRANT SELECT, INSERT ON debrief_requests TO cic_runtime;

COMMIT;
