import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import { APP_ICONS } from './core/icons';
import { Api } from './core/api';
import { Store } from './core/store';
import echarts from './core/echarts-setup';
import { DonationsPage } from './pages/donations';

const gift = { id: 'jan', donor_id: 'own', campaign_id: null, amount_cents: 1029, refund_cents: 29,
  currency: 'USD', status: 'settled', occurred_at: '2026-01-15T12:00:00Z', source: 'zeffy', external_id: null, source_row: null };
const donor = { id: 'own', org_id: 'org', owner_id: 'board', name: 'Avery', email: null, phone: null,
  consent: 'unknown', metadata: {}, archived_at: null };

async function setup(role: 'admin' | 'board' = 'board') {
  const api = { status: signal('ready'), start: async () => {},
    me: async () => ({ id: role, org_id: 'org', role }),
    allDonors: async () => [donor, { ...donor, id: 'foreign', owner_id: 'other', name: 'Other donor' }],
    request: async (path: string) => {
      if (path.includes('/gifts?')) return { items: [gift,
        { ...gift, id: 'mar', occurred_at: '2026-03-15T12:00:00Z', amount_cents: 2000, refund_cents: 500, campaign_id: 'campaign' },
        { ...gift, id: 'pending', status: 'pending', amount_cents: 9000 },
        { ...gift, id: 'void', status: 'void', amount_cents: 8000 },
        { ...gift, id: 'eur', currency: 'EUR', amount_cents: 2029 },
        { ...gift, id: 'foreign', donor_id: 'foreign', amount_cents: 99999 }] };
      if (path === '/api/v1/catalog') return { programs: [], campaigns: [] };
      return { items: [], overdue: [], due_this_week: [], upcoming: [] };
    } };
  TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: api }, provideRouter([]), provideIcons(APP_ICONS)] });
  TestBed.overrideComponent(DonationsPage, { remove: { imports: [NgxEchartsDirective] }, add: { schemas: [NO_ERRORS_SCHEMA] } });
  const store = TestBed.inject(Store);
  store.connect({ apiBase: '', clerkPublishableKey: 'synthetic' }); await store.refreshLive();
  const fixture = TestBed.createComponent(DonationsPage); fixture.detectChanges();
  const page = fixture.componentInstance as any;
  const chartSelect = [...fixture.nativeElement.querySelectorAll('select')].find((el: any) => el.parentElement.textContent.includes('Chart type')) as HTMLSelectElement;
  const choose = (mode: string) => { chartSelect.value = mode; chartSelect.dispatchEvent(new Event('change')); fixture.detectChanges(); };
  return { store, fixture, page, chartSelect, choose };
}

it('labels a native keyboard-focusable selector above the chart, defaults to Bar and preserves ledger/export access', async () => {
  const { fixture, page, chartSelect, choose } = await setup();
  expect(chartSelect.labels?.[0].textContent).toContain('Chart type');
  expect([...chartSelect.options].map(o => o.text)).toEqual(['Bar', 'Line', 'Area']);
  expect(chartSelect.value).toBe('bar');
  chartSelect.focus(); expect(document.activeElement).toBe(chartSelect);
  expect(chartSelect.compareDocumentPosition(fixture.nativeElement.querySelector('[echarts]')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const ledger = fixture.nativeElement.querySelector('table').textContent;
  for (const mode of ['line', 'area', 'bar']) {
    choose(mode); expect(page.chartType()).toBe(mode);
    expect(fixture.nativeElement.querySelector('table').textContent).toBe(ledger);
    expect(fixture.nativeElement.textContent).not.toContain('Download CSV');
  }
});

it('uses identical exact filtered net cents and real month categories in every mode', async () => {
  const { store, page, choose } = await setup();
  const assertModes = (values: number[]) => {
    for (const mode of ['bar', 'line', 'area']) {
      choose(mode);
      const options = page.monthOptions();
      expect(options.series[0].data).toEqual(values);
      expect(options.series[0].type).toBe(mode === 'bar' ? 'bar' : 'line');
      expect(options.series[0].smooth).not.toBe(true);
      expect(options.tooltip.valueFormatter(1000)).toContain(store.currency() === 'EUR' ? '€10.00' : '$10.00');
    }
  };
  assertModes([1000, 1500]);
  expect(page.monthOptions().xAxis.data).toHaveLength(2); // No invented February observation.
  expect(page.totals()).toEqual({ gross: 3029, refunds: 529, net: 2500 });
  page.campaign.set('campaign'); assertModes([1500]);
  page.campaign.set('none'); assertModes([1000]);
  page.campaign.set(''); page.status.set('pending'); assertModes([0]);
  page.status.set('void'); assertModes([0]);
  page.status.set(''); page.source.set('benevity'); assertModes([]);
  page.source.set(''); page.year.set('2025'); assertModes([]);
  page.year.set(''); store.selectedCurrency.set('EUR'); assertModes([2000]);
});

it('keeps owner scope for board members and admin CSV access in all modes', async () => {
  const { fixture, page, choose } = await setup('admin');
  for (const mode of ['bar', 'line', 'area']) {
    choose(mode);
    expect(fixture.nativeElement.textContent).toContain('Download CSV');
    expect(fixture.nativeElement.textContent).toContain('Other donor');
    expect(page.monthOptions().series[0].data).toEqual([100970, 1500]);
  }
});

it('shows an explicit empty chart state for every mode without changing filters', async () => {
  const { fixture, page, choose } = await setup();
  page.year.set('1900');
  for (const mode of ['bar', 'line', 'area']) {
    choose(mode);
    expect(fixture.nativeElement.querySelector('[echarts]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[role="status"]').textContent).toContain('No gifts match');
    expect(page.year()).toBe('1900');
  }
});

it('renders real Bar, Line and Area SVGs using the registered ECharts modules', async () => {
  const { page, choose } = await setup();
  const svgs: string[] = [];
  for (const mode of ['bar', 'line', 'area', 'line', 'bar']) {
    choose(mode);
    const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 700, height: 260 });
    chart.setOption({ ...page.monthOptions(), animation: false });
    const svg = chart.renderToSVGString();
    expect(svg).toContain('<svg');
    expect(svg).toContain('Jan'); expect(svg).toContain('Mar');
    expect(chart.getOption()['series']).toMatchObject([{ type: mode === 'bar' ? 'bar' : 'line', data: [1000, 1500] }]);
    svgs.push(svg); chart.dispose();
  }
  expect(svgs[0]).not.toBe(svgs[1]); expect(svgs[1]).not.toBe(svgs[2]);
});
