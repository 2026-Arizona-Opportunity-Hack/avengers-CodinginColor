import { TestBed } from '@angular/core/testing';
import { initializeWorkspace } from './app.config';
import { Api } from './core/api';
import { demoWorkspaceMode } from './core/demo-workspace';
import { Store } from './core/store';
import { buildDemoDataset } from './core/demo-data';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/sign-in'); });
afterEach(() => { vi.unstubAllGlobals(); history.replaceState({}, '', '/'); });

it('enters a synthetic admin workspace before config, Clerk or protected API access', async () => {
  const stale = buildDemoDataset(); stale.donors[0].name = 'Private stale name';
  localStorage.setItem('cadence.dataset', JSON.stringify(stale));
  history.replaceState({}, '', '/sign-in?demo=1');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const api = TestBed.inject(Api), start = vi.spyOn(api, 'start');
  const store = TestBed.inject(Store);
  await initializeWorkspace(store);
  expect(store.signedIn()).toBe(true); expect(store.demoMode()).toBe(true); expect(store.isAdmin()).toBe(true);
  expect(store.live()).toBe(false); expect(store.me().id).toBe('m-ceo');
  expect(store.allDonors().some(d => d.name === 'Private stale name')).toBe(false);
  store.connect({ apiBase: '', clerkPublishableKey: 'pk_test_synthetic' });
  await expect(api.request('/api/v1/me')).rejects.toMatchObject({ status: 401 });
  expect(start).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('switches dummy board identities into scoped board views and back to admin', () => {
  const store = TestBed.inject(Store); store.enableDemo(true);
  const adminCount = store.donors().length;
  const foreign = store.donors().find(d => d.owner_id === 'm-ortiz')!;
  const before = store.sessionEpoch();
  store.setSession('m-bell');
  expect(store.me().id).toBe('m-bell'); expect(store.me().role).toBe('board');
  expect(store.isAdmin()).toBe(false); expect(store.boardMembers().some(m => m.id === 'm-bell')).toBe(true);
  expect(store.donors().length).toBeGreaterThan(0); expect(store.donors().length).toBeLessThan(adminCount);
  expect(store.donors().every(d => d.owner_id === 'm-bell')).toBe(true);
  expect(store.donor(foreign.id)).toBeNull();
  const ownIds = new Set(store.donors().map(d => d.id));
  for (const row of [...store.gifts(), ...store.followUps(), ...store.communications()])
    expect(ownIds.has(row.donor_id)).toBe(true);
  expect(store.historicalDonors().every(d => d.owner_id === 'm-bell')).toBe(true);
  const historicalIds = new Set(store.historicalDonors().map(d => d.id));
  for (const gift of store.ledgerGifts()) expect(historicalIds.has(gift.donor_id)).toBe(true);
  expect(store.drafts().every(d => d.owner_id === 'm-bell' || d.recipient_member_id === 'm-bell')).toBe(true);
  expect(store.sessionEpoch()).toBe(before + 1);
  store.setSession('not-a-member'); expect(store.me().id).toBe('m-bell');
  store.setSession('m-ceo'); expect(store.isAdmin()).toBe(true); expect(store.donors().length).toBe(adminCount);
  expect(store.donor(foreign.id)).not.toBeNull(); expect(store.sessionEpoch()).toBe(before + 2);
});

it('retains persona and signed-out state when the same demo tab reloads', async () => {
  history.replaceState({}, '', '/sign-in?demo=1');
  expect(demoWorkspaceMode()).toBe('enter'); expect(demoWorkspaceMode()).toBe('resume');
  const store = TestBed.inject(Store); store.enableDemo(true); store.setSession('m-ortiz');
  const donorId = store.donors()[0].id;
  expect(await store.updateDonor(donorId, { name: 'Judge edited demo donor' })).toBe(true);
  await store.signOut(); TestBed.tick();
  TestBed.resetTestingModule();
  const restored = TestBed.inject(Store); await initializeWorkspace(restored);
  expect(restored.demoMode()).toBe(true); expect(restored.me().id).toBe('m-ortiz');
  expect(restored.signedIn()).toBe(false);
  expect(restored.donor(donorId)?.name).toBe('Judge edited demo donor');
  restored.resetDemo(); expect(restored.donor(donorId)?.name).not.toBe('Judge edited demo donor');
});

it('leaves demo mode only for explicit live entry, keeping live roles protected', async () => {
  sessionStorage.setItem('cadence.demo-workspace', '1'); history.replaceState({}, '', '/sign-in?demo=0');
  const fetch = vi.fn(async () => new Response(JSON.stringify({ apiBase: '', clerkPublishableKey: 'pk_test_synthetic' }),
    { headers: { 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
  const start = vi.spyOn(TestBed.inject(Api), 'start').mockResolvedValue();
  const store = TestBed.inject(Store); await initializeWorkspace(store);
  expect(fetch).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem('cadence.demo-workspace')).toBeNull();
  expect(store.live()).toBe(true); expect(store.demoMode()).toBe(false); expect(store.isAdmin()).toBe(false);
});

it('Try Now re-enters the central admin dashboard after logout without resetting demo edits', async () => {
  history.replaceState({}, '', '/sign-in?demo=1');
  const store = TestBed.inject(Store); await initializeWorkspace(store);
  store.setSession('m-bell');
  const donorId = store.donors()[0].id;
  await store.updateDonor(donorId, { name: 'Retained judge edit' });
  await store.signOut(); TestBed.tick();
  TestBed.resetTestingModule();
  const signedOut = TestBed.inject(Store); await initializeWorkspace(signedOut);
  expect(signedOut.signedIn()).toBe(false);
  history.replaceState({}, '', '/sign-in?demo=1&next=/donors');
  await initializeWorkspace(signedOut);
  expect(location.pathname + location.search).toBe('/');
  expect(signedOut.signedIn()).toBe(true); expect(signedOut.isAdmin()).toBe(true);
  expect(signedOut.me().id).toBe('m-ceo');
  expect(signedOut.donor(donorId)?.name).toBe('Retained judge edit');
});
