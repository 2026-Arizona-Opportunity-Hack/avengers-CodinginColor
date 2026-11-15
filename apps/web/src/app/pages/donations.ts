import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsCoreOption } from 'echarts/core';
import { BASE, GREEN, INK_MUTED, axisLine, axisTick, splitLine } from '../shared/chart-theme';
import { RouterLink } from '@angular/router';
import { Store } from '../core/store';
import { date, dateShort } from '../core/format';
import { Gift, SOURCE_LABEL, Source } from '../core/models';

interface Row { gift: Gift; donor: string; campaign: string; program: string; }
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const phoenixDay = (value: string) => new Date(Date.parse(value) - 7 * 3600_000).toISOString().slice(0, 10);
import { downloadCsv } from '../core/csv';

@Component({
  selector: 'app-donations',
  imports: [RouterLink, NgIcon, HlmButtonImports, NgxEchartsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Donations</h1>
          <p class="lede">{{ store.isAdmin() ? 'Organization gift ledger' : 'Gifts for your assigned donors' }} · {{ store.currency() }}</p>
        </div>
        <div class="actions">
          @if (store.isAdmin()) { <button hlmBtn variant="outline" type="button" (click)="exportCsv()" [disabled]="rows().length === 0"><ng-icon name="lucideFileDown" size="16" /> Download CSV</button> }
        </div>
      </header>

      @if (store.notice()) { <p role="alert">{{ store.notice() }}</p> }
      <form class="toolbar glass" (submit)="$event.preventDefault()" aria-label="Filter donations">
        <label>Currency<select class="select" [value]="store.currency()" (change)="store.selectedCurrency.set(val($event))">
          @for (code of store.currencies(); track code) { <option [value]="code">{{ code }}</option> }
        </select></label>
        <ng-icon name="lucideSearch" size="16" class="ms-2 text-[var(--ink-400)]" aria-hidden="true" />
        <label><span class="sr-only">Year</span><select class="select" (change)="year.set(val($event))">
          <option value="">All years</option>@for (y of years(); track y) { <option [value]="y">{{ y }}</option> }</select></label>
        <label class="grow"><span class="sr-only">Campaign</span><select class="select" (change)="campaign.set(val($event))">
          <option value="">All campaigns</option><option value="none">General support (no campaign)</option>
          @for (c of store.campaigns(); track c.id) { <option [value]="c.id">{{ c.title }}</option> }</select></label>
        <label><span class="sr-only">Source</span><select class="select" (change)="source.set(val($event))">
          <option value="">All sources</option>@for (s of sources; track s) { <option [value]="s">{{ sourceLabel[s] }}</option> }</select></label>
        <label><span class="sr-only">Status</span><select class="select" (change)="status.set(val($event))">
          <option value="">Any status</option><option value="settled">Settled</option><option value="pending">Pending</option><option value="void">Void</option></select></label>
      </form>

      <div class="top">
        <section class="panel" aria-labelledby="m-h">
          <div class="panel-head">
            <h2 id="m-h">Net giving by month</h2>
            <dl class="mini" aria-live="polite">
              <div><dt>Gifts</dt><dd>{{ rows().length }}</dd></div>
              <div><dt>Gross</dt><dd>{{ money(totals().gross) }}</dd></div>
              <div><dt>Refunded</dt><dd>{{ money(totals().refunds) }}</dd></div>
              <div><dt>Net</dt><dd class="net">{{ money(totals().net) }}</dd></div>
            </dl>
          </div>
          <div echarts [options]="monthOptions()" [initOpts]="{ renderer: 'svg' }" class="h-[260px] px-3 pb-3"></div>
        </section>
        <section class="panel" aria-labelledby="s-h">
          <div class="panel-head"><h2 id="s-h">Where it came from</h2></div>
          <ul class="bars">
            @for (b of bySource(); track b.label) {
              <li><span class="b-name">{{ b.label }}</span><span class="b-track"><span [style.width.%]="(b.cents / maxSource()) * 100"></span></span><span class="b-val">{{ compact(b.cents) }}</span></li>
            } @empty { <li class="sub">No gifts match.</li> }
          </ul>
          <div class="panel-head border-t border-[var(--hair)]"><div><h2>Top campaigns</h2></div></div>
          <ul class="bars">
            @for (b of byCampaign(); track b.label) {
              <li><span class="b-name">{{ b.label }}</span><span class="b-track"><span [style.width.%]="(b.cents / maxCampaign()) * 100"></span></span><span class="b-val">{{ compact(b.cents) }}</span></li>
            }
          </ul>
        </section>
      </div>

      <section class="mt-5" aria-labelledby="l-h">
        <div class="section-head"><h2 id="l-h">Ledger</h2><p>Newest first, grouped by month</p></div>
        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">Gifts, newest first, grouped by month</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Donor</th><th scope="col">Campaign</th><th scope="col">Source</th><th scope="col">Status</th><th scope="col" class="num">Amount</th></tr></thead>
            @for (m of months().slice(0, shownMonths()); track m.key) {
              <tbody>
                <tr class="month"><th scope="rowgroup" colspan="5">{{ m.label }} <span class="sub inline">{{ m.items.length }} gifts</span></th><td class="num font-semibold">{{ money(m.net) }}</td></tr>
                @for (r of m.items; track r.gift.id) {
                  <tr>
                    <td class="nowrap sub">{{ dateShort(r.gift.occurred_at) }}</td>
                    <th scope="row"><a [routerLink]="['/donors', r.gift.donor_id]">{{ r.donor }}</a></th>
                    <td><span class="block">{{ r.campaign }}</span><span class="sub">{{ r.program }}</span></td>
                    <td><span class="tag">{{ sourceLabel[r.gift.source] }}</span></td>
                    <td><span class="tag" [class.solid]="r.gift.status === 'settled'" [class.warn]="r.gift.status === 'pending'" [class.dashed]="r.gift.status === 'void'">{{ r.gift.status }}</span></td>
                    <td class="num"><span class="font-semibold">{{ money(r.gift.amount_cents) }}</span>
                      @if (r.gift.refund_cents) { <span class="sub">−{{ money(r.gift.refund_cents) }} refunded</span> }</td>
                  </tr>
                }
              </tbody>
            } @empty {
              <tbody><tr><td colspan="6"><div class="empty"><h3>No gifts match</h3><p>Change the filters above.</p></div></td></tr></tbody>
            }
          </table>
        </div>
        @if (months().length > shownMonths()) {
          <div class="mt-3 flex items-center justify-center gap-3">
            <span class="sub inline">Showing {{ shownMonths() }} of {{ months().length }} months</span>
            <button hlmBtn variant="outline" size="sm" type="button" (click)="shownMonths.set(shownMonths() + 6)">Show more months</button>
          </div>
        }
      </section>
    </div>
  `,
  styles: `
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px; border-radius: 18px; margin-bottom: 16px; }
    .toolbar .select { min-width: 150px; height: 40px; border-radius: 12px; }
    .toolbar .grow { flex: 1; min-width: 220px; }
    .top { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: 20px; }
    .sub { font-size: 12.5px; color: var(--muted-foreground); display: block; }
    .sub.inline { display: inline; margin-inline-start: 6px; font-weight: 400; }
    .mini { display: flex; gap: 20px; margin: 0; flex-wrap: wrap; }
    .mini dt { font-size: 11.5px; color: var(--muted-foreground); }
    .mini dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
    .mini .net { color: var(--green-700); }
    .bars { list-style: none; margin: 0; padding: 12px 18px; display: flex; flex-direction: column; gap: 10px; }
    .bars li { display: grid; grid-template-columns: 120px minmax(0, 1fr) 56px; align-items: center; gap: 10px; font-size: 13px; }
    .b-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .b-track { height: 8px; border-radius: 999px; background: rgb(15 26 21 / 0.06); overflow: hidden; }
    .b-track span { display: block; height: 100%; border-radius: 999px; background: var(--green-600); }
    .b-val { text-align: end; font-weight: 600; font-variant-numeric: tabular-nums; }
    tr.month th, tr.month td { background: rgb(255 255 255 / 0.55); font-size: 13px; padding-block: 10px; }
    .nowrap { white-space: nowrap; }
    @media (max-width: 1100px) { .top { grid-template-columns: 1fr; } }
  `,
})
export class DonationsPage {
  protected readonly store = inject(Store);
  protected readonly money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: this.store.currency(), minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
  protected readonly date = date;
  protected readonly dateShort = dateShort;
  protected readonly compact = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: this.store.currency(), notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100);
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly sources = Object.keys(SOURCE_LABEL) as Source[];
  protected readonly year = signal('');
  protected readonly campaign = signal('');
  protected readonly source = signal('');
  protected readonly status = signal('');
  protected readonly shownMonths = signal(3);
  protected val(e: Event) { return (e.target as HTMLSelectElement).value; }

  protected readonly years = computed(() =>
    [...new Set(this.store.ledgerGifts().map((g) => phoenixDay(g.occurred_at).slice(0, 4)))].sort().reverse());

  protected readonly rows = computed<Row[]>(() => this.store.ledgerGifts()
    .filter((g) => !this.year() || phoenixDay(g.occurred_at).startsWith(this.year()))
    .filter((g) => !this.campaign() || (this.campaign() === 'none' ? !g.campaign_id : g.campaign_id === this.campaign()))
    .filter((g) => !this.source() || g.source === this.source())
    .filter((g) => !this.status() || g.status === this.status())
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .map((gift) => {
      const campaign = this.store.campaign(gift.campaign_id);
      return {
        gift,
        donor: this.store.historicalDonor(gift.donor_id)?.name ?? 'Unknown',
        campaign: campaign?.title ?? 'General support',
        program: this.store.program(campaign?.program_id ?? null)?.title ?? 'Unrestricted',
      };
    }));

  protected readonly totals = computed(() => {
    let gross = 0, refunds = 0;
    for (const { gift } of this.rows()) {
      if (gift.status !== 'settled') continue;
      gross += gift.amount_cents; refunds += gift.refund_cents;
    }
    return { gross, refunds, net: gross - refunds };
  });


  private net(g: { status: string; amount_cents: number; refund_cents: number }) { return g.status === 'settled' ? g.amount_cents - g.refund_cents : 0; }

  protected readonly months = computed(() => {
    const groups = new Map<string, { key: string; label: string; net: number; items: Row[] }>();
    for (const r of this.rows()) {
      const key = phoenixDay(r.gift.occurred_at).slice(0, 7);
      const g = groups.get(key) ?? { key, label: new Date(`${key}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), net: 0, items: [] };
      g.items.push(r); g.net += this.net(r.gift); groups.set(key, g);
    }
    return [...groups.values()];
  });

  protected readonly monthOptions = computed<EChartsCoreOption>(() => {
    const series = [...this.months()].reverse().slice(-18);
    return {
      ...BASE,
      grid: { left: 4, right: 8, top: 16, bottom: 4, containLabel: true },
      tooltip: { ...BASE.tooltip, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(0,122,61,0.06)' } }, valueFormatter: (v: unknown) => this.money(Number(v)) },
      xAxis: { type: 'category', data: series.map((m) => `${SHORT[Number(m.key.slice(5, 7)) - 1]} ’${m.key.slice(2, 4)}`), axisLine, axisTick, axisLabel: { color: INK_MUTED, fontSize: 11 } },
      yAxis: { type: 'value', axisLabel: { color: INK_MUTED, formatter: this.compact }, splitLine },
      series: [{ name: 'Net giving', type: 'bar', data: series.map((m) => m.net), barMaxWidth: 28, itemStyle: { color: GREEN, borderRadius: [6, 6, 0, 0] } }],
    };
  });

  private breakdown(key: (r: Row) => string) {
    const totals = new Map<string, number>();
    for (const r of this.rows()) totals.set(key(r), (totals.get(key(r)) ?? 0) + this.net(r.gift));
    return [...totals.entries()].map(([label, cents]) => ({ label, cents })).filter((x) => x.cents > 0).sort((a, b) => b.cents - a.cents);
  }
  protected readonly bySource = computed(() => this.breakdown((r) => SOURCE_LABEL[r.gift.source]));
  protected readonly byCampaign = computed(() => this.breakdown((r) => r.campaign).slice(0, 5));
  protected readonly maxSource = computed(() => Math.max(1, ...this.bySource().map((b) => b.cents)));
  protected readonly maxCampaign = computed(() => Math.max(1, ...this.byCampaign().map((b) => b.cents)));

  protected exportCsv() {
    if (!this.store.isAdmin()) return;
    downloadCsv('cic-donations.csv', [
      ['Date', 'Donor', 'Campaign', 'Program', 'Source', 'Status', `Amount (${this.store.currency()})`, `Refund (${this.store.currency()})`],
      ...this.rows().map((r) => [
        phoenixDay(r.gift.occurred_at), r.donor, r.campaign, r.program, SOURCE_LABEL[r.gift.source], r.gift.status,
        (r.gift.amount_cents / 100).toFixed(2), (r.gift.refund_cents / 100).toFixed(2),
      ]),
    ]);
  }
}
