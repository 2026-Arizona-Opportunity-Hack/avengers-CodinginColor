import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { Api, ApiRetention, LiveStatus } from './core/api';
import { Store } from './core/store';
import { RetentionPage } from './pages/retention';
import { Shell } from './shell/shell';
import { APP_ICONS } from './core/icons';

/** A controllable stand-in for the live API: the test decides when the report arrives. */
class FakeApi {
  readonly status = signal<LiveStatus>('ready');
  readonly error = signal<string | null>(null);
  resolveReport!: (r: ApiRetention) => void;
  retention = vi.fn(() => new Promise<ApiRetention>((resolve) => { this.resolveReport = resolve; }));
  signOut = vi.fn(async () => { this.status.set('signed-out'); });
  canRetry() { return true; }
  mountSignIn() {}
  unmountSignIn() {}
}

const REPORT: ApiRetention = {
  as_of: '2026-11-15',
  windows: { current: { from: '2026-01-01T00:00:00-07:00', to: '2026-11-16T00:00:00-07:00' }, prior: { from: '2025-01-01T00:00:00-07:00', to: '2025-11-16T00:00:00-07:00' } },
  byCurrency: { USD: {
    donors: [{ donor_id: 'd1', segment: 'lapsed', prior_cents: 5000, current_cents: 0, name: 'Secret Donor' }],
    segments: { lapsed: { donors: 1, prior_cents: 5000, current_cents: 0 } },
    retention: { retained_donors: 0, prior_donors: 1 },
    totals: { prior_cents: 5000, current_cents: 0 },
  } },
};

function liveSession() {
  TestBed.configureTestingModule({ providers: [{ provide: Api, useClass: FakeApi }, provideRouter([]), provideIcons(APP_ICONS)] });
  const api = TestBed.inject(Api) as unknown as FakeApi;
  const store = TestBed.inject(Store);
  store.live.set(true);
  return { api, store };
}

function pendingLiveRefresh() {
  const member = { id: 'board-owner', org_id: 'org', role: 'board' as const };
  let resolveMember!: (value: typeof member) => void;
  let rejectMember!: (reason: Error) => void;
  let onSignedOut!: () => void;
  const oldMember = new Promise<typeof member>((resolve, reject) => { resolveMember = resolve; rejectMember = reject; });
  const api = {
    status: signal<LiveStatus>('signed-out'), error: signal<string | null>(null),
    start: async (_config: unknown, _onIn: () => void, onOut: () => void) => { onSignedOut = onOut; },
    me: vi.fn(() => oldMember), allDonors: vi.fn(async () => []),
    request: vi.fn(async (path: string) => path.includes('follow-ups')
      ? { overdue: [], due_this_week: [], upcoming: [] } : path === '/api/v1/catalog' ? { programs: [], campaigns: [] } : { items: [] }),
    fail: (message: string) => { api.error.set(message); api.status.set('error'); },
  };
  TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: api }] });
  const store = TestBed.inject(Store);
  store.connect({ apiBase: '', clerkPublishableKey: 'synthetic' });
  return { api, store, member, resolveMember, rejectMember,
    signOut: () => { onSignedOut(); api.status.set('signed-out'); } };
}

describe('live session loss', () => {
  it('does not restore a session when its initial data request finishes after sign-out', async () => {
    const f = pendingLiveRefresh();
    const pending = f.store.refreshLive();
    f.signOut(); f.resolveMember(f.member);
    await pending;
    expect(f.api.status()).toBe('signed-out');
    expect(f.store.signedIn()).toBe(false);
    expect(f.store.members()).toEqual([]);
  });

  it('does not let an old request failure overwrite a newer successful session', async () => {
    const f = pendingLiveRefresh();
    const pending = f.store.refreshLive();
    f.signOut();
    f.api.me.mockResolvedValue(f.member);
    await f.store.refreshLive();
    f.rejectMember(new Error('Old request failed'));
    await pending;
    expect(f.api.status()).toBe('ready');
    expect(f.store.me().id).toBe(f.member.id);
    expect(f.api.error()).toBeNull();
  });
  beforeAll(() => {
    // jsdom has no layout; the command palette's list calls this when it opens.
    Element.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    TestBed.overrideComponent(RetentionPage, { set: { template: '' } });
  });

  it('clears a populated retention report when the session ends', async () => {
    const { api, store } = liveSession();
    const page = TestBed.createComponent(RetentionPage).componentInstance as unknown as Record<string, () => unknown>;
    api.resolveReport(REPORT);
    await Promise.resolve(); await Promise.resolve();
    expect(page['server']()).not.toBeNull();
    expect((page['serverNames']() as Map<string, string>).get('d1')).toBe('Secret Donor');

    api.status.set('signed-out');
    TestBed.tick();

    expect(store.signedIn()).toBe(false);
    expect(page['server']()).toBeNull();
    expect((page['serverNames']() as Map<string, string>).size).toBe(0);
  });

  it('drops a report that arrives after sign-out', async () => {
    const { api, store } = liveSession();
    const page = TestBed.createComponent(RetentionPage).componentInstance as unknown as Record<string, () => unknown>;
    expect(api.retention).toHaveBeenCalledTimes(1);

    await store.signOut();
    TestBed.tick();
    api.resolveReport(REPORT);
    await Promise.resolve(); await Promise.resolve();

    expect(page['server']()).toBeNull();
    expect((page['serverNames']() as Map<string, string>).size).toBe(0);
  });

  it('removes protected views and returns to sign-in when the session ends', async () => {
    const { api } = liveSession();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('main router-outlet')).not.toBeNull();

    api.status.set('signed-out');
    TestBed.tick();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('main router-outlet')).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/sign-in'], expect.objectContaining({ queryParams: expect.any(Object) }));
  });
});
