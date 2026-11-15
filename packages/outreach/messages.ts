import { createHash } from 'node:crypto';
import { instant } from '../reporting/retention.ts';

/** Rule violations whose messages are safe to show the user. */
export class ApprovalError extends Error {}

export type Channel = 'email' | 'sms';
export type Actor = { member_id: string; role: 'admin' | 'board' };
export type MessageDonor = { id: string; owner_id: string | null; consent: 'unknown' | 'granted' | 'denied';
  email?: string | null; phone?: string | null };
export type Draft = {
  donor_id: string; owner_id: string | null; channel: Channel; recipient: string;
  subject: string | null; body: string;
  status: 'draft' | 'approved' | 'sent' | 'failed' | 'logged';
  approval: { hash: string; approved_by: string; approved_at: string } | null;
};
export type Communication = { donor_id: string; channel: Channel; actor_id: string; sent_at: string;
  status: 'delivered' | 'failed' | 'logged_manual'; approval_hash: string;
  /** Only real contact closes a quarterly touch; failures never do. */
  qualifying: boolean };

const FIELDS = new Set(['first_name', 'amount', 'program', 'gift_date', 'org_name', 'impact']);
/** Optional fields: a line using one is dropped when it has no value (no impact claim without an approved metric). */
const OPTIONAL = new Set(['impact']);

export const TEMPLATES = {
  thank_you: { channel: 'email', subject: 'Thank you from Coding in Color', body:
    'Hi {{first_name}},\n\nThank you for your gift of {{amount}} to {{program}}. It helps Arizona high schoolers ' +
    'learn computer science and AI.\n\nWith gratitude,\nCoding in Color' },
  thank_you_sms: { channel: 'sms', subject: null, body:
    'Hi {{first_name}}, thank you for supporting {{program}} at Coding in Color!' },
  quarterly_update: { channel: 'email', subject: 'An update from Coding in Color', body:
    'Hi {{first_name}},\n\nA quick update on {{program}} this quarter.\n{{impact}}\n\n' +
    'Thank you for being part of Coding in Color.\nCoding in Color' },
} as const satisfies Record<string, { channel: Channel; subject: string | null; body: string }>;
export type TemplateId = keyof typeof TEMPLATES;

const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, '').trim();

/** Fill `{{field}}` placeholders from an allowlist. Output is plain text; unknown or missing fields throw. */
export function renderTemplate(template: string, fields: Record<string, string | undefined>): string {
  return template.split('\n').flatMap((line) => {
    const names = [...line.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    for (const name of names) if (!FIELDS.has(name)) throw new ApprovalError(`Unknown field: ${name}`);
    if (names.some((n) => OPTIONAL.has(n) && !clean(fields[n] ?? ''))) return [];
    return [line.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      const value = clean(fields[name] ?? '');
      if (!value) throw new ApprovalError(`Missing field: ${name}`);
      return value;
    })];
  }).join('\n');
}

const EMAIL = /^[^\s@?&#%<>,;:"'\\/]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
function recipientFor(donor: MessageDonor, channel: Channel): string {
  const raw = (channel === 'email' ? donor.email : donor.phone)?.trim();
  if (!raw) throw new ApprovalError(`Missing recipient: donor has no ${channel === 'email' ? 'email' : 'phone'}`);
  if (channel === 'email') {
    if (!EMAIL.test(raw)) throw new ApprovalError('Invalid recipient email');
    return raw.toLowerCase();
  }
  if (!/^\+?[\d().\s-]{7,20}$/.test(raw)) throw new ApprovalError('Invalid recipient phone');
  return raw.replace(/(?!^\+)[^\d]/g, '');
}

function checkContent(channel: Channel, subject: string | null, body: string) {
  if (subject !== null && (/[\r\n]/.test(subject) || subject.length > 200)) throw new ApprovalError('Invalid subject');
  if (!body.trim() || body.length > (channel === 'sms' ? 640 : 5000)) throw new ApprovalError('Invalid message body');
}

function assertContactAllowed(donor: MessageDonor) {
  if (donor.consent === 'denied') throw new ApprovalError('Donor declined contact');
}
function assertMayAct(actor: Actor, ownerId: string | null) {
  if (actor.role !== 'admin' && actor.member_id !== ownerId) throw new ApprovalError("Actor is not this donor's owner");
}

export function createDraft(input: { donor: MessageDonor; channel: Channel; template: TemplateId;
  fields: Record<string, string | undefined> }): Draft {
  assertContactAllowed(input.donor);
  const template = TEMPLATES[input.template];
  if (template.channel !== input.channel) throw new ApprovalError('Template does not match channel');
  const draft: Draft = { donor_id: input.donor.id, owner_id: input.donor.owner_id, channel: input.channel,
    recipient: recipientFor(input.donor, input.channel), subject: template.subject,
    body: renderTemplate(template.body, input.fields), status: 'draft', approval: null };
  checkContent(draft.channel, draft.subject, draft.body);
  return draft;
}

/** SHA-256 over exactly what will be sent: donor, channel, recipient, subject and body. */
export function contentHash(d: Pick<Draft, 'donor_id' | 'channel' | 'recipient' | 'subject' | 'body'>): string {
  return createHash('sha256').update(JSON.stringify([d.donor_id, d.channel, d.recipient, d.subject, d.body])).digest('hex');
}

/** Editing returns an unapproved draft: any change invalidates a prior approval. Sent or logged drafts are history. */
export function editDraft(d: Draft, changes: { subject?: string | null; body?: string }): Draft {
  if (d.status === 'sent' || d.status === 'logged') throw new ApprovalError('Message was already sent or logged');
  const next = { ...d, subject: changes.subject === undefined ? d.subject : changes.subject,
    body: changes.body ?? d.body, status: 'draft' as const, approval: null };
  checkContent(next.channel, next.subject, next.body);
  return next;
}

export function approveDraft(d: Draft, actor: Actor, at: string): Draft {
  if (d.status !== 'draft') throw new ApprovalError('Only an unapproved draft can be approved');
  assertMayAct(actor, d.owner_id);
  instant(at);
  return { ...d, status: 'approved', approval: { hash: contentHash(d), approved_by: actor.member_id, approved_at: at } };
}

/** Exactly the approved content, to the donor's current contact, by someone allowed, with consent. */
function assertSendable(d: Draft, donor: MessageDonor, actor: Actor) {
  if (d.status !== 'approved' || !d.approval || d.approval.hash !== contentHash(d)) {
    throw new ApprovalError('Message must be approved exactly as it will be sent');
  }
  if (donor.id !== d.donor_id) throw new ApprovalError('Message is for a different donor');
  assertContactAllowed(donor);
  assertMayAct(actor, donor.owner_id);
  if (recipientFor(donor, d.channel) !== d.recipient) throw new ApprovalError('Donor contact changed since approval');
}

/**
 * Record a provider delivery outcome. Idempotent on the approval: a repeated call for a sent draft records
 * nothing new. A failed delivery is recorded as failed (not a qualifying contact) and needs a fresh approval.
 */
export function recordDelivery(d: Draft, donor: MessageDonor, actor: Actor,
  result: { outcome: 'delivered' | 'failed'; at: string }): { draft: Draft; communication: Communication | null } {
  if (d.status === 'sent') return { draft: d, communication: null };
  assertSendable(d, donor, actor);
  instant(result.at);
  const delivered = result.outcome === 'delivered';
  return {
    draft: { ...d, status: delivered ? 'sent' : 'failed' },
    communication: { donor_id: d.donor_id, channel: d.channel, actor_id: actor.member_id, sent_at: result.at,
      status: delivered ? 'delivered' : 'failed', approval_hash: d.approval!.hash, qualifying: delivered },
  };
}

/** Log a send the person made themselves (compose link), only after they confirm it actually went out. */
export function recordManualSend(d: Draft, donor: MessageDonor, actor: Actor,
  input: { confirmed: boolean; at: string }): { draft: Draft; communication: Communication | null } {
  if (d.status === 'logged') return { draft: d, communication: null };
  if (input.confirmed !== true) throw new ApprovalError('Please confirm the message was actually sent before logging it');
  assertSendable(d, donor, actor);
  instant(input.at);
  return {
    draft: { ...d, status: 'logged' },
    communication: { donor_id: d.donor_id, channel: d.channel, actor_id: actor.member_id, sent_at: input.at,
      status: 'logged_manual', approval_hash: d.approval!.hash, qualifying: true },
  };
}

/** `mailto:` / `sms:` link that opens the person's own app with the approved text; every part is encoded. */
export function composeLink(d: Draft): string {
  if (d.status !== 'approved' || !d.approval || d.approval.hash !== contentHash(d)) {
    throw new ApprovalError('Message must be approved exactly as it will be sent');
  }
  const enc = encodeURIComponent;
  return d.channel === 'email'
    ? `mailto:${enc(d.recipient)}?subject=${enc(d.subject ?? '')}&body=${enc(d.body)}`
    : `sms:${d.recipient}?body=${enc(d.body)}`;
}
