import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import { APP_ICONS } from './core/icons';
import { Api } from './core/api';
import { Store } from './core/store';
import { DonationsPage } from './pages/donations';
import { DonorDetailPage } from './pages/donor-detail';
import { routes } from './app.routes';
import { NAV } from './shell/nav';

const download = vi.fn((blob: Blob) => 'blob:synthetic');
beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: download });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  download.mockClear();
});
afterEach(() => vi.restoreAllMocks());
const donor = { id: 'donor', org_id: 'org', owner_id: 'board', name: 'Avery',
  email: 'a@example.org', phone: null, consent: 'unknown', metadata: {}, archived_at: null };
const gift = { id: 'usd', donor_id: 'donor', campaign_id: null, amount_cents: 1029, refund_cents: 29,
  currency: 'USD', status: 'settled', occurred_at: '2027-01-01T03:00:00Z', source: 'zeffy', external_id: null, source_row: null };
async function setup(role: 'admin' | 'board' = 'admin', archived = false) {
  let out = () => {};
  const api = { status: signal('ready'), start: async (_c: unknown, _in: unknown, signOut: () => void) => { out = signOut; },
    me: async () => ({ id: role === 'admin' ? 'admin' : 'board', org_id: 'org', role }),
    allDonors: async () => [{ ...donor, archived_at: archived ? '2026-01-01T12:00:00Z' : null }, { ...donor, id: 'foreign', owner_id: 'other', name: 'Other donor' }],
    request: vi.fn(async (path: string) => {
      if (path.includes('/gifts?')) return { items: [gift, { ...gift, id: 'eur', currency: 'EUR', amount_cents: 2029 },
        { ...gift, id: 'foreign-gift', donor_id: 'foreign', amount_cents: 99999 }] };
      if (path === '/api/v1/catalog') return { programs: [], campaigns: [] };
      if (path.includes('/follow-ups?')) return { overdue: [], due_this_week: [], upcoming: [
        { id: 'task', donor_id: 'donor', owner_id: 'board', title: 'Future call', kind: 'next_action', status: 'open', due_at: '2027-02-01T07:00:00Z' }] };
      if (path.includes('/communications?')) return { items: [{ id: 'contact', donor_id: 'donor', actor_id: 'board',
        channel: 'email', status: 'manual', note: 'Past conversation', occurred_at: '2026-11-01T12:00:00Z', draft_id: null }] };
      return { items: [] };
    }) };
  TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: api }, provideRouter([]), provideIcons(APP_ICONS)] });
  TestBed.overrideComponent(DonationsPage, { remove: { imports: [NgxEchartsDirective] }, add: { schemas: [NO_ERRORS_SCHEMA] } });
  const store = TestBed.inject(Store); store.connect({ apiBase: '', clerkPublishableKey: 'synthetic' }); await store.refreshLive();
  return { store, signOut: () => out() };
}

it('enables the real ledger and keeps selected currency, exact cents and Phoenix year/month together', async () => {
  const { store } = await setup('board');
  const fixture = TestBed.createComponent(DonationsPage); fixture.detectChanges();
  const page = fixture.componentInstance as unknown as { year: ReturnType<typeof signal<string>>; months(): { key: string }[]; exportCsv(): void };
  expect(fixture.nativeElement.textContent).toContain('$10.29');
  expect(fixture.nativeElement.textContent).not.toContain('Other donor');
  expect(fixture.nativeElement.textContent).not.toContain('Download CSV');
  page.exportCsv(); expect(download).not.toHaveBeenCalled();
  page.year.set('2026'); expect(page.months()[0].key).toBe('2026-12');
  store.selectedCurrency.set('EUR'); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('€20.29');
  expect(fixture.nativeElement.textContent).not.toContain('$10.29');
  expect(NAV.flatMap(g => g.items).find(i => i.path === '/donations')?.live).toBe(true);
  expect(routes.find(r => r.path === '')?.children?.find(r => r.path === 'donations')?.canMatch).toBeUndefined();
});

it('exports the admin selected-currency ledger and clears private rows after session loss', async () => {
  const { store, signOut } = await setup();
  const fixture = TestBed.createComponent(DonationsPage); fixture.detectChanges();
  const page = fixture.componentInstance as unknown as { exportCsv(): void };
  store.selectedCurrency.set('EUR'); page.exportCsv();
  const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(download.mock.calls[0][0]); });
  expect(text).toContain('Amount (EUR),Refund (EUR)'); expect(text).toContain('2026-12-31,Avery');
  expect(text).toContain('20.29,0.29');
  signOut(); fixture.detectChanges(); expect(fixture.nativeElement.textContent).not.toContain('Avery');
});

it('renders donations, communications and future tasks as separate record sections', async () => {
  const { store } = await setup();
  const fixture = TestBed.createComponent(DonorDetailPage); fixture.componentRef.setInput('id', 'donor'); fixture.detectChanges();
  const gifts = fixture.nativeElement.querySelector('[aria-label="Donations, newest first"]') as HTMLElement;
  const contacts = fixture.nativeElement.querySelector('[aria-label="Communications, newest first"]') as HTMLElement;
  expect(gifts.textContent).toContain('$10.29'); expect(gifts.textContent).not.toContain('Past conversation');
  expect(gifts.textContent).not.toContain('Future call');
  expect(contacts.textContent).toContain('Past conversation'); expect(contacts.textContent).not.toContain('$10.29');
  expect(fixture.nativeElement.querySelector('[aria-labelledby="next-h"]').textContent).toContain('Future call');
  store.selectedCurrency.set('EUR'); fixture.detectChanges(); expect(gifts.textContent).toContain('€20.29');
});

it('preserves authorized archived gifts and contacts without restoring archived assignment load', async () => {
  const { store } = await setup('board', true);
  expect(store.donors()).toEqual([]); expect(store.ledgerGifts().map(g => g.id)).toEqual(['usd']);
  expect(store.historicalDonor('foreign')).toBeNull(); expect(store.historicalContacts('foreign')).toEqual([]);
  const fixture = TestBed.createComponent(DonorDetailPage); fixture.componentRef.setInput('id', 'donor'); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Avery');
  expect(fixture.nativeElement.querySelector('[aria-label="Donations, newest first"]').textContent).toContain('$10.29');
  expect(fixture.nativeElement.querySelector('[aria-label="Giving summary"]').textContent).toContain('$10.00');
  expect(fixture.nativeElement.querySelector('[aria-label="Communications, newest first"]').textContent).toContain('Past conversation');
});

it('loads active and archived donors through separate scoped API pages only when requested', async () => {
  const api = new Api();
  const request = vi.spyOn(api, 'request').mockResolvedValueOnce({ items: [donor] })
    .mockResolvedValueOnce({ items: [{ ...donor, id: 'archived', archived_at: '2026-01-01T12:00:00Z' }] });
  expect((await api.allDonors(true)).map(d => d.id)).toEqual(['donor', 'archived']);
  expect(request.mock.calls.map(c => c[0])).toEqual(['/api/v1/donors?limit=100&offset=0', '/api/v1/donors?limit=100&offset=0&archived=true']);
});
