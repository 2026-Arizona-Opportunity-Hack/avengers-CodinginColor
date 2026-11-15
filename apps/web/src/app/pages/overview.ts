import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsCoreOption } from 'echarts/core';
import { Store } from '../core/store';
import { ReportFilters } from '../core/report-filters';
import { ReportFiltersControl } from '../shared/report-filters';
import { Api, ApiError, type ApiRetention } from '../core/api';
import { retentionFromServer } from '../core/report-models';
import { date, dateShort, money, pct, relativeDue, today } from '../core/format';
import { SEGMENTS, SEGMENT_COPY, retention, yearWindows, ytdWindows } from '../core/retention';
import { SOURCE_LABEL } from '../core/models';
import { CountUp } from '../shared/count-up';
import { Sparkline } from '../shared/sparkline';
import { BASE, BLUE, GREEN, INK, INK_MUTED, axisLine, axisTick, splitLine } from '../shared/chart-theme';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Insight { icon: string; tone: 'danger' | 'attention' | 'positive' | 'neutral'; text: string; action: string; path: string; query?: Record<string, string>; }

@Component({
  selector: 'app-overview',
  imports: [ReportFiltersControl, RouterLink, NgIcon, HlmButtonImports, NgxEchartsDirective, CountUp, Sparkline],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.live()) { <app-report-filters /> }
    @if (store.live() && !server()) { <p role="status">{{ serverError() ?? 'Loading overview...' }}</p> } @else {
    <div class="page">
      <header class="page-head">
        <div>
          <h1>{{ store.isAdmin() ? 'Organization health' : 'Your portfolio' }}</h1>
          <p class="lede">{{ scope.from() }} to {{ scope.through() }} in {{ store.currency() }}, compared with the same calendar period last year.</p>
        </div>
        <div class="actions">
          <a hlmBtn variant="outline" routerLink="/outreach">Follow-ups</a>
          @if (!store.live()) { <a hlmBtn routerLink="/donors/new"><ng-icon name="lucidePlus" size="16" /> Add donor</a> }
        </div>
      </header>

      <section class="hero glass" aria-label="Key numbers">
        <div class="hero-main">
          <p class="k-label">Raised, net</p>
          <p class="hero-value"><app-count-up [value]="r().totals.current / 100" [format]="dollars" /></p>
          <p class="hero-sub">
            <span [class]="trendClass(r().totals.current, r().totals.prior)"><ng-icon [name]="trendIcon(r().totals.current, r().totals.prior)" size="14" aria-hidden="true" />{{ delta(r().totals.current, r().totals.prior) }}</span>
            vs {{ money(r().totals.prior) }} by this date last year
          </p>
          <app-sparkline class="hero-spark" [values]="monthlyNet()" />
        </div>
        <dl class="hero-side">
          <div>
            <dt>Donors giving</dt>
            <dd><app-count-up [value]="givingDonors()" /><span [class]="trendClass(givingDonors(), r().priorDonors)"><ng-icon [name]="trendIcon(givingDonors(), r().priorDonors)" size="13" aria-hidden="true" />{{ delta(givingDonors(), r().priorDonors) }}</span></dd>
            <dd class="note">{{ r().counts.new }} new · {{ r().counts.reactivated }} came back</dd>
          </div>
          <div>
            <dt>Retention</dt>
            <dd><app-count-up [value]="retentionPct()" [format]="percent" /></dd>
            <dd class="note">{{ r().retained }} of {{ r().priorDonors }} last-year donors gave again</dd>
          </div>
          <div>
            <dt>Next steps this week</dt>
            <dd><app-count-up [value]="due().length" />@if (overdue() > 0) { <span class="trend down">{{ overdue() }} overdue</span> }</dd>
            <dd class="note"><a routerLink="/outreach">Open the queue</a></dd>
          </div>
        </dl>
      </section>

      <div class="grid-main">
        <section class="panel chart-panel" aria-labelledby="pulse-h">
          <div class="panel-head">
            <h2 id="pulse-h">Giving pulse</h2>
          </div>
          <div echarts [options]="pulseOptions()" [initOpts]="{ renderer: 'svg' }" class="chart h-[300px]"></div>
          <table class="sr-only">
            <caption>Cumulative net giving by month</caption>
            <thead><tr><th scope="col">Month</th><th scope="col">{{ year }}</th><th scope="col">{{ year - 1 }}</th></tr></thead>
            <tbody>@for (m of months; track m; let i = $index) { <tr><th scope="row">{{ m }}</th><td>{{ cum(year)[i] === null ? '—' : money(cum(year)[i]!) }}</td><td>{{ money(cum(year - 1)[i]!) }}</td></tr> }</tbody>
          </table>
        </section>

        <section class="panel insights" aria-labelledby="ins-h">
          <div class="panel-head"><h2 id="ins-h">What needs attention</h2></div>
          <ul class="ins-list">
            @for (i of insights(); track i.text) {
              <li>
                <span class="ins-dot" [attr.data-tone]="i.tone" aria-hidden="true"></span>
                <div class="min-w-0 flex-1">
                  <p class="text-[13.5px] leading-snug">{{ i.text }}</p>
                  <a class="ins-action" [routerLink]="i.path" [queryParams]="i.query">{{ i.action }}</a>
                </div>
              </li>
            } @empty {
              <li class="text-muted-foreground">Nothing stands out right now. Every follow-up is on track.</li>
            }
          </ul>
        </section>
      </div>

      <div class="grid-3 mt-5">
        <section class="panel" aria-labelledby="mov-h">
          <div class="panel-head"><h2 id="mov-h">Donor movement</h2>
            <a routerLink="/retention" class="head-link">Retention</a></div>
          <div echarts [options]="movementOptions()" [initOpts]="{ renderer: 'svg' }" class="chart h-[240px]"></div>
          <table class="sr-only"><caption>Donors by retention segment</caption><tbody>
            @for (s of segments; track s) { <tr><th scope="row">{{ copy[s].label }}</th><td>{{ r().counts[s] }}</td></tr> }</tbody></table>
        </section>
        <section class="panel" aria-labelledby="prog-h">
          <div class="panel-head"><h2 id="prog-h">Raised by program</h2></div>
          <div echarts [options]="programOptions()" [initOpts]="{ renderer: 'svg' }" class="chart h-[240px]"></div>
          <table class="sr-only"><caption>Net giving by program</caption><tbody>
            @for (p of byProgram(); track p.label) { <tr><th scope="row">{{ p.label }}</th><td>{{ money(p.cents) }}</td></tr> }</tbody></table>
        </section>
        <section class="panel" aria-labelledby="due-h">
          <div class="panel-head"><h2 id="due-h">Due this week</h2>
            <a routerLink="/outreach" class="head-link">All</a></div>
          <ul class="list">
            @for (f of due().slice(0, 5); track f.id) {
              <li class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                  <a class="font-semibold no-underline hover:underline" [routerLink]="['/donors', f.donor_id]">{{ store.donor(f.donor_id)?.name }}</a>
                  <p class="text-muted-foreground truncate text-[13px]">{{ f.action }}</p>
                </div>
                <span class="tag" [class.danger]="f.due_on < now" [class.warn]="f.due_on >= now">{{ relativeDue(f.due_on) }}</span>
              </li>
            } @empty {
              <li class="text-muted-foreground">Nothing due this week.</li>
            }
          </ul>
        </section>
      </div>

      <div class="grid-2 mt-5">
        <section class="panel" aria-labelledby="gifts-h">
          <div class="panel-head"><h2 id="gifts-h">Latest gifts</h2><a [routerLink]="store.live() ? '/donors' : '/donations'" class="head-link">All donors and gifts</a></div>
          <ul class="list">
            @for (g of recentGifts(); track g.id) {
              <li class="flex items-center gap-3">
                <div class="min-w-0 flex-1">
                  <a class="font-semibold no-underline hover:underline" [routerLink]="['/donors', g.donor_id]">{{ store.donor(g.donor_id)?.name }}</a>
                  <p class="text-muted-foreground truncate text-[13px]">{{ store.campaign(g.campaign_id)?.title ?? 'General support' }} · {{ dateShort(g.occurred_at) }}</p>
                </div>
                <span class="num font-semibold">{{ money(store.netCents(g)) }}</span>
              </li>
            }
          </ul>
        </section>

        @if (store.isAdmin()) {
          <section class="panel" aria-labelledby="board-h">
            <div class="panel-head"><h2 id="board-h">Board portfolios</h2></div>
            <ul class="list">
              @for (row of portfolios(); track row.id) {
                <li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5">
                  <a class="font-semibold no-underline hover:underline" [routerLink]="['/donors']" [queryParams]="{ owner: row.id }">{{ row.name }}</a>
                  <span class="num text-[13px]">{{ money(row.raised) }}</span>
                  <div class="bar-track" role="img" [attr.aria-label]="row.reached + ' of ' + row.donors + ' donors reached'"><div class="bar-fill" [style.width.%]="row.donors ? (row.reached / row.donors) * 100 : 0"></div></div>
                  <span class="text-muted-foreground text-xs">{{ row.reached }}/{{ row.donors }} reached
                    @if (row.overdue) { · <span class="ic-danger">{{ row.overdue }} overdue</span> }</span>
                </li>
              }
            </ul>
          </section>
        } @else {
          <section class="panel" aria-labelledby="mine-h">
            <div class="panel-head"><h2 id="mine-h">Your last contacts</h2></div>
            <ul class="list">
              @for (c of recentContacts(); track c.id) {
                <li class="flex items-center gap-3">
                  <span class="gift-dot" aria-hidden="true"><ng-icon [name]="c.kind === 'text' ? 'lucideMessageSquare' : c.kind === 'call' ? 'lucidePhone' : 'lucideMail'" size="15" /></span>
                  <div class="min-w-0 flex-1">
                    <a class="font-semibold no-underline hover:underline" [routerLink]="['/donors', c.donor_id]">{{ store.donor(c.donor_id)?.name }}</a>
                    <p class="text-muted-foreground truncate text-[13px]">{{ c.summary }}</p>
                  </div>
                  <span class="text-muted-foreground text-xs">{{ date(c.occurred_at) }}</span>
                </li>
              } @empty { <li class="text-muted-foreground">No contacts logged yet.</li> }
            </ul>
          </section>
        }
      </div>
    </div>
    }
  `,
  styles: `
    .hero { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1.5fr); border-radius: var(--r-surface); overflow: hidden; }
    .hero-main { padding: 22px 24px 16px; display: flex; flex-direction: column; gap: 2px; }
    .k-label { font-size: 13px; font-weight: 500; color: var(--ink-600); }
    .hero-value { font-size: 44px; font-weight: 600; letter-spacing: -0.035em; line-height: 1.1; font-variant-numeric: tabular-nums; margin-top: 6px; }
    .hero-sub { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--ink-600); margin-top: 6px; }
    .hero-spark { display: block; margin-top: 14px; }
    .hero-side { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-inline-start: 1px solid rgb(15 26 21 / 0.06); }
    .hero-side > div { padding: 22px 22px 18px; display: flex; flex-direction: column; gap: 4px; }
    .hero-side > div + div { border-inline-start: 1px solid rgb(15 26 21 / 0.06); }
    .hero-side dt { font-size: 13px; font-weight: 500; color: var(--ink-600); }
    .hero-side dd { margin: 4px 0 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 26px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .hero-side dd.note { display: block; font-size: 12.5px; font-weight: 400; letter-spacing: 0; color: var(--ink-600); margin-top: auto; }
    .hero-side a { font-weight: 600; color: var(--green-700); text-decoration: none; }
    .hero-side a:hover { text-decoration: underline; }
    .trend { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; font-weight: 600; letter-spacing: 0; padding: 2px 7px; border-radius: 6px; }
    .trend.up { color: var(--green-700); background: var(--green-50); }
    .trend.down { color: var(--red-600); background: #fef0ee; }
    .trend.flat { color: var(--ink-600); background: rgb(15 26 21 / 0.05); }
    .grid-main { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 20px; margin-top: 20px; }
    .sub { font-size: 12.5px; color: var(--muted-foreground); margin-top: 2px; }
    .chart { padding: 8px 12px 12px; }
    .head-link { font-size: 13px; font-weight: 600; color: var(--primary); text-decoration: none; }
    .head-link:hover { text-decoration: underline; }
    .ins-list { list-style: none; margin: 0; padding: 8px 18px 16px; display: flex; flex-direction: column; gap: 14px; }
    .ins-list li { display: flex; gap: 12px; align-items: flex-start; }
    .ins-dot { width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; flex: none; background: var(--ink-400); }
    .ins-dot[data-tone='danger'] { background: var(--red-600); }
    .ins-dot[data-tone='attention'] { background: var(--amber-600); }
    .ins-dot[data-tone='positive'] { background: var(--green-600); }
    .ins-action { display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; font-size: 13px; font-weight: 600; color: var(--primary); text-decoration: none; }
    .ins-action:hover { text-decoration: underline; }
    .gift-dot { width: 32px; height: 32px; border-radius: 10px; flex: none; display: grid; place-items: center; background: var(--green-50); color: var(--green-700); }
    @media (max-width: 1180px) { .grid-main { grid-template-columns: 1fr; } }
    @media (max-width: 1100px) { .hero { grid-template-columns: 1fr; } .hero-side { border-inline-start: 0; border-top: 1px solid rgb(15 26 21 / 0.06); } .grid-3 { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 640px) { .grid-3 { grid-template-columns: 1fr; } .hero-side { grid-template-columns: 1fr; } .hero-side > div + div { border-inline-start: 0; border-top: 1px solid rgb(15 26 21 / 0.06); } .hero-value { font-size: 36px; } }
  `,
})
export class OverviewPage {
  protected readonly store = inject(Store);
  protected readonly scope = inject(ReportFilters);
  private readonly api = inject(Api);
  protected readonly server = signal<ApiRetention | null>(null);
  protected readonly serverError = signal<string | null>(null);
  protected readonly money = (cents: number) => money(cents, this.store.currency());
  private readonly compactMoney = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: this.store.currency(), notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100);
  protected readonly date = date;
  protected readonly dateShort = dateShort;
  protected readonly pct = pct;
  protected readonly relativeDue = relativeDue;
  protected readonly months = MONTHS;
  protected readonly segments = SEGMENTS;
  protected readonly copy = SEGMENT_COPY;
  protected readonly now = today();
  protected get year() { return Number(this.scope.through().slice(0, 4)); }
  private get monthIndex() { return Number(this.scope.through().slice(5, 7)) - 1; }
  protected readonly dollars = (n: number) => this.money(n * 100);
  protected readonly percent = (n: number) => `${Math.round(n)}%`;

  protected readonly r = computed(() => this.store.live()
    ? this.server() ? retentionFromServer(this.server()!, this.store.currency()) : retention([], ytdWindows(this.now))
    : retention(this.scope.gifts(), ytdWindows(this.now)));

  private reportGeneration = 0;
  constructor() {
    effect(() => {
      const generation = ++this.reportGeneration;
      const filters = this.scope.query(), asOf = this.scope.through(), valid = this.scope.valid();
      const epoch = this.store.sessionEpoch(), signedIn = this.store.signedIn();
      this.server.set(null); this.serverError.set(null);
      if (!this.store.live() || !signedIn) return;
      if (!valid) { this.serverError.set('Choose a valid reporting period and acquisition year.'); return; }
      void this.api.retention(asOf, filters).then(report => {
        if (generation === this.reportGeneration && epoch === this.store.sessionEpoch() && this.store.signedIn()) this.server.set(report);
      }).catch(error => {
        if (generation === this.reportGeneration && epoch === this.store.sessionEpoch() && this.store.signedIn())
          this.serverError.set(error instanceof ApiError ? error.message : 'The overview could not load.');
      });
    });
  }
  protected readonly givingDonors = computed(() => {
    const c = this.r().counts;
    return c.new + c.reactivated + c.increased + c.flat + c.decreased;
  });
  protected readonly retentionPct = computed(() => (this.r().priorDonors ? (this.r().retained / this.r().priorDonors) * 100 : 0));

  private readonly openSteps = computed(() => this.store.followUps().filter((f) => this.scope.visible(f.donor_id) && f.status === 'open'));
  protected readonly due = computed(() => {
    const horizon = new Date(Date.parse(`${this.now}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    return this.openSteps().filter((f) => f.due_on <= horizon).sort((a, b) => a.due_on.localeCompare(b.due_on));
  });
  protected readonly overdue = computed(() => this.due().filter((f) => f.due_on < this.now).length);

  private phoenixDay(at: string) { return this.scope.day(at); }
  private inPeriod(at: string, year = this.year) {
    const w = year === this.year ? this.r().windows.current : this.r().windows.prior, time = Date.parse(at);
    return time >= Date.parse(w.from) && time < Date.parse(w.to);
  }

  /** Net settled giving per month for a Phoenix calendar year, excluding future gifts. */
  private monthly(year: number): number[] {
    const out = new Array(12).fill(0);
    for (const g of this.scope.gifts()) {
      const day = this.phoenixDay(g.occurred_at);
      if (!this.inPeriod(g.occurred_at, year)) continue;
      out[Number(day.slice(5, 7)) - 1] += this.store.netCents(g);
    }
    return out;
  }
  private readonly cumulative = computed(() => {
    const build = (year: number, until: number) => {
      let run = 0;
      return this.monthly(year).map((v, i) => (i > until ? null : (run += v)));
    };
    return { [this.year]: build(this.year, this.monthIndex), [this.year - 1]: build(this.year - 1, 11) } as Record<number, (number | null)[]>;
  });
  protected cum(year: number) { return this.cumulative()[year] ?? []; }

  protected readonly monthlyNet = computed(() => this.monthly(this.year).slice(0, this.monthIndex + 1));
  protected readonly monthlyDonors = computed(() => {
    const sets = Array.from({ length: this.monthIndex + 1 }, () => new Set<string>());
    for (const g of this.scope.gifts()) {
      const day = this.phoenixDay(g.occurred_at);
      if (!this.inPeriod(g.occurred_at) || this.store.netCents(g) <= 0) continue;
      const m = Number(day.slice(5, 7)) - 1;
      if (m <= this.monthIndex) sets[m].add(g.donor_id);
    }
    return sets.map((s) => s.size);
  });

  protected readonly pulseOptions = computed<EChartsCoreOption>(() => {
    const label = (color: string, dy: number) => ({ show: true, color, fontWeight: 600, fontSize: 12, offset: [4, dy], formatter: (p: { seriesName: string; value: number }) => `${p.seriesName}  ${this.compactMoney(p.value)}` });
    return {
      ...BASE,
      grid: { left: 8, right: 96, top: 36, bottom: 4, containLabel: true },
      legend: { top: 0, left: 4, icon: 'roundRect', itemWidth: 16, itemHeight: 4, itemGap: 18, textStyle: { color: INK_MUTED, fontSize: 12.5 } },
      tooltip: { ...BASE.tooltip, trigger: 'axis', valueFormatter: (v: unknown) => (typeof v === 'number' ? this.money(v) : '—') },
      xAxis: { type: 'category', data: MONTHS, boundaryGap: false, axisLine, axisTick, axisLabel: { color: INK_MUTED } },
      yAxis: { type: 'value', axisLabel: { color: INK_MUTED, formatter: this.compactMoney }, splitLine },
      series: [
        {
          name: String(this.year), type: 'line', data: this.cum(this.year), smooth: 0.3, showSymbol: false, symbolSize: 8,
          lineStyle: { width: 2.5, color: GREEN }, itemStyle: { color: GREEN }, endLabel: label(INK, -10),
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(0,122,61,0.20)' }, { offset: 1, color: 'rgba(0,122,61,0)' }] } },
          emphasis: { focus: 'series' }, z: 3,
        },
        {
          name: String(this.year - 1), type: 'line', data: this.cum(this.year - 1), smooth: 0.3, showSymbol: false, symbolSize: 8,
          lineStyle: { width: 2, type: 'dashed', color: BLUE }, itemStyle: { color: BLUE }, endLabel: label(INK_MUTED, 10), emphasis: { focus: 'series' },
        },
      ],
    };
  });

  protected readonly movementOptions = computed<EChartsCoreOption>(() => ({
    ...BASE,
    grid: { left: 4, right: 8, top: 20, bottom: 4, containLabel: true },
    tooltip: { ...BASE.tooltip, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(0,122,61,0.06)' } } },
    xAxis: { type: 'category', data: SEGMENTS.map((s) => SEGMENT_COPY[s].label), axisLine, axisTick, axisLabel: { color: INK_MUTED, interval: 0, fontSize: 11.5 } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { color: INK_MUTED }, splitLine },
    series: [{
      name: 'Donors', type: 'bar', data: SEGMENTS.map((s) => this.r().counts[s]), barWidth: '52%',
      itemStyle: { color: GREEN, borderRadius: [6, 6, 0, 0] }, label: { show: true, position: 'top', color: INK, fontWeight: 600 },
    }],
  }));

  protected readonly byProgram = computed(() => {
    const totals = new Map<string, number>();
    for (const g of this.scope.gifts()) {
      const day = this.phoenixDay(g.occurred_at);
      if (!this.inPeriod(g.occurred_at) || g.status !== 'settled') continue;
      const program = this.store.program(this.store.campaign(g.campaign_id)?.program_id ?? null)?.title ?? 'Unattributed';
      totals.set(program, (totals.get(program) ?? 0) + this.store.netCents(g));
    }
    return [...totals.entries()].map(([label, cents]) => ({ label, cents })).sort((a, b) => a.cents - b.cents);
  });

  protected readonly programOptions = computed<EChartsCoreOption>(() => ({
    ...BASE,
    grid: { left: 4, right: 56, top: 8, bottom: 4, containLabel: true },
    tooltip: { ...BASE.tooltip, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(0,122,61,0.06)' } }, valueFormatter: (v: unknown) => this.money(Number(v)) },
    xAxis: { type: 'value', axisLabel: { show: false }, splitLine: { show: false } },
    yAxis: { type: 'category', data: this.byProgram().map((p) => p.label), axisLine, axisTick, axisLabel: { color: INK, fontSize: 12.5 } },
    series: [{
      name: 'Net giving', type: 'bar', data: this.byProgram().map((p) => p.cents), barWidth: 14,
      itemStyle: { color: GREEN, borderRadius: [0, 6, 6, 0] },
      label: { show: true, position: 'right', color: INK, fontWeight: 600, formatter: (p: { value: number }) => this.compactMoney(p.value) },
    }],
  }));

  protected readonly recentGifts = computed(() =>
    [...this.scope.gifts()].filter((g) => g.status === 'settled' && this.inPeriod(g.occurred_at)).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0, 6));

  protected readonly recentContacts = computed(() =>
    [...this.store.communications()].filter((c) => this.scope.visible(c.donor_id) && c.direction !== 'internal').sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0, 6));

  protected readonly portfolios = computed(() => {
    const since = new Date(Date.parse(`${this.now}T12:00:00Z`) - 90 * 86_400_000).toISOString();
    return this.store.boardMembers().filter(m => !this.scope.owner() || m.id === this.scope.owner()).map((m) => {
      const donors = this.scope.donors().filter((d) => d.owner_id === m.id);
      const ids = new Set(donors.map((d) => d.id));
      const comms = this.store.communications().filter((c) => ids.has(c.donor_id) && c.direction !== 'internal');
      const steps = this.openSteps().filter((f) => ids.has(f.donor_id));
      return {
        id: m.id, name: m.name, donors: donors.length,
        raised: this.scope.gifts().filter((g) => ids.has(g.donor_id) && this.inPeriod(g.occurred_at)).reduce((s, g) => s + this.store.netCents(g), 0),
        reached: new Set(comms.filter((c) => c.occurred_at >= since).map((c) => c.donor_id)).size,
        overdue: steps.filter((f) => f.due_on < this.now).length,
      };
    });
  });

  /** Rule-based observations, each with the one action that resolves it. */
  protected readonly insights = computed<Insight[]>(() => {
    const out: Insight[] = [];
    const r = this.r();
    const lapsed = r.donors.filter((d) => d.segment === 'lapsed');
    if (lapsed.length) {
      out.push({ icon: 'lucideTrendingDown', tone: 'danger', path: '/retention', action: 'Review lapsed donors',
        text: `${lapsed.length} donor${lapsed.length === 1 ? '' : 's'} who gave ${this.money(lapsed.reduce((s, d) => s + d.prior_cents, 0))} by this date last year ${lapsed.length === 1 ? 'hasn’t' : 'haven’t'} given yet this year.` });
    }
    const overdueByOwner = new Map<string, number>();
    for (const f of this.openSteps()) if (f.due_on < this.now) overdueByOwner.set(f.owner_id, (overdueByOwner.get(f.owner_id) ?? 0) + 1);
    const top = [...overdueByOwner.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const mine = top[0] === this.store.me().id;
      out.push({ icon: 'lucideCalendarClock', tone: 'attention', path: '/outreach', action: 'Open the follow-up queue',
        text: mine ? `You have ${top[1]} overdue follow-up${top[1] === 1 ? '' : 's'}.` : `${this.store.member(top[0])?.name ?? 'A board member'} has ${top[1]} overdue follow-up${top[1] === 1 ? '' : 's'}, the most of anyone.` });
    }
    const pending = this.store.drafts().filter((d) => this.scope.visible(d.donor_id) && d.status === 'pending').length;
    if (pending) out.push({ icon: 'lucideListChecks', tone: 'neutral', path: '/outreach', action: 'Review drafts',
      text: `${pending} drafted message${pending === 1 ? ' is' : 's are'} waiting for a person to approve.` });
    const news = r.donors.filter((d) => d.segment === 'new');
    if (news.length) {
      const bySource = new Map<string, number>();
      for (const d of news) {
        const first = this.scope.gifts().filter(g => g.donor_id === d.donor_id).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))[0];
        if (first) bySource.set(SOURCE_LABEL[first.source], (bySource.get(SOURCE_LABEL[first.source]) ?? 0) + 1);
      }
      const best = [...bySource.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best) out.push({ icon: 'lucideTrendingUp', tone: 'positive', path: '/retention', action: 'See where donors come from',
        text: `${best[0]} brought ${best[1]} of ${news.length} new donors this year.` });
    }
    const grew = r.donors.filter((d) => d.segment === 'increased');
    if (grew.length && out.length < 4) out.push({ icon: 'lucideHeartHandshake', tone: 'positive', path: '/retention', action: 'Thank them',
      text: `${grew.length} donor${grew.length === 1 ? '' : 's'} gave more than last year, adding ${this.money(grew.reduce((s, d) => s + d.current_cents - d.prior_cents, 0))}.` });
    return out.slice(0, 4);
  });

  protected delta(current: number, prior: number) {
    if (prior === 0) return 'New';
    const d = Math.round(((current - prior) / prior) * 100);
    return `${d >= 0 ? '+' : '−'}${Math.abs(d)}%`;
  }
  protected trendClass(current: number, prior: number) {
    return `trend ${current > prior ? 'up' : current < prior ? 'down' : 'flat'}`;
  }
  protected trendIcon(current: number, prior: number) {
    return current >= prior ? 'lucideArrowUpRight' : 'lucideArrowDownRight';
  }
}
