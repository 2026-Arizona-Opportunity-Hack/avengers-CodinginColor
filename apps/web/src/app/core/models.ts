/**
 * UI models. Donor and gift fields mirror packages/contracts (DonorSchema, GiftSchema);
 * company, kind, channel and sources are carried in donor metadata on the server.
 */

export type Role = 'admin' | 'board';
export type Consent = 'unknown' | 'granted' | 'denied';
export type GiftStatus = 'settled' | 'pending' | 'void';
export type Source = 'spreadsheet' | 'zeffy' | 'benevity' | 'az_gives' | 'united_way' | 'manual';
export type DonorKind = 'individual' | 'company' | 'foundation';
export type Channel = 'email' | 'text';

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  title: string;
  active: boolean;
}

export interface Donor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  kind: DonorKind;
  owner_id: string | null;
  consent: Consent;
  preferred_channel: Channel;
  created_at: string;
  archived_at: string | null;
  sources: Source[];
  custom: Record<string, string>;
}

export interface Program { id: string; title: string; }

export interface Campaign {
  id: string;
  title: string;
  program_id: string | null;
  starts_on: string;
  location: string;
}

export interface Gift {
  id: string;
  donor_id: string;
  campaign_id: string | null;
  amount_cents: number;
  refund_cents: number;
  currency: string;
  occurred_at: string;
  status: GiftStatus;
  source: Source;
  external_id: string | null;
}

export type CommunicationKind = 'email' | 'text' | 'call' | 'meeting' | 'note';

/** Something that already happened between CIC and a donor. Never a future plan. */
export interface Communication {
  id: string;
  donor_id: string;
  member_id: string;
  kind: CommunicationKind;
  direction: 'outbound' | 'inbound' | 'internal';
  summary: string;
  body: string;
  occurred_at: string;
  draft_id: string | null;
}

export type FollowUpKind = 'next_step' | 'quarterly' | 'thank_you';

/** A future action with a due date. Becomes a communication only when a human does it. */
export interface FollowUp {
  id: string;
  donor_id: string;
  owner_id: string;
  kind: FollowUpKind;
  action: string;
  due_on: string;
  status: 'open' | 'done' | 'dismissed';
  created_at: string;
  completed_at: string | null;
}

export type TemplatePurpose = 'thank_you' | 'quarterly' | 'nudge' | 'assignment_digest';

export interface Template {
  id: string;
  name: string;
  purpose: TemplatePurpose;
  channel: Channel;
  subject: string;
  body: string;
}

export type DraftStatus = 'pending' | 'approved' | 'sent' | 'discarded';

/** A system-drafted message. Only a human approves it and only a human sends it. */
export interface Draft {
  id: string;
  donor_id: string | null;
  recipient_member_id: string | null;
  owner_id: string;
  template_id: string;
  channel: Channel;
  to: string;
  subject: string;
  body: string;
  reason: string;
  status: DraftStatus;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  sent_by: string | null;
  sent_at: string | null;
}

export interface Outcome {
  program_id: string;
  year: number;
  metric: string;
  value: number | null;
  approved: boolean;
}

export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  created_by: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CustomField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select';
  options: string[];
}

export interface AuditEvent {
  id: string;
  actor_id: string;
  action: string;
  target: string;
  at: string;
}

export interface Dataset {
  version: number;
  members: Member[];
  donors: Donor[];
  programs: Program[];
  campaigns: Campaign[];
  gifts: Gift[];
  communications: Communication[];
  followUps: FollowUp[];
  templates: Template[];
  drafts: Draft[];
  outcomes: Outcome[];
  apiKeys: ApiKey[];
  customFields: CustomField[];
  audit: AuditEvent[];
  assignmentCursor: number;
}

export const SOURCE_LABEL: Record<Source, string> = {
  spreadsheet: 'CIC spreadsheet',
  zeffy: 'Zeffy',
  benevity: 'Benevity',
  az_gives: 'AZ Gives',
  united_way: 'United Way',
  manual: 'Manual entry',
};
