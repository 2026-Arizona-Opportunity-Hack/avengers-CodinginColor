import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';
import { Api } from './core/api';
import { Store } from './core/store';
import type { Gift } from './core/models';
import type { RetentionResult } from './core/retention';
import { OverviewPage } from './pages/overview';

const gift = (id: string, occurred_at: string, amount_cents = 1000, refund_cents = 0, status: Gift['status'] = 'settled'): Gift => ({
  id, donor_id: 'visible', campaign_id: 'campaign', amount_cents, refund_cents, status,
  occurred_at, currency: 'EUR', source: 'manual', external_id: null,
});
function setup() {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-15T12:00:00-07:00'));
  const store = {
    live: signal(false), signedIn: signal(true), sessionEpoch: signal(1), gifts: signal<Gift[]>([]), currency: signal('EUR'), followUps: signal([]),
    donors: signal([{ id: 'visible', owner_id: 'member' }]), boardMembers: signal([{ id: 'member', name: 'Owner' }]),
    communications: signal([]), campaign: () => ({ program_id: 'program' }), program: () => ({ title: 'Academy' }),
    netCents: (g: Gift) => g.status === 'settled' ? g.amount_cents - g.refund_cents : 0,
  };
  TestBed.configureTestingModule({ providers: [{ provide: Store, useValue: store }, { provide: Api, useValue: { retention: vi.fn() } }] });
  const page = TestBed.runInInjectionContext(() => new OverviewPage()) as unknown as {
    r: Signal<RetentionResult>; money(cents: number): string; dollars(value: number): string;
    byProgram: Signal<Array<{ label: string; cents: number }>>; cum(year: number): Array<number | null>;
    recentGifts: Signal<Gift[]>; portfolios: Signal<Array<{ raised: number }>>;
  };
  return { store, page };
}
afterEach(() => vi.restoreAllMocks());

it('uses net settled scoped gifts and the selected currency, including currency changes', () => {
  const { store, page } = setup();
  store.gifts.set([gift('paid', '2026-06-01T12:00:00Z', 5000, 500), gift('pending', '2026-06-02T12:00:00Z', 9000, 0, 'pending')]);
  expect(page.r().totals.current).toBe(4500);
  expect(page.byProgram()).toEqual([{ label: 'Academy', cents: 4500 }]);
  expect(page.money(4500)).toContain('€'); expect(page.dollars(45)).toContain('€');
  store.currency.set('GBP'); expect(page.money(4500)).toContain('£');
  store.gifts.set([]); expect(page.r().totals.current).toBe(0); expect(page.byProgram()).toEqual([]);
});

it('uses Phoenix day and year boundaries consistently and excludes future gifts', () => {
  const { store, page } = setup();
  store.gifts.set([
    gift('prior-year', '2026-01-01T06:59:59Z', 2000),
    gift('new-year', '2026-01-01T07:00:00Z', 3000),
    gift('today', '2026-11-16T06:59:59Z', 4000),
    gift('tomorrow', '2026-11-16T07:00:00Z', 5000),
  ]);
  expect(page.r().totals.current).toBe(7000);
  expect(page.cum(2026)[0]).toBe(3000);
  expect(page.cum(2026)[10]).toBe(7000);
  expect(page.byProgram()[0].cents).toBe(7000);
  expect(page.portfolios()[0].raised).toBe(7000);
  expect(page.recentGifts().map(g => g.id)).not.toContain('tomorrow');
});
