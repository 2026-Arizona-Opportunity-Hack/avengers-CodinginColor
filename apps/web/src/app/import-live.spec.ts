import { TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { Api, ApiError } from './core/api';
import { Store } from './core/store';
import { LiveImportPage } from './pages/import-live';
import type { ImportPreview, ImportResult } from './core/import-live';

const batch = { batch_id: 'batch', status: 'reviewing' };
const preview = { headers: ['first name', 'email', 'donation amount'], mapping: ['first_name', 'email', 'amount_cents'],
  issues: [], counts: { rows: 1, donors: 1, gifts: 1, excluded: 0 } };
const source = { recordNumber: 2, raw: ['Avery', 'avery@example.org', '12.34'], issues: [] };
const row = { row: 0, action: 'new', reason: 'no_match', existingIds: [], matchingRows: [],
  draft: { name: 'Avery', email: 'avery@example.org' }, candidates: [] };
const eventFor = (form: HTMLFormElement) => Object.defineProperty(new Event('submit'), 'target', { value: form });

function setup() {
  let committed = false;
  const result = { batch_id: 'batch', status: 'committed', counts: { donors_created: 1, donors_linked: 0,
    gifts_inserted: 1, gifts_corrected: 0, skipped: 0 } };
  const api = { status: signal('ready'), request: vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
    if (path === '/api/v1/imports') return committed ? { ...result, replayed: true } : batch;
    if (path.endsWith('/batch')) return { ...batch, preview, layout: {} };
    if (path.endsWith('/layout')) return { ...batch, preview };
    if (path.endsWith('/suggestion')) return { suggestion: { approval_required: true, target: 'company', confidence: 0.2 } };
    if (path.includes('/plan/rows')) return { items: [path.includes('kind=donor') ? row : { ...row, action: 'insert',
      draft: { amount_cents: 1234, refund_cents: 0, currency: 'USD', status: 'settled' } }], total: 1, next_offset: 1 };
    if (path.includes('/rows?')) return { items: [source], total: 1, next_offset: 1 };
    if (path.endsWith('/plan')) return { plan_hash: path.includes('/donors/') ? 'donor-hash' : 'gift-hash',
      donor_plan_hash: 'donor-hash', counts: {}, excluded: 0, unresolved: [] };
    if (path.endsWith('/review')) return { status: 'ready' };
    if (path.endsWith('/commit')) { committed = true; return result; }
    if (path.endsWith('/abandon')) return { ...batch, status: 'abandoned' };
    throw new Error(`Unexpected test request ${path} ${init?.method}`);
  }) };
  TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: api }] });
  const store = TestBed.inject(Store); store.live.set(true);
  const fixture = TestBed.createComponent(LiveImportPage); fixture.detectChanges();
  const page = fixture.componentInstance as unknown as {
    upload(e: Event): Promise<void>; applyLayout(e: Event): Promise<void>; beginDonors(): Promise<void>;
    approve(): Promise<void>; commit(): Promise<void>; abandon(): Promise<void>; clear(): void;
    batch: WritableSignal<ImportResult | null>; phase: WritableSignal<string>; applied: WritableSignal<boolean>;
    error: WritableSignal<string | null>; previewRows: WritableSignal<unknown[]>;
    preview: WritableSignal<ImportPreview | null>; mapping: WritableSignal<Record<string, string | null>>;
    suggest(header: string): Promise<void>;
    aliases: WritableSignal<{ campaign: Record<string, string | null>; contact_person: Record<string, string | null> }>;
    chooseAlias(field: 'campaign' | 'contact_person', value: string, id: string): void;
  };
  const get = FormData.prototype.get;
  vi.spyOn(FormData.prototype, 'get').mockImplementation(function (this: FormData, name: string) {
    return name === 'file' ? new File(['original cells'], 'synthetic.csv') : get.call(this, name);
  });
  const upload = () => page.upload(eventFor(fixture.nativeElement.querySelector('form')));
  return { api, store, fixture, page, upload };
}

afterEach(() => vi.restoreAllMocks());

it('keeps optional suggestions separate until the reviewer explicitly accepts one', async () => {
  const { api, fixture, page, upload } = setup();
  await upload();
  page.preview.set({ ...preview, headers: ['Mystery'], mapping: [null] }); fixture.detectChanges();
  await page.suggest('Mystery'); fixture.detectChanges();
  expect(page.mapping()).toEqual({});
  expect(fixture.nativeElement.textContent).toContain('20% confidence');
  expect(api.request.mock.calls.find(([path]) => path.endsWith('/suggestion'))?.[1]?.body).toBe(JSON.stringify({ header: 'Mystery' }));
  const accept = [...fixture.nativeElement.querySelectorAll('button')].find((b: unknown) => (b as HTMLButtonElement).textContent?.includes('Use suggestion')) as HTMLButtonElement;
  accept.click(); fixture.detectChanges();
  expect(page.mapping()).toEqual({ Mystery: 'company' });
  expect(page.applied()).toBe(false);
  page.clear(); expect(page.mapping()).toEqual({});
});

it('keeps manual mapping available when optional suggestions are unavailable', async () => {
  const { api, page, upload } = setup(); await upload();
  api.request.mockResolvedValueOnce({ suggestion: null, unavailable: true });
  await page.suggest('Mystery');
  expect(page.mapping()).toEqual({});
  expect(page.error()).toContain('Choose a mapping manually');
});

it('walks through server mapping, both reviews, reconciliation, commit and duplicate replay', async () => {
  const { api, fixture, page, upload } = setup();
  await upload(); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Map columns');
  const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
  for (const [name, value] of Object.entries({ currency: 'USD', occurred_at: '2026-11-01T12:00:00-07:00', status: 'settled', refund_cents: '0' }))
    (form.elements.namedItem(name) as HTMLInputElement).value = value;
  await page.applyLayout(eventFor(form));
  expect(page.applied()).toBe(true);
  const layoutCall = api.request.mock.calls.find(([path]) => path.endsWith('/layout'))!;
  expect(JSON.parse(String(layoutCall[1]?.body)).batch_values).toEqual({ currency: 'USD', occurred_at: '2026-11-01T12:00:00-07:00', status: 'settled', refund_cents: 0 });
  await page.beginDonors(); expect(page.phase()).toBe('donor');
  await page.approve(); expect(page.phase()).toBe('gift');
  await page.approve(); fixture.detectChanges();
  expect(page.phase()).toBe('confirm'); expect(fixture.nativeElement.textContent).toContain('12.34');
  await page.commit(); fixture.detectChanges();
  expect(page.batch()?.status).toBe('committed'); expect(page.previewRows()).toEqual([]);
  expect(fixture.nativeElement.textContent).toContain('1 gifts inserted');
  page.clear(); fixture.detectChanges(); await upload(); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Already imported');
  expect(api.request.mock.calls.filter(([path]) => path.endsWith('/commit'))).toHaveLength(1);
});

it('discards private upload results arriving after the session changes', async () => {
  const { api, fixture, store, page, upload } = setup();
  let resolve!: (value: unknown) => void;
  api.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = upload(); store.sessionEpoch.update(n => n + 1); fixture.detectChanges();
  resolve(batch); await pending;
  expect(page.batch()).toBeNull(); expect(page.previewRows()).toEqual([]);
});

it('requires a fresh review after a stale-plan response and can purge the staged batch', async () => {
  const { api, page, upload } = setup(); await upload();
  api.request.mockRejectedValueOnce(new ApiError(409));
  await page.beginDonors();
  expect(page.phase()).toBe('mapping'); expect(page.applied()).toBe(false);
  expect(page.error()).toContain('review changed');
  await page.abandon(); expect(page.batch()).toBeNull();
  expect(api.request).toHaveBeenCalledWith('/api/v1/imports/batch/abandon', expect.objectContaining({ method: 'POST' }));
});

it('uses mapped row statuses and refunds without replacing them with batch defaults', async () => {
  const { api, fixture, page, upload } = setup();
  api.request.mockResolvedValueOnce(batch).mockResolvedValueOnce({ ...batch, layout: {}, preview: {
    ...preview, headers: [...preview.headers, 'status', 'refunded amount'], mapping: [...preview.mapping, 'status', 'refund_cents'],
  } });
  await upload(); fixture.detectChanges();
  const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
  expect(form.elements.namedItem('status')).toBeNull(); expect(form.elements.namedItem('refund_cents')).toBeNull();
  (form.elements.namedItem('currency') as HTMLInputElement).value = 'USD';
  (form.elements.namedItem('occurred_at') as HTMLInputElement).value = '2026-01-01T12:00:00Z';
  await page.applyLayout(eventFor(form));
  const body = JSON.parse(String(api.request.mock.calls.find(([path]) => path.endsWith('/layout'))![1]?.body));
  expect(body.batch_values).toEqual({ currency: 'USD', occurred_at: '2026-01-01T12:00:00Z' });
});

it('retains manually mapped decimal refunds instead of requesting conflicting batch cents', async () => {
  const { api, fixture, page, upload } = setup(); await upload();
  page.preview.set({ ...preview, headers: [...preview.headers, 'Return'], mapping: [...preview.mapping, null] });
  page.mapping.set({ Return: 'refund_decimal' }); fixture.detectChanges();
  const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
  expect(form.elements.namedItem('refund_cents')).toBeNull();
  (form.elements.namedItem('status') as HTMLInputElement).value = 'settled';
  await page.applyLayout(eventFor(form));
  const body = JSON.parse(String(api.request.mock.calls.find(([path]) => path.endsWith('/layout'))![1]?.body));
  expect(body.mapping).toEqual({ Return: 'refund_decimal' });
  expect(body.batch_values).toEqual({ status: 'settled' });
});

it('requires explicit alias choices and sends reviewed fallbacks with the mapping', async () => {
  const { api, fixture, page, upload } = setup(); await upload();
  page.chooseAlias('campaign', 'Spring', '__none'); page.chooseAlias('contact_person', 'Pat', 'owner-id');
  fixture.detectChanges(); const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
  (form.elements.namedItem('status') as HTMLInputElement).value = 'settled';
  (form.elements.namedItem('refund_cents') as HTMLInputElement).value = '0';
  await page.applyLayout(eventFor(form));
  const body = JSON.parse(String(api.request.mock.calls.find(([path]) => path.endsWith('/layout'))![1]?.body));
  expect(body.aliases).toEqual({ campaign: { Spring: null }, contact_person: { Pat: 'owner-id' } });
  page.clear(); expect(page.aliases()).toEqual({ campaign: {}, contact_person: {} });
});
