import { TestBed } from '@angular/core/testing';
import { buildDemoDataset } from './core/demo-data';
import { Store } from './core/store';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

it('hands off pending donor drafts and open tasks without rewriting sent history or member digests', async () => {
  const store = TestBed.inject(Store); store.enableDemo(true);
  const donor = store.donors().find(d => d.owner_id === 'm-bell')!;
  const pending = (await store.createDraft(donor.id, 't-thanks-email', 'handoff regression'))!;
  const sent = (await store.createDraft(donor.id, 't-thanks-email', 'historical regression'))!;
  await store.approveDraft(sent.id); await store.markSent(sent.id);
  await store.addFollowUp({ donor_id: donor.id, action: 'Handoff open task', due_on: '2026-11-20' });
  store.generateDigests();
  const digest = store.drafts().find(d => d.recipient_member_id === 'm-bell')!;
  const sentBefore = { ...store.drafts().find(d => d.id === sent.id)! };
  expect(await store.reassign(donor.id, 'm-ortiz')).toBe(true);
  expect(store.drafts().find(d => d.id === pending.id)?.owner_id).toBe('m-ortiz');
  expect(store.drafts().find(d => d.id === sent.id)).toEqual(sentBefore);
  expect(store.followUps().find(f => f.action === 'Handoff open task')?.owner_id).toBe('m-ortiz');
  store.setSession('m-bell');
  expect(store.donor(donor.id)).toBeNull();
  expect(store.drafts().some(d => d.donor_id === donor.id)).toBe(false);
  expect(store.drafts().some(d => d.id === digest.id)).toBe(true);
  store.setSession('m-ortiz');
  expect(store.drafts().filter(d => d.donor_id === donor.id).map(d => d.id)).toEqual([pending.id, sent.id]);
  expect(store.drafts().some(d => d.id === digest.id)).toBe(false);
  store.setSession('m-ceo');
  expect(store.drafts().some(d => d.id === digest.id)).toBe(true);
  expect(store.drafts().find(d => d.id === sent.id)).toEqual(sentBefore);
});

it('scopes restored stale-owner donor drafts by current donor access', () => {
  const data = buildDemoDataset();
  const draft = data.drafts.find(d => d.donor_id && d.owner_id === 'm-bell')!;
  data.donors.find(d => d.id === draft.donor_id)!.owner_id = 'm-ortiz';
  localStorage.setItem('cadence.dataset', JSON.stringify(data));
  const store = TestBed.inject(Store); store.enableDemo(false);
  store.setSession('m-bell'); expect(store.drafts().some(d => d.id === draft.id)).toBe(false);
  store.setSession('m-ortiz'); expect(store.drafts().some(d => d.id === draft.id)).toBe(true);
  store.setSession('m-ceo'); expect(store.drafts().some(d => d.id === draft.id)).toBe(true);
});
