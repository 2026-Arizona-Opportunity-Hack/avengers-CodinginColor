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
  expect(store.signedIn()).toBe(true); expect(store.demoAdmin()).toBe(true); expect(store.isAdmin()).toBe(true);
  expect(store.live()).toBe(false); expect(store.me().id).toBe('m-ceo');
  expect(store.allDonors().some(d => d.name === 'Private stale name')).toBe(false);
  store.connect({ apiBase: '', clerkPublishableKey: 'pk_test_synthetic' });
  await expect(api.request('/api/v1/me')).rejects.toMatchObject({ status: 401 });
  expect(start).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('switches dummy board identities with demo admin access and invalidates pending views', () => {
  const store = TestBed.inject(Store); store.enableDemo(true);
  const before = store.sessionEpoch();
  store.setSession('m-bell');
  expect(store.me().id).toBe('m-bell'); expect(store.me().role).toBe('board');
  expect(store.isAdmin()).toBe(true); expect(store.boardMembers().some(m => m.id === 'm-bell')).toBe(true);
  expect(store.donors().length).toBe(store.allDonors().length); expect(store.sessionEpoch()).toBe(before + 1);
  store.setSession('not-a-member'); expect(store.me().id).toBe('m-bell');
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
  expect(restored.demoAdmin()).toBe(true); expect(restored.me().id).toBe('m-ortiz');
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
  expect(store.live()).toBe(true); expect(store.demoAdmin()).toBe(false); expect(store.isAdmin()).toBe(false);
});
