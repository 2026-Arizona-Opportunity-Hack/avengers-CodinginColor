import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { APP_ICONS } from './core/icons';
import { personalizeDraft } from './core/draft-personalization';
import { buildDemoDataset } from './core/demo-data';
import { Store } from './core/store';
import { OutreachPage } from './pages/outreach';

const asOf = '2026-11-15T23:00:00Z';
const template = { id: 'test', name: 'Test', purpose: 'thank_you' as const, channel: 'email' as const,
  subject: '{{first_name}}', body: '{{gift_context}}\n\n{{history_context}}\n\n{{interest_context}}\n\n{{program_facts}}' };
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

it('scopes gift, structured interest, communication metadata and approved program facts to the selected donor', () => {
  const data = buildDemoDataset(); const [a, b] = data.donors;
  a.custom['interests'] = 'AI Academy'; b.custom['interests'] = 'Summer Camp';
  data.gifts = [{ ...data.gifts[0], donor_id: a.id, amount_cents: 12345, refund_cents: 2344,
    currency: 'CAD', status: 'settled', occurred_at: '2026-11-10T12:00:00-07:00', campaign_id: 'c-ai26' },
  { ...data.gifts[0], donor_id: b.id, amount_cents: 99999, occurred_at: '2026-11-14T12:00:00-07:00' }];
  data.communications = [{ ...data.communications[0], donor_id: a.id, kind: 'call', direction: 'inbound',
    body: 'PRIVATE promise to double gift', occurred_at: '2026-11-12T12:00:00-07:00' },
  { ...data.communications[0], donor_id: b.id, body: 'OTHER DONOR', occurred_at: '2026-11-14T12:00:00-07:00' }];
  data.outcomes.push({ program_id: 'p-ai', year: 2026, metric: 'SECRET', value: 999, approved: false });
  const result = personalizeDraft(template, a, data, {}, asOf);
  expect(result.subject).toBe(a.name.split(' ')[0]);
  expect(result.body).toContain('CA$100.01 net gift on November 10, 2026 to AI Academy Fund 2026');
  expect(result.body).toContain('your call on November 12, 2026');
  expect(result.body).toContain('AI Academy as a program interest');
  expect(result.body).toContain('AI Academy (2026), program-wide: Students enrolled: 71');
  expect(result.body).not.toMatch(/PRIVATE|OTHER DONOR|SECRET|Summer Camp|999/);
  expect(personalizeDraft(template, b, data, {}, asOf).body).not.toContain('your call on November 12');
  data.gifts[0].currency = 'USD';
  expect(personalizeDraft(template, a, data, {}, asOf).body).toContain('$100.01 net gift');
});

it('ignores pending, void, fully refunded and future gifts, internal notes and failed messages', () => {
  const data = buildDemoDataset(); const donor = data.donors[0];
  const gift = { ...data.gifts[0], donor_id: donor.id };
  data.gifts = [{ ...gift, status: 'pending' }, { ...gift, status: 'void' },
    { ...gift, refund_cents: gift.amount_cents }, { ...gift, occurred_at: '2027-01-01T00:00:00Z' }];
  data.communications = [{ ...data.communications[0], donor_id: donor.id, direction: 'internal' },
    { ...data.communications[0], donor_id: donor.id, status: 'failed' }];
  donor.custom = { interests: 'PRIVATE arbitrary prose' };
  expect(personalizeDraft(template, donor, data, {}, asOf).body.trim())
    .toBe('Thank you for staying connected with Coding in Color.');
});

it('personalizes fresh seed examples with the same helper and retains sent history', () => {
  const data = buildDemoDataset(); const drafts = data.drafts.filter((d) => d.status === 'pending');
  expect(drafts.length).toBeGreaterThan(1);
  expect(new Set(drafts.map((d) => d.body)).size).toBe(drafts.length);
  for (const draft of drafts) {
    const donor = data.donors.find((d) => d.id === draft.donor_id)!;
    expect(draft.body).toContain('net gift on');
    expect(draft.body).toContain('program interest');
    expect(draft.body).not.toMatch(/{{|largest event|report is attached|will send/);
    expect(draft.status).toBe('pending'); expect(draft.approved_by).toBeNull();
    expect(data.communications.some((c) => c.donor_id === donor.id && c.body.startsWith('Fictional demo'))).toBe(true);
  }
  expect(data.drafts.some((d) => d.status === 'sent')).toBe(true);
});

it('keeps saved user drafts unchanged on load and personalizes newly created drafts', async () => {
  const data = buildDemoDataset(); const draft = data.drafts.find((d) => d.status === 'pending')!;
  draft.body = 'My saved wording'; localStorage.setItem('cadence.dataset', JSON.stringify(data));
  const store = TestBed.inject(Store); store.enableDemo(false); store.signInDemo('m-ceo');
  expect(store.drafts().find((d) => d.id === draft.id)?.body).toBe('My saved wording');
  const created = await store.createDraft(draft.donor_id!, 't-thanks-email', 'Test');
  expect(created?.body).toContain('net gift on'); expect(created?.body).toContain('program interest');
  expect(created?.status).toBe('pending');
});

it('respects an edited template when creating a regular draft', async () => {
  const data = buildDemoDataset(); const template = data.templates.find((t) => t.id === 't-thanks-email')!;
  template.subject = 'Custom subject {{first_name}}'; template.body = 'My custom template wording';
  localStorage.setItem('cadence.dataset', JSON.stringify(data));
  const store = TestBed.inject(Store); store.enableDemo(false); store.signInDemo('m-ceo');
  const draft = await store.createDraft(data.donors[0].id, template.id, 'Custom template');
  expect(draft?.subject).toBe(`Custom subject ${data.donors[0].name.split(' ')[0]}`);
  expect(draft?.body).toBe('My custom template wording');
});

it('explicitly regenerates persisted old drafts, clears approval, and preserves records and scope', async () => {
  const data = buildDemoDataset();
  for (const t of data.templates) t.body = 'Old generic fixture template';
  const pending = data.drafts.find((d) => d.status === 'pending')!;
  pending.body = 'User edited copy'; pending.status = 'approved';
  pending.approved_by = 'm-ceo'; pending.approved_at = asOf;
  const sent = data.drafts.find((d) => d.status === 'sent')!;
  const beforeSent = JSON.stringify(sent); const beforeLedger = JSON.stringify(data.gifts);
  localStorage.setItem('cadence.dataset', JSON.stringify(data));
  const store = TestBed.inject(Store); store.enableDemo(false); store.signInDemo('m-ceo');
  expect(store.drafts().find((d) => d.id === pending.id)?.body).toBe('User edited copy');
  expect(await store.regenerateDraft(pending.id)).toBe(true);
  const regenerated = store.drafts().find((d) => d.id === pending.id)!;
  expect(regenerated).toMatchObject({ id: pending.id, to: pending.to, owner_id: pending.owner_id,
    donor_id: pending.donor_id, status: 'pending', approved_by: null, approved_at: null });
  expect(regenerated.body).toContain('net gift on');
  expect(await store.regenerateDraft(sent.id)).toBe(false);
  expect(JSON.stringify(store.drafts().find((d) => d.id === sent.id))).toBe(beforeSent);
  expect(JSON.stringify(store.gifts())).toBe(beforeLedger);
  store.setSession(data.members.find((m) => m.role === 'board' && m.id !== pending.owner_id)!.id);
  expect(await store.regenerateDraft(pending.id)).toBe(false);
});

it('allows editing approved unsent copy and requires approval again after saving through the UI', async () => {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideIcons(APP_ICONS)] });
  const store = TestBed.inject(Store); store.enableDemo(true);
  const fixture = TestBed.createComponent(OutreachPage); fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const button = (label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
  button('Approve').click(); await fixture.whenStable(); fixture.detectChanges();
  const id = store.drafts().find((d) => d.status === 'approved')!.id;
  expect(root.textContent).toContain('Open in');
  button('Edit').click(); fixture.detectChanges();
  expect(root.querySelector('a[href^="mailto:"]')).toBeNull();
  const textarea = root.querySelector('textarea')!; textarea.value = 'Reviewed and changed';
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await fixture.whenStable(); fixture.detectChanges();
  const edited = store.drafts().find((d) => d.id === id)!;
  expect(edited).toMatchObject({ body: 'Reviewed and changed', status: 'pending', approved_by: null, approved_at: null });
  expect(root.querySelector('a[href^="mailto:"]')).toBeNull();
  expect(button('Approve')).toBeDefined();
  fixture.destroy();
});
