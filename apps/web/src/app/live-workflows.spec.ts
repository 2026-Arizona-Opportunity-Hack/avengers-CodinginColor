import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Api, ApiError, type LiveStatus } from './core/api';
import { Store } from './core/store';

const donor = { id: 'donor', org_id: 'org', owner_id: 'board', name: 'Synthetic Donor',
  email: 'synthetic@example.org', phone: null, consent: 'granted', metadata: {}, archived_at: null };
const task = { id: 'task', donor_id: 'donor', owner_id: 'board', kind: 'next_action', title: 'Call',
  status: 'open', due_at: '2026-11-15T07:00:00Z' };

function session(role: 'board' | 'admin' = 'admin') {
  let onOut!: () => void;
  const api = {
    status: signal<LiveStatus>('signed-out'), error: signal<string | null>(null),
    start: async (_config: unknown, _onIn: unknown, out: () => void) => { onOut = out; },
    me: vi.fn(async () => ({ id: role === 'admin' ? 'admin' : 'board', org_id: 'org', role })),
    allDonors: vi.fn(async () => [donor]),
    request: vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
      if (path === '/api/v1/owners') return { items: [{id:'board'}, {id:'empty-owner'}] };
      if (path === '/api/v1/catalog') return { programs: [], campaigns: [] };
      if (path.includes('/follow-ups?')) return { overdue: [task], due_this_week: [], upcoming: [] };
      if (path === '/api/v1/api-keys' && init?.method === 'POST')
        return { id: 'key', name: 'Dashboard', hint: 'cic_hint', key: 'one-time-secret' };
      if (path.endsWith('/revoke')) return { id: 'key', revoked_at: '2026-11-15T20:00:00Z' };
      return { items: [] };
    }),
    fail: (message: string) => { api.error.set(message); api.status.set('error'); },
  };
  TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: api }] });
  const store = TestBed.inject(Store);
  store.connect({ apiBase: '', clerkPublishableKey: 'synthetic' });
  return { store, api, signOut: () => { onOut(); api.status.set('signed-out'); } };
}

describe('live workspace data and keys', () => {
  it('loads zero-donor owners for admins and refreshes donor ownership after a real reassignment', async () => {
    const { store, api } = session(); await store.refreshLive();
    expect(store.boardMembers().map(m => m.id)).toEqual(['board', 'empty-owner']);
    api.request.mockResolvedValueOnce({ id: 'donor', owner_id: 'empty-owner' });
    api.request.mockResolvedValueOnce({ ...donor, owner_id: 'empty-owner' });
    expect(await store.reassign('donor', 'empty-owner')).toBe(true);
    expect(api.request).toHaveBeenCalledWith('/api/v1/donors/donor/owner', expect.objectContaining({body:'{"owner_id":"empty-owner"}'}));
    expect(store.donor('donor')?.owner_id).toBe('empty-owner');
    api.request.mockRejectedValueOnce(new ApiError(403));
    expect(await store.reassign('donor', 'board')).toBe(false);
    expect(store.donor('donor')?.owner_id).toBe('empty-owner');
  });
  it('loads actual history, separates currencies and persists a contact before reloading its timeline', async () => {
    const { store, api } = session('board');
    let logged = false;
    api.request.mockImplementation(async (path, init) => {
      if (path === '/api/v1/catalog') return { programs: [{ id: 'program', title: 'Academy' }],
        campaigns: [{ id: 'campaign', title: 'Annual', program_id: 'program' }] };
      if (path.startsWith('/api/v1/gifts?')) return { items: [
        { id: 'gift-usd', donor_id: 'donor', amount_cents: 1234, refund_cents: 100, currency: 'USD', status: 'settled', source: 'zeffy', campaign_id: 'campaign' },
        { id: 'gift-eur', donor_id: 'donor', amount_cents: 700, refund_cents: 0, currency: 'EUR', status: 'settled', source: 'benevity', campaign_id: null },
      ] };
      if (path.startsWith('/api/v1/communications?')) return { items: logged ? [{ id: 'contact', donor_id: 'donor',
        draft_id: null, channel: 'sms', status: 'logged_contact', actor_id: 'board', occurred_at: '2026-11-15T19:00:00Z',
        note: 'Visited class\nWants an update', subject: null, body: null }] : [] };
      if (path.endsWith('/donor/communications')) { logged = true; expect(JSON.parse(String(init?.body)).channel).toBe('sms'); }
      if (path.includes('/follow-ups?')) return { overdue: [], due_this_week: [], upcoming: [] };
      return { items: [] };
    });
    await store.refreshLive();
    expect(store.lifetime('donor')).toBe(1134);
    expect(store.currencies()).toEqual(['EUR', 'USD']);
    store.selectedCurrency.set('EUR'); expect(store.lifetime('donor')).toBe(700);
    expect(store.campaign('campaign')?.title).toBe('Annual');
    expect(await store.logCommunication({ donor_id: 'donor', kind: 'text', summary: 'Visited class',
      body: 'Wants an update', occurred_at: '2026-11-15T12:00:00-07:00' })).toBe(true);
    expect(store.communicationsFor('donor')[0]?.kind).toBe('text');
    expect(store.communicationsFor('donor')[0]?.body).toContain('Wants an update');
    api.request.mockRejectedValueOnce(new ApiError(403));
    expect(await store.logCommunication({ donor_id: 'donor', kind: 'call', summary: 'Call', body: '', occurred_at: '2026-11-15T12:00:00-07:00' })).toBe(false);
  });
  it('loads the board queue without requesting admin keys', async () => {
    const { store, api } = session('board');
    await store.refreshLive();
    expect(store.followUps()[0]?.due_on).toBe('2026-11-15');
    expect(api.request).toHaveBeenCalledWith('/api/v1/follow-ups?scope=mine', undefined);
    expect(api.request.mock.calls.some(([path]) => path.includes('api-keys'))).toBe(false);
    expect(await store.createApiKey('forbidden')).toBeNull();
  });

  it('issues and revokes a real key without storing its secret in the dataset', async () => {
    const { store, api } = session();
    await store.refreshLive();
    expect(api.request).toHaveBeenCalledWith('/api/v1/follow-ups?scope=all', undefined);
    expect(await store.createApiKey('Dashboard')).toBe('one-time-secret');
    expect(JSON.stringify(store.apiKeys())).not.toContain('one-time-secret');
    expect(await store.revokeApiKey('key')).toBe(true);
    expect(store.apiKeys()[0]?.revoked_at).toBe('2026-11-15T20:00:00Z');
  });

  it('reports failed issuance without returning a pretend key', async () => {
    const { store, api } = session();
    await store.refreshLive();
    api.request.mockRejectedValueOnce(new ApiError(403));
    expect(await store.createApiKey('Dashboard')).toBeNull();
    expect(store.apiKeys()).toEqual([]);
    expect(store.notice()).toBe('You do not have access to that.');
  });

  it('drops a key response and old errors after sign-out', async () => {
    const { store, api, signOut } = session();
    await store.refreshLive();
    let resolve!: (value: unknown) => void;
    api.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = store.createApiKey('Dashboard');
    signOut();
    resolve({ id: 'key', name: 'Dashboard', hint: 'cic_hint', key: 'late-secret' });
    expect(await pending).toBeNull();
    expect(store.apiKeys()).toEqual([]);
    expect(store.notice()).toBeNull();
  });

  it('drops queued data arriving after sign-out', async () => {
    const { store, api, signOut } = session();
    let resolve!: (value: unknown) => void;
    api.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = store.refreshLive();
    await Promise.resolve(); await Promise.resolve();
    signOut();
    resolve({ overdue: [task], due_this_week: [], upcoming: [] });
    await pending;
    expect(store.followUps()).toEqual([]);
    expect(store.members()).toEqual([]);
    expect(api.status()).toBe('signed-out');
  });

  it('persists drafts and never substitutes a local draft after server rejection', async () => {
    const { store, api } = session('board');
    await store.refreshLive();
    api.request.mockImplementationOnce(async (_path, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ donor_id: 'donor', template: 'thank_you' });
      return { id: 'draft', donor_id: 'donor', owner_id: 'board', author_id: 'board', channel: 'email',
        recipient: donor.email, subject: 'Thank you', body: 'Reviewed template', status: 'draft', created_at: '2026-11-15T12:00:00Z' };
    });
    expect((await store.createDraft('donor', 't-thanks-email', 'Manual'))?.id).toBe('draft');
    api.request.mockRejectedValueOnce(new ApiError(409));
    expect(await store.createDraft('donor', 't-thanks-email', 'Manual')).toBeNull();
    expect(store.notice()).toBeTruthy();
  });

  it('waits for real draft, compose, task and send results', async () => {
    const { store, api } = session('board');
    await store.refreshLive();
    expect(await store.editDraft('draft', { subject: 'Edited', body: 'Exact new text' })).toBe(true);
    expect(api.request).toHaveBeenCalledWith('/api/v1/drafts/draft', expect.objectContaining({ method: 'PATCH' }));
    expect(await store.approveDraft('draft')).toBe(true);
    expect(api.request).toHaveBeenCalledWith('/api/v1/drafts/draft/approve', expect.objectContaining({ method: 'POST' }));
    api.request.mockResolvedValueOnce({ href: 'mailto:synthetic@example.org?body=Approved' });
    expect(await store.composeDraft('draft')).toContain('mailto:');
    expect(await store.markSent('draft')).toBe(true);
    expect(api.request).toHaveBeenCalledWith('/api/v1/drafts/draft/manual-send',
      expect.objectContaining({ body: '{"confirmed":true}' }));
    expect(await store.setFollowUpStatus('task', 'done')).toBe(true);
    api.request.mockRejectedValueOnce(new ApiError(403));
    expect(await store.approveDraft('draft')).toBe(false);
    expect(store.notice()).toBe('You do not have access to that.');
  });

  it('does not restore outreach after a write completes following sign-out', async () => {
    const { store, api, signOut } = session('board');
    await store.refreshLive();
    let resolve!: (value: unknown) => void;
    api.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = store.approveDraft('draft');
    signOut(); resolve({ status: 'approved' });
    expect(await pending).toBe(false);
    expect(store.followUps()).toEqual([]);
    expect(store.drafts()).toEqual([]);
    expect(store.notice()).toBeNull();
  });

  it('uses the server quarter format and creates next steps at Phoenix time', async () => {
    const { store, api } = session();
    await store.refreshLive();
    api.request.mockImplementationOnce(async (_path, init) => {
      expect(JSON.parse(String(init?.body)).quarter).toMatch(/^\d{4}-Q[1-4]$/);
      return { created: 2, skipped: {} };
    });
    expect(await store.generateQuarterly('t-quarterly')).toBe(2);
    await store.addFollowUp({ donor_id: 'donor', action: 'Call', due_on: '2026-11-15' });
    expect(api.request).toHaveBeenCalledWith('/api/v1/follow-ups',
      expect.objectContaining({ body: '{"donor_id":"donor","title":"Call","due_at":"2026-11-15T09:00:00-07:00"}' }));
  });

  it('does not let an older outreach reload restore a task completed by a newer write', async () => {
    const { store, api } = session('board');
    await store.refreshLive();
    let resolveOld!: (value: unknown) => void;
    let started!: () => void;
    const oldStarted = new Promise<void>((resolve) => { started = resolve; });
    let reads = 0;
    api.request.mockImplementation(async (path) => {
      if (path === '/api/v1/catalog') return { programs: [], campaigns: [] };
      if (path.includes('/follow-ups?')) {
        if (++reads === 1) { started(); return new Promise((resolve) => { resolveOld = resolve; }); }
        return { overdue: [], due_this_week: [], upcoming: [] };
      }
      return { items: [] };
    });
    const older = store.setFollowUpStatus('first', 'done');
    await oldStarted;
    expect(await store.setFollowUpStatus('second', 'done')).toBe(true);
    expect(store.followUps()).toEqual([]);
    resolveOld({ overdue: [task], due_this_week: [], upcoming: [] });
    expect(await older).toBe(true);
    expect(store.followUps()).toEqual([]);
  });

  it('keeps a newer outreach snapshot when an older full refresh finishes', async () => {
    const { store, api } = session('board');
    await store.refreshLive();
    const epoch = store.sessionEpoch();
    let resolveOld!: (value: unknown) => void;
    let started!: () => void;
    const oldStarted = new Promise<void>((resolve) => { started = resolve; });
    let reads = 0;
    api.request.mockImplementation(async (path) => {
      if (path === '/api/v1/catalog') return { programs: [], campaigns: [] };
      if (path.includes('/follow-ups?')) {
        if (++reads === 1) { started(); return new Promise((resolve) => { resolveOld = resolve; }); }
        return { overdue: [], due_this_week: [], upcoming: [] };
      }
      return { items: [] };
    });
    const older = store.refreshLive();
    await oldStarted;
    expect(await store.setFollowUpStatus('task', 'done')).toBe(true);
    resolveOld({ overdue: [task], due_this_week: [], upcoming: [] });
    await older;
    expect(store.followUps()).toEqual([]);
    expect(store.sessionEpoch()).toBe(epoch);
  });
});
