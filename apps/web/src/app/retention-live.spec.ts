import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';
import { Api, ApiError, type ApiRetention } from './core/api';
import { Store } from './core/store';
import { ReportFilters } from './core/report-filters';
import { SEGMENTS, ytdWindows, type RetentionResult } from './core/retention';
import { OverviewPage } from './pages/overview';
import { RetentionPage } from './pages/retention';

const currency = (amount: number): ApiRetention['byCurrency'][string] => ({
  totals: { prior_cents: amount, current_cents: amount }, retention: { prior_donors: 1, retained_donors: 1 },
  segments: Object.fromEntries(SEGMENTS.map(s => [s, { donors: s === 'flat' ? 1 : 0, prior_cents: s === 'flat' ? amount : 0, current_cents: s === 'flat' ? amount : 0 }])),
  donors: [{ donor_id: 'visible', segment: 'flat', name: 'Visible donor', prior_cents: amount, current_cents: amount }],
});
const report: ApiRetention = { as_of: '2026-11-15', windows: ytdWindows('2026-11-15'), byCurrency: { USD: currency(1000), EUR: currency(2000) } };

for (const Page of [OverviewPage, RetentionPage]) {
  describe(Page.name, () => {
    function setup() {
      const store = { live: signal(true), signedIn: signal(true), sessionEpoch: signal(1), currency: signal('EUR'), gifts: signal([]), ledgerGifts: signal([]), donor: () => null, historicalDonor: () => null };
      const api = { retention: vi.fn(async (): Promise<ApiRetention> => report) };
      TestBed.configureTestingModule({ providers: [{ provide: Store, useValue: store }, { provide: Api, useValue: api }] });
      const page = TestBed.runInInjectionContext(() => new Page()) as unknown as {
        r: Signal<RetentionResult>; server: Signal<ApiRetention | null>; serverError: Signal<string | null>; money(cents: number): string;
      };
      const settle = async () => { TestBed.tick(); await Promise.resolve(); await Promise.resolve(); TestBed.tick(); };
      return { store, api, page, settle, filters: TestBed.inject(ReportFilters) };
    }

    it('uses server scoped facts and changes currency without mixing or refetching', async () => {
      const f = setup(); await f.settle();
      expect(f.page.r().totals.current).toBe(2000); expect(f.page.money(2000)).toContain('€');
      expect(f.page.r().retained).toBe(1); expect(f.page.r().donors[0].donor_id).toBe('visible');
      f.store.currency.set('USD'); expect(f.page.r().totals.current).toBe(1000);
      f.store.currency.set('GBP'); expect(f.page.r().totals.current).toBe(0);
      expect(f.api.retention).toHaveBeenCalledOnce();
    });

    it('drops late private reports and clears them on session loss', async () => {
      const f = setup(); let finish!: (value: ApiRetention) => void;
      f.api.retention.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      TestBed.tick(); f.store.signedIn.set(false); f.store.sessionEpoch.update(n => n + 1); await f.settle();
      finish(report); await f.settle(); expect(f.page.server()).toBeNull();
      f.store.signedIn.set(true); await f.settle(); expect(f.page.server()).toEqual(report);
      f.store.signedIn.set(false); await f.settle(); expect(f.page.server()).toBeNull();
    });

    it('surfaces server rejection without using local gifts as a successful report', async () => {
      const f = setup(); f.api.retention.mockRejectedValueOnce(new ApiError(403)); await f.settle();
      expect(f.page.server()).toBeNull(); expect(f.page.serverError()).toBe('You do not have access to that.');
    });

    it('reloads shared filter queries and stops requests for invalid periods', async () => {
      const f = setup(); await f.settle();
      f.filters.from.set('2026-04-01'); f.filters.through.set('2026-11-14'); f.filters.program.set('program'); f.filters.owner.set('owner');
      f.filters.campaign.set('campaign'); f.filters.cohort.set('2025'); await f.settle();
      expect(f.api.retention).toHaveBeenLastCalledWith('2026-11-14', { from: '2026-04-01', programId: 'program', ownerId: 'owner', campaignId: 'campaign', cohort: '2025' });
      const calls = f.api.retention.mock.calls.length; f.filters.from.set('2026-12-01'); await f.settle();
      expect(f.api.retention).toHaveBeenCalledTimes(calls); expect(f.page.server()).toBeNull();
      expect(f.page.serverError()).toContain('valid reporting period');
    });
  });
}
