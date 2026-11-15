import { TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { Api, ApiError } from './core/api';
import { Store } from './core/store';
import { LiveFundersPage, packetQuery } from './pages/funders-live';
import type { ApiFunderPacket } from './core/report-models';

const packet: ApiFunderPacket = {
  funder: { name: 'Example Foundation' }, program: { id: 'program', title: 'Academy' },
  period: { from: '2026-01-01T00:00:00-07:00', to: '2026-11-16T00:00:00-07:00' },
  gifts: [{ id: 'gift', occurred_at: '2026-11-01T12:00:00-07:00', attribution: 'program', status: 'settled',
    currency: 'USD', amount_cents: 1234, refund_cents: 100, net_cents: 1134, source: 'zeffy', external_id: 'txn-1' }],
  totals: { program: { USD: { gifts: 1, gross_cents: 1234, refund_cents: 100, net_cents: 1134 } },
    unattributed: { EUR: { gifts: 1, gross_cents: 2000, refund_cents: 0, net_cents: 2000 } } },
  outcomes_status: 'unavailable', outcomes: [],
};
function setup(admin = true) {
  const signedIn = signal(true), epoch = signal(1);
  const historicalDonors = signal([{ id: 'funder', name: 'Example Foundation' }]);
  const store = { historicalDonors, donors: signal([{ id: 'funder', name: 'Example Foundation' }]),
    programs: signal([{ id: 'program', title: 'Academy' }]), isAdmin: signal(admin), signedIn, sessionEpoch: epoch };
  const api = { request: vi.fn(async (_path: string, _init?: RequestInit, _parse?: string): Promise<unknown> => packet) };
  TestBed.configureTestingModule({ providers: [{ provide: Store, useValue: store }, { provide: Api, useValue: api }] });
  const fixture = TestBed.createComponent(LiveFundersPage);
  const page = fixture.componentInstance as unknown as {
    packet: WritableSignal<ApiFunderPacket | null>; from: WritableSignal<string>; through: WritableSignal<string>;
    error: WritableSignal<string | null>; download(): Promise<void>; print(): void;
  };
  const settle = async () => { fixture.detectChanges(); await Promise.resolve(); await Promise.resolve(); fixture.detectChanges(); };
  return { store, api, fixture, page, settle };
}
afterEach(() => vi.restoreAllMocks());

it('uses an inclusive date control and an exclusive Phoenix API boundary', () => {
  const params = new URLSearchParams(packetQuery('funder', 'program', '2026-01-01', '2026-11-15')!);
  expect(params.get('to')).toBe('2026-11-16');
  expect(packetQuery('funder', 'program', '2026-02-30', '2026-11-15')).toBeNull();
  expect(packetQuery('funder', 'program', '2026-11-16', '2026-11-15')).toBeNull();
});

it('renders actual packet currencies, provenance and unavailable outcomes', async () => {
  const f = setup(); await f.settle();
  expect(f.api.request).toHaveBeenCalledOnce();
  expect(f.api.request.mock.calls[0][0]).toContain('/api/v1/reports/funder-packet?funderId=funder&programId=program');
  const text = f.fixture.nativeElement.textContent;
  for (const fact of ['Example Foundation', 'USD', 'EUR', '11.34', '20.00', 'txn-1', 'Unattributed', 'does not mean zero']) expect(text).toContain(fact);
});

it('shows reported zero as zero, separately from not-reported outcomes', async () => {
  const f = setup(); f.api.request.mockResolvedValue({ ...packet, outcomes_status: 'available', outcomes: [
    { metric: 'Completed', value: 0, unit: 'students', denominator: 10, period: packet.period, source: 'Approved upload', approved_at: '2026-11-01T12:00:00Z' },
    { metric: 'Survey', value: null, unit: 'responses', denominator: null, period: packet.period, source: 'CIC', approved_at: '2026-11-01T12:00:00Z' },
  ] }); await f.settle();
  expect(f.fixture.nativeElement.textContent).toContain('0 students');
  expect(f.fixture.nativeElement.textContent).toContain('Not reported responses');
  expect(f.fixture.nativeElement.textContent).toContain('Approved upload');
});

it('discards older packet responses and clears private data after sign-out', async () => {
  const f = setup(); let finish!: (p: ApiFunderPacket) => void;
  f.api.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  f.fixture.detectChanges(); f.page.from.set('2025-01-01'); await f.settle();
  expect(f.page.packet()).toEqual(packet);
  finish({ ...packet, funder: { name: 'Old response' } }); await f.settle();
  expect(f.page.packet()?.funder.name).toBe('Example Foundation');
  f.store.signedIn.set(false); f.store.sessionEpoch.update(n => n + 1); await f.settle();
  expect(f.page.packet()).toBeNull();
});

it('refuses board loads and reports a denied admin load without pretending a report exists', async () => {
  const f = setup(false); await f.settle(); expect(f.api.request).not.toHaveBeenCalled();
  f.store.isAdmin.set(true); f.api.request.mockRejectedValueOnce(new ApiError(403)); await f.settle();
  expect(f.page.packet()).toBeNull(); expect(f.page.error()).toBe('You do not have access to that.');
});

it('downloads the server CSV and never starts a download after a rejected request', async () => {
  const f = setup(); await f.settle();
  const create = vi.fn(() => 'blob:packet'), revoke = vi.fn(), click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  f.api.request.mockResolvedValueOnce(new Blob(['server packet'], { type: 'text/csv' })); await f.page.download();
  expect(f.api.request.mock.calls.at(-1)?.[0]).toContain('&format=csv'); expect(click).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith('blob:packet');
  f.api.request.mockRejectedValueOnce(new ApiError(403)); await f.page.download();
  expect(click).toHaveBeenCalledOnce(); expect(f.page.error()).toBeTruthy(); vi.unstubAllGlobals();
});

it('drops a CSV that arrives after the session ends', async () => {
  const f = setup(); await f.settle();
  let finish!: (blob: Blob) => void;
  f.api.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const pending = f.page.download();
  f.store.signedIn.set(false); f.store.sessionEpoch.update(n => n + 1); await f.settle();
  finish(new Blob(['private packet'])); await pending;
  expect(click).not.toHaveBeenCalled(); expect(f.page.packet()).toBeNull();
});

it('prints only the successfully loaded current packet', async () => {
  const f = setup(), print = vi.spyOn(window, 'print').mockImplementation(() => {});
  f.page.print(); expect(print).not.toHaveBeenCalled();
  await f.settle(); f.page.print(); expect(print).toHaveBeenCalledOnce();
  f.page.from.set('2026-02-01'); f.page.print(); expect(print).toHaveBeenCalledOnce();
});

it('keeps archived funders selectable when they leave active donor worklists', async () => {
  const f = setup(); f.store.donors.set([]); await f.settle();
  expect(f.fixture.nativeElement.querySelector('select').textContent).toContain('Example Foundation');
  expect(f.api.request.mock.calls[0][0]).toContain('funderId=funder');
});
