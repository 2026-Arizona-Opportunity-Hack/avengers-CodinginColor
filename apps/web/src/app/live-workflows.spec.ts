import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Api, ApiError, type LiveStatus } from './core/api';
import { provideRouter, Router } from '@angular/router';
import { GiftEntry } from './pages/gift-entry';
import { DonorNewPage, moneyCents, validGiftDate } from './pages/donor-new';
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


describe('manual donor and gift persistence', () => {
  const input = { name: 'New Donor', email: null, phone: null, company: null,
    kind: 'individual' as const, consent: 'unknown' as const, preferred_channel: 'email' as const, custom: {}, source: 'manual' as const };
  it('parses exact cents and rejects impossible or future gift dates', () => {
    expect(moneyCents('0.29')).toBe(29);
    expect(moneyCents('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of ['0', '-1', '1.001', '1e3', '90071992547409.92']) expect(moneyCents(value)).toBeNull();
    expect(validGiftDate('2024-02-29', '2026-11-15')).toBe(true);
    expect(validGiftDate('2026-02-30', '2026-11-15')).toBe(false);
    expect(validGiftDate('2026-11-16', '2026-11-15')).toBe(false);
  });
  it('honors the server assignment without fetching an inaccessible record', async () => {
    const { store, api } = session('board'); await store.refreshLive();
    api.request.mockResolvedValueOnce({ id: 'new', owner_id: 'other' });
    const before = api.request.mock.calls.length;
    expect(await store.addDonor(input, 'request')).toEqual({ kind: 'saved', value: { id: 'new', owner_id: 'other' } });
    expect(api.request.mock.calls.slice(before)).toHaveLength(1);
    expect(store.donor('new')).toBeNull();
    expect(JSON.parse(String(api.request.mock.calls.at(-1)?.[1]?.body))).toMatchObject({request_id:'request',metadata:{sources:['manual']}});
    api.request.mockRejectedValueOnce(new ApiError(409));
    expect(await store.addDonor(input, 'request')).toEqual({kind:'retry'});
  });
  it('drops a delayed donor response after sign out', async () => {
    const { store, api, signOut } = session(); await store.refreshLive();
    let resolve!: (value: unknown) => void;
    api.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = store.addDonor(input, 'request'); signOut(); resolve({ id: 'late', owner_id: 'board' });
    expect(await pending).toEqual({kind:'retry'}); expect(store.allDonors()).toEqual([]);
  });
  it('retries only the first gift after a partial failure using the same external ID', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const { store, api } = session(); await store.refreshLive();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(DonorNewPage); fixture.detectChanges();
    const set = (name: string, value: string) => {
      const field = fixture.nativeElement.querySelector(`[name="${name}"]`) as HTMLInputElement;
      field.value = value; field.dispatchEvent(new Event('input')); fixture.detectChanges();
    };
    set('first', 'Avery'); set('amount', '0.29');
    api.request.mockResolvedValueOnce({ id: 'new', owner_id: 'board' });
    api.request.mockResolvedValueOnce({ ...donor, id: 'new', name: 'Avery' });
    api.request.mockRejectedValueOnce(new ApiError(503));
    const submit = async () => { fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', {cancelable:true})); await fixture.whenStable(); fixture.detectChanges(); };
    await submit();
    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Donor saved. The first gift could not be confirmed.');
    const firstGift = api.request.mock.calls.filter(([p, i]) => p === '/api/v1/gifts' && i?.method === 'POST')[0];
    const facts = JSON.parse(String(firstGift[1]?.body));
    expect(facts).toMatchObject({amount_cents:29,refund_cents:0,currency:'USD',status:'settled',donor_id:'new'});
    api.request.mockResolvedValueOnce({ ...facts, id: 'gift', source: 'manual' }); await submit();
    expect(api.request.mock.calls.filter(([p, i]) => p === '/api/v1/donors' && i?.method === 'POST')).toHaveLength(1);
    const gifts = api.request.mock.calls.filter(([p, i]) => p === '/api/v1/gifts' && i?.method === 'POST');
    expect(gifts).toHaveLength(2); expect(gifts[1][1]?.body).toBe(firstGift[1]?.body);
    expect(store.allGifts().filter(g => g.id === 'gift')).toHaveLength(1);
    expect(navigate).toHaveBeenCalledWith(['/donors', 'new']);
  });
});


describe('existing donor gift form', () => {
  it('validates refunds, saves explicit currency/status and clears retry state when the donor changes', async () => {
    const { store, api } = session(); await store.refreshLive();
    const fixture = TestBed.createComponent(GiftEntry);
    fixture.componentRef.setInput('donorId', 'donor'); fixture.detectChanges();
    const set = (name: string, value: string) => {
      const field = fixture.nativeElement.querySelector(`[name="${name}"]`) as HTMLInputElement;
      field.value = value;
    };
    const submit = async () => { fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', {cancelable:true})); await fixture.whenStable(); fixture.detectChanges(); };
    set('amount', '10.29'); set('refund', '11'); set('currency', 'EUR'); set('status', 'pending');
    const before = api.request.mock.calls.length; await submit();
    expect(api.request.mock.calls).toHaveLength(before);
    expect(fixture.nativeElement.textContent).toContain('refund between zero and the amount');
    set('refund', '0.29'); api.request.mockRejectedValueOnce(new ApiError(503)); await submit();
    const facts = JSON.parse(String(api.request.mock.calls.at(-1)?.[1]?.body));
    expect(facts).toMatchObject({ donor_id:'donor',amount_cents:1029,refund_cents:29,currency:'EUR',status:'pending' });
    expect(store.allGifts()).toEqual([]);
    fixture.componentRef.setInput('donorId', 'another-donor'); fixture.detectChanges();
    set('amount', '12'); set('refund', '0');
    api.request.mockImplementationOnce(async (_p, init) => ({...JSON.parse(String(init?.body)),id:'saved',source:'manual'}));
    await submit();
    const next = JSON.parse(String(api.request.mock.calls.at(-1)?.[1]?.body));
    expect(next.donor_id).toBe('another-donor'); expect(next.external_id).not.toBe(facts.external_id);
    expect(store.selectedCurrency()).toBe('EUR');
    expect(store.allGifts()[0]).toMatchObject({id:'saved',amount_cents:1200});
    expect(fixture.nativeElement.textContent).toContain('Gift saved to the timeline.');
  });
});


describe('manual entry rejected payload corrections', () => {
  it('blocks oversized donor facts and malformed grouping, then allows correction after a definitive 400', async () => {
    TestBed.configureTestingModule({providers:[provideRouter([])]});
    const {store, api} = session(); await store.refreshLive();
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(DonorNewPage); fixture.detectChanges();
    const set = (name:string,value:string) => {
      const field = fixture.nativeElement.querySelector(`[name="${name}"]`) as HTMLInputElement;
      field.value=value;field.dispatchEvent(new Event('input'));fixture.detectChanges();
    };
    const submit=async()=>{fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true}));await fixture.whenStable();fixture.detectChanges();};
    const before=api.request.mock.calls.length;
    set('first','a'.repeat(301)); await submit();
    set('first','Avery');set('phone','1'.repeat(51));await submit();
    set('phone','');set('amount','1,2');await submit();
    expect(api.request.mock.calls).toHaveLength(before);
    set('amount','');api.request.mockRejectedValueOnce(new ApiError(400));await submit();
    const first = api.request.mock.calls.at(-1);
    expect(fixture.nativeElement.querySelector('[name="first"]').matches(':disabled')).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('The donor was rejected. Correct the details');
    set('first','Corrected');api.request.mockResolvedValueOnce({id:'new',owner_id:'board'});
    api.request.mockResolvedValueOnce({...donor,id:'new',name:'Corrected'});await submit();
    const writes=api.request.mock.calls.filter(([p,i])=>p==='/api/v1/donors'&&i?.method==='POST');
    expect(writes).toHaveLength(2);
    const corrected=JSON.parse(String(writes[1][1]?.body));
    expect(corrected.name).toBe('Corrected');
    expect(corrected.request_id).not.toBe(JSON.parse(String(first?.[1]?.body)).request_id);
  });
  it('keeps the saved donor while allowing first-gift correction after 400', async () => {
    TestBed.configureTestingModule({providers:[provideRouter([])]});
    const {store,api}=session();await store.refreshLive();
    const navigate=vi.spyOn(TestBed.inject(Router),'navigate').mockResolvedValue(true);
    const fixture=TestBed.createComponent(DonorNewPage);fixture.detectChanges();
    const set=(name:string,value:string)=>{const field=fixture.nativeElement.querySelector(`[name="${name}"]`) as HTMLInputElement;field.value=value;field.dispatchEvent(new Event('input'));fixture.detectChanges();};
    const submit=async()=>{fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true}));await fixture.whenStable();fixture.detectChanges();};
    set('first','Avery');set('amount','12');api.request.mockResolvedValueOnce({id:'new',owner_id:'board'});
    api.request.mockResolvedValueOnce({...donor,id:'new'});api.request.mockRejectedValueOnce(new ApiError(400));await submit();
    expect(fixture.nativeElement.querySelector('[name="first"]').matches(':disabled')).toBe(true);
    expect(fixture.nativeElement.querySelector('[name="amount"]').matches(':disabled')).toBe(false);
    set('amount','15');api.request.mockImplementationOnce(async(_p,i)=>({...JSON.parse(String(i?.body)),id:'gift',source:'manual'}));await submit();
    expect(api.request.mock.calls.filter(([p,i])=>p==='/api/v1/donors'&&i?.method==='POST')).toHaveLength(1);
    expect(store.allGifts()[0].amount_cents).toBe(1500);expect(navigate).toHaveBeenCalledWith(['/donors','new']);
  });
  it('unlocks an existing-donor gift after 400 and submits changed facts with a fresh identity', async () => {
    const {store,api}=session();await store.refreshLive();
    const fixture=TestBed.createComponent(GiftEntry);fixture.componentRef.setInput('donorId','donor');fixture.detectChanges();
    const field=fixture.nativeElement.querySelector('[name="amount"]') as HTMLInputElement;field.value='12';
    const submit=async()=>{fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true}));await fixture.whenStable();fixture.detectChanges();};
    api.request.mockRejectedValueOnce(new ApiError(400));await submit();
    const first=JSON.parse(String(api.request.mock.calls.at(-1)?.[1]?.body));expect(field.matches(':disabled')).toBe(false);
    field.value='15';api.request.mockImplementationOnce(async(_p,i)=>({...JSON.parse(String(i?.body)),id:'gift',source:'manual'}));await submit();
    const corrected=JSON.parse(String(api.request.mock.calls.at(-1)?.[1]?.body));
    expect(corrected.external_id).not.toBe(first.external_id);expect(corrected.amount_cents).toBe(1500);
    expect(store.allGifts()[0].amount_cents).toBe(1500);
  });
});
