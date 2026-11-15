import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApprovalError, TEMPLATES, approveDraft, composeLink, contentHash, createDraft, editDraft,
  recordDelivery, recordManualSend, renderTemplate, type Actor, type Draft,
} from './messages.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const OWNER = id(100), OTHER = id(101), ADMIN = id(102), DONOR = id(1);
const owner: Actor = { member_id: OWNER, role: 'board' };
const other: Actor = { member_id: OTHER, role: 'board' };
const admin: Actor = { member_id: ADMIN, role: 'admin' };
const donor = { id: DONOR, owner_id: OWNER, consent: 'granted' as const, email: 'avery@example.org', phone: '602-555-0100' };
const AT = '2026-11-14T12:00:00-07:00';

const thanks = () => createDraft({ donor, channel: 'email', template: 'thank_you',
  fields: { first_name: 'Avery', amount: '$50.00', program: 'AI Academy' } });

test('templates render only allowlisted fields, as plain text, and refuse gaps', () => {
  const body = renderTemplate(TEMPLATES.thank_you.body, { first_name: 'Avery', amount: '$50.00', program: 'AI Academy' });
  assert.match(body, /^Hi Avery,/);
  assert.match(body, /\$50\.00/);
  assert.throws(() => renderTemplate('Hi {{first_name}} {{ssn}}', { first_name: 'A' }), /Unknown field: ssn/);
  assert.throws(() => renderTemplate(TEMPLATES.thank_you.body, { first_name: 'Avery', amount: '$50.00' }), /Missing field: program/);
  // Control characters and markup in values are neutralized, not rendered.
  assert.equal(renderTemplate('Hi {{first_name}}', { first_name: 'A\u0000\u0007<b>' }), 'Hi A<b>');
});

test('the quarterly update omits its impact line unless an approved metric is supplied', () => {
  const plain = renderTemplate(TEMPLATES.quarterly_update.body, { first_name: 'Avery', program: 'AI Academy' });
  assert.ok(!/\{\{|impact|students/i.test(plain), plain);
  const withImpact = renderTemplate(TEMPLATES.quarterly_update.body,
    { first_name: 'Avery', program: 'AI Academy', impact: '42 students completed AI Academy this fall' });
  assert.match(withImpact, /42 students completed AI Academy this fall/);
});

test('approval binds the exact content, and any edit invalidates it', () => {
  const draft = thanks();
  const approved = approveDraft(draft, owner, AT);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approval?.hash, contentHash(approved));
  assert.equal(approved.approval?.approved_by, OWNER);
  const edited = editDraft(approved, { body: approved.body + ' Thanks again!' });
  assert.equal(edited.status, 'draft');
  assert.equal(edited.approval, null);
  // Tampering with content without going through editDraft is caught at send time.
  const tampered: Draft = { ...approved, body: 'Different text' };
  assert.throws(() => recordDelivery(tampered, donor, owner, { outcome: 'delivered', at: AT }), ApprovalError);
  assert.throws(() => recordManualSend(tampered, donor, owner, { confirmed: true, at: AT }), ApprovalError);
});

test('board members act only on their own donors; admins on any; consent denied blocks approval and sending', () => {
  assert.throws(() => approveDraft(thanks(), other, AT), /not this donor's owner/);
  assert.equal(approveDraft(thanks(), admin, AT).status, 'approved');
  const approved = approveDraft(thanks(), owner, AT);
  assert.throws(() => recordManualSend(approved, donor, other, { confirmed: true, at: AT }), /not this donor's owner/);
  const denied = { ...donor, consent: 'denied' as const };
  assert.throws(() => createDraft({ donor: denied, channel: 'email', template: 'thank_you',
    fields: { first_name: 'A', amount: '$1', program: 'P' } }), /declined contact/);
  assert.throws(() => recordManualSend(approved, denied, owner, { confirmed: true, at: AT }), /declined contact/);
});

test('a repeated send records one delivery; a failed delivery is never "sent"', () => {
  const approved = approveDraft(thanks(), owner, AT);
  const first = recordDelivery(approved, donor, owner, { outcome: 'delivered', at: AT });
  assert.equal(first.draft.status, 'sent');
  assert.equal(first.communication?.status, 'delivered');
  const again = recordDelivery(first.draft, donor, owner, { outcome: 'delivered', at: '2026-11-14T12:05:00-07:00' });
  assert.equal(again.communication, null);            // nothing new recorded
  assert.deepEqual(again.draft, first.draft);
  const failed = recordDelivery(approved, donor, owner, { outcome: 'failed', at: AT });
  assert.equal(failed.draft.status, 'failed');
  assert.equal(failed.communication?.status, 'failed');
  assert.equal(failed.communication?.qualifying, false);
  assert.throws(() => recordDelivery(thanks(), donor, owner, { outcome: 'delivered', at: AT }), /approved/);
});

test('manual sends are logged only after a human confirms, and count as a qualifying contact', () => {
  const approved = approveDraft(createDraft({ donor, channel: 'sms', template: 'thank_you_sms',
    fields: { first_name: 'Avery', program: 'AI Academy' } }), owner, AT);
  assert.throws(() => recordManualSend(approved, donor, owner, { confirmed: false, at: AT }), /confirm/);
  const logged = recordManualSend(approved, donor, owner, { confirmed: true, at: AT });
  assert.equal(logged.draft.status, 'logged');
  assert.deepEqual(logged.communication, { donor_id: DONOR, channel: 'sms', actor_id: OWNER, sent_at: AT,
    status: 'logged_manual', approval_hash: approved.approval!.hash, qualifying: true });
  assert.throws(() => editDraft(logged.draft, { body: 'x' }), /already/);
  assert.equal(recordManualSend(logged.draft, donor, owner, { confirmed: true, at: AT }).communication, null);
});

test('compose links are encoded and cannot inject headers or recipients', () => {
  const approved = approveDraft(thanks(), owner, AT);
  const mail = composeLink(approved);
  assert.ok(mail.startsWith('mailto:avery%40example.org?subject='), mail);
  assert.ok(!/[\r\n]/.test(mail) && !/[?&](cc|bcc|to)=/i.test(mail), mail);
  assert.match(decodeURIComponent(mail.split('body=')[1]), /^Hi Avery,/);
  const sms = composeLink(approveDraft(createDraft({ donor, channel: 'sms', template: 'thank_you_sms',
    fields: { first_name: 'Avery', program: 'AI Academy' } }), owner, AT));
  assert.match(sms, /^sms:\+?6025550100\?body=/);
  assert.throws(() => createDraft({ donor: { ...donor, email: 'a@example.org?bcc=x@evil.test' }, channel: 'email',
    template: 'thank_you', fields: { first_name: 'A', amount: '$1', program: 'P' } }), /recipient/);
  assert.throws(() => editDraft(thanks(), { subject: 'Hi\r\nBcc: x@evil.test' }), /subject/);
});
