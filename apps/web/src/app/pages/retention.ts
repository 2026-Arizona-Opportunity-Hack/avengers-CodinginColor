import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { toast } from '@spartan-ng/brain/sonner';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsCoreOption } from 'echarts/core';
import { CountUp } from '../shared/count-up';
import { BASE, BLUE, GREEN, INK, INK_MUTED, axisLine, axisTick, splitLine } from '../shared/chart-theme';
import { RouterLink } from '@angular/router';
import { Store } from '../core/store';
import { date, money, pct, today } from '../core/format';
import { RetentionResult, SEGMENTS, SEGMENT_COPY, Segment, retention, yearWindows, ytdWindows } from '../core/retention';
import { Api, ApiError, ApiRetention } from '../core/api';
import { SOURCE_LABEL } from '../core/models';

/** Server report (USD) in the page's shape. Segment rules are identical; see core/retention.ts. */
function fromServer(report: ApiRetention): RetentionResult {
  const c = report.byCurrency['USD'];
  const counts = Object.fromEntries(SEGMENTS.map((s) => [s, c?.segments[s]?.donors ?? 0])) as RetentionResult['counts'];
  const cents = Object.fromEntries(SEGMENTS.map((s) => [s, { prior: c?.segments[s]?.prior_cents ?? 0, current: c?.segments[s]?.current_cents ?? 0 }])) as RetentionResult['cents'];
  return {
    windows: report.windows, counts, cents,
    donors: (c?.donors ?? []).filter((d): d is typeof d & { segment: Segment } => (SEGMENTS as readonly string[]).includes(d.segment)),
    retained: c?.retention.retained_donors ?? 0, priorDonors: c?.retention.prior_donors ?? 0,
    totals: { prior: c?.totals.prior_cents ?? 0, current: c?.totals.current_cents ?? 0 },
  };
}

@Component({
  selector: 'app-retention',
  imports: [RouterLink, NgIcon, HlmButtonImports, NgxEchartsDirective, CountUp],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Retention</h1>
          <p class="lede">Who stayed, grew, shrank or left, year over year.</p>
        </div>
        <div class="segmented" role="group" aria-label="Period">
          @for (p of store.live() ? periods.slice(0, 1) : periods; track p.value) {
            <button type="button" [attr.aria-pressed]="period() === p.value" (click)="period.set(p.value); selected.set(null)">{{ p.label }}</button>
          }
        </div>
      </header>
      <p class="window"><ng-icon name="lucideCalendar" size="14" aria-hidden="true" /> {{ windowLabel() }}</p>
      @if (store.live()) {
        <p class="window" role="status">{{ serverError() ?? (server() ? 'Computed by the server from the gifts you can see.' : 'Loading the report from the server…') }}</p>
      }

      <section class="kpis" aria-label="Retention summary">
        <article class="kpi glass"><p class="k-label">Retention rate</p>
          <p class="k-value"><app-count-up [value]="rate()" [format]="percent" /></p>
          <p class="k-sub">{{ r().retained }} of {{ r().priorDonors }} prior donors gave again</p></article>
        <article class="kpi glass"><p class="k-label">Activated</p>
          <p class="k-value"><app-count-up [value]="r().counts.new + r().counts.reactivated" /></p>
          <p class="k-sub">{{ r().counts.new }} new · {{ r().counts.reactivated }} came back</p></article>
        <article class="kpi glass"><p class="k-label">Lapsed</p>
          <p class="k-value"><app-count-up [value]="r().counts.lapsed" /></p>
          <p class="k-sub">{{ money(r().cents.lapsed.prior) }} at risk from last period</p></article>
        <article class="kpi glass"><p class="k-label">Net raised</p>
          <p class="k-value"><app-count-up [value]="r().totals.current / 100" [format]="dollars" /></p>
          <p class="k-sub">vs {{ money(r().totals.prior) }} last period</p></article>
      </section>

      <div class="main-grid">
        <section class="panel" aria-labelledby="flow-h">
          <div class="panel-head"><h2 id="flow-h">Donor flow</h2></div>
          <div echarts [options]="flowOptions()" [initOpts]="{ renderer: 'svg' }" class="h-[330px] px-3 pb-3"></div>
          <p class="sr-only">{{ r().priorDonors }} donors last period: {{ r().retained }} kept, {{ r().counts.lapsed }} lapsed. This period adds {{ r().counts.new }} new and {{ r().counts.reactivated }} reactivated donors.</p>
        </section>

        <section class="panel" aria-labelledby="seg-h">
          <div class="panel-head"><h2 id="seg-h">Segments</h2></div>
          <ul class="segs">
            @for (s of segments; track s) {
              <li>
                <button type="button" class="seg" [attr.data-seg]="s" [attr.aria-pressed]="selected() === s" (click)="selected.set(selected() === s ? null : s)">
                  <span class="seg-icon" aria-hidden="true"><ng-icon [name]="segIcon[s]" size="16" /></span>
                  <span class="min-w-0 flex-1 text-start">
                    <span class="block text-[13.5px] font-semibold">{{ copy[s].label }}</span>
                    <span class="block truncate text-xs text-[var(--ink-600)]">{{ copy[s].rule }}</span>
                  </span>
                  <span class="text-end">
                    <span class="block text-lg font-semibold tabular-nums">{{ r().counts[s] }}</span>
                    <span class="block text-xs tabular-nums" [class.up]="change(s) > 0" [class.down]="change(s) < 0">{{ signed(change(s)) }}</span>
                  </span>
                </button>
              </li>
            }
          </ul>
        </section>
      </div>

      @if (selected(); as s) {
        <section class="drill glass" role="region" [attr.aria-label]="copy[s].label + ' donors'">
          <div class="drill-head">
            <div><h2>{{ copy[s].label }} · {{ drill().length }} donors</h2>
              <p class="sub">{{ s === 'lapsed' ? 'Lapsed-donor radar: draft a nudge for each, then approve it in Outreach.' : copy[s].rule }}</p></div>
            <button hlmBtn variant="ghost" size="sm" type="button" (click)="selected.set(null)"><ng-icon name="lucideX" size="16" /> Close</button>
          </div>
          <ul class="drill-list">
            @for (d of drill(); track d.donor_id) {
              <li>
                <span class="d-avatar" aria-hidden="true">{{ store.initials(name(d.donor_id)) }}</span>
                <div class="min-w-0 flex-1">
                  <a class="font-semibold no-underline hover:underline" [routerLink]="['/donors', d.donor_id]">{{ name(d.donor_id) }}</a>
                  <p class="sub">{{ store.member(store.donor(d.donor_id)?.owner_id ?? null)?.name ?? 'Owner not visible' }}</p>
                </div>
                <div class="amounts"><span class="sub">{{ money(d.prior_cents) }}</span><ng-icon name="lucideArrowRight" size="13" aria-hidden="true" /><span class="font-semibold">{{ money(d.current_cents) }}</span></div>
                @if (s === 'lapsed') {
                  @if (nudged().has(d.donor_id)) { <span class="tag solid"><ng-icon name="lucideCheck" size="12" aria-hidden="true" />Drafted</span> }
                  @else { <button hlmBtn variant="outline" size="sm" type="button" (click)="nudge(d.donor_id)">Draft nudge</button> }
                }
              </li>
            } @empty { <li class="sub">No donors in this segment.</li> }
          </ul>
        </section>
      }

      <div class="grid-2 mt-5">
        <section class="panel" aria-labelledby="yoy-h">
          <div class="panel-head"><h2 id="yoy-h">Activation and churn by year</h2></div>
          <div echarts [options]="yoyOptions()" [initOpts]="{ renderer: 'svg' }" class="h-[260px] px-3 pb-3"></div>
          <details class="data">
            <summary>View the numbers</summary>
            <div class="overflow-x-auto"><table class="table">
              <caption class="sr-only">Year over year retention</caption>
              <thead><tr><th scope="col">Year</th><th scope="col" class="num">Giving</th><th scope="col" class="num">New</th><th scope="col" class="num">Back</th><th scope="col" class="num">Kept</th><th scope="col" class="num">Lapsed</th><th scope="col" class="num">Retention</th><th scope="col" class="num">Net raised</th></tr></thead>
              <tbody>@for (y of years(); track y.year) {
                <tr><th scope="row">{{ y.year }}</th><td class="num">{{ y.giving }}</td><td class="num">{{ y.r.counts.new }}</td><td class="num">{{ y.r.counts.reactivated }}</td>
                  <td class="num">{{ y.r.retained }}</td><td class="num">{{ y.r.counts.lapsed }}</td><td class="num">{{ pct(y.r.retained, y.r.priorDonors) }}</td><td class="num">{{ money(y.r.totals.current) }}</td></tr>
              }</tbody>
            </table></div>
          </details>
        </section>

        <div class="flex flex-col gap-5">
          @if (store.isAdmin()) {
            <section class="panel" aria-labelledby="own-h">
              <div class="panel-head"><h2 id="own-h">By board member</h2></div>
              <ul class="bars">
                @for (o of byOwner(); track o.name) {
                  <li>
                    <span class="b-name">{{ o.name }}</span>
                    <span class="b-track" role="img" [attr.aria-label]="o.kept + ' kept, ' + o.lapsed + ' lapsed'">
                      <span class="b-kept" [style.flex-grow]="o.kept"></span><span class="b-lost" [style.flex-grow]="o.lapsed"></span></span>
                    <span class="b-val">{{ pct(o.kept, o.kept + o.lapsed) }}</span>
                  </li>
                }
              </ul>
              <p class="legend"><span><i class="sw kept"></i>Kept</span><span><i class="sw lost"></i>Lapsed</span></p>
            </section>
          }
          @if (!store.live()) {
            <section class="panel" aria-labelledby="src-h">
              <div class="panel-head"><h2 id="src-h">Where new donors came from</h2></div>
              <ul class="bars">
                @for (s of newBySource(); track s.label) {
                  <li><span class="b-name">{{ s.label }}</span>
                    <span class="b-track"><span class="b-kept" [style.width.%]="(s.n / maxSource()) * 100"></span></span>
                    <span class="b-val">{{ s.n }}</span></li>
                } @empty { <li class="sub">No new donors this period.</li> }
              </ul>
            </section>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    .window { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted-foreground); margin: -12px 0 16px; }
    .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
    .kpi { border-radius: 20px; padding: 18px 20px; }
    .k-label { font-size: 13px; font-weight: 500; color: var(--muted-foreground); }
    .k-value { font-size: 30px; font-weight: 600; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; margin-top: 4px; }
    .k-sub { font-size: 12.5px; color: var(--muted-foreground); }
    .main-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 20px; margin-top: 20px; }
    .sub { font-size: 12.5px; color: var(--muted-foreground); margin-top: 2px; }
    .segs { list-style: none; margin: 0; padding: 8px; display: flex; flex-direction: column; gap: 2px; }
    .seg { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 14px; border: 1px solid transparent; background: transparent; cursor: pointer;
      transition: background-color 120ms var(--ease), border-color 120ms var(--ease); }
    .seg:hover { background: rgb(255 255 255 / 0.7); }
    .seg[aria-pressed='true'] { background: #fff; border-color: rgb(0 122 61 / 0.35); box-shadow: 0 1px 3px rgb(15 50 30 / 0.1); }
    .seg-icon { width: 32px; height: 32px; flex: none; border-radius: 10px; display: grid; place-items: center; background: var(--green-50); color: var(--green-700); }
    .seg[data-seg='lapsed'] .seg-icon, .seg[data-seg='decreased'] .seg-icon { background: #fef3f2; color: var(--red-600); }
    .seg[data-seg='flat'] .seg-icon { background: rgb(15 26 21 / 0.05); color: var(--ink-600); }
    .drill { margin-top: 20px; border-radius: 22px; padding: 18px 20px; }
    .drill-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
    .drill-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 8px; }
    .drill-list li { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 14px; background: rgb(255 255 255 / 0.7); border: 1px solid var(--border); }
    .d-avatar { width: 32px; height: 32px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--green-50); color: var(--green-700); font-size: 11.5px; font-weight: 600; }
    .amounts { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; white-space: nowrap; }
    .amounts ng-icon { color: var(--ink-400); }
    .data { padding: 0 18px 16px; }
    .data summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--primary); padding: 4px 0 10px; }
    .bars { list-style: none; margin: 0; padding: 12px 18px; display: flex; flex-direction: column; gap: 12px; }
    .bars li { display: grid; grid-template-columns: 130px minmax(0, 1fr) 48px; align-items: center; gap: 12px; font-size: 13.5px; }
    .b-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .b-track { display: flex; gap: 2px; height: 10px; border-radius: 999px; overflow: hidden; background: rgb(15 26 21 / 0.06); }
    .b-kept { background: var(--green-600); border-radius: 999px; min-width: 2px; }
    .b-lost { background: #2a78d6; border-radius: 999px; }
    .b-val { text-align: end; font-variant-numeric: tabular-nums; font-weight: 600; }
    .legend { display: flex; gap: 16px; padding: 0 18px 14px; font-size: 12.5px; color: var(--muted-foreground); }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .sw { width: 12px; height: 8px; border-radius: 4px; display: inline-block; }
    .sw.kept { background: var(--green-600); } .sw.lost { background: #2a78d6; }
    @media (max-width: 1180px) { .main-grid { grid-template-columns: 1fr; } }
    @media (max-width: 1100px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 640px) { .kpis { grid-template-columns: 1fr; } .bars li { grid-template-columns: 100px 1fr 40px; } }
  `,
})
export class RetentionPage {
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  protected readonly server = signal<RetentionResult | null>(null);
  protected readonly serverError = signal<string | null>(null);
  protected readonly serverNames = signal(new Map<string, string>());
  protected readonly money = money;
  protected readonly pct = pct;
  protected readonly copy = SEGMENT_COPY;
  protected readonly segments = SEGMENTS;
  protected readonly now = today();
  protected readonly thisYear = Number(this.now.slice(0, 4));
  protected readonly periods = [
    { value: 'ytd', label: `${this.thisYear} to date` },
    { value: String(this.thisYear - 1), label: String(this.thisYear - 1) },
    { value: String(this.thisYear - 2), label: String(this.thisYear - 2) },
  ];
  protected readonly period = signal('ytd');
  protected readonly selected = signal<Segment | null>(null);
  protected readonly nudged = signal(new Set<string>());

  private readonly windows = computed(() => (this.period() === 'ytd' ? ytdWindows(this.now) : yearWindows(Number(this.period()))));
  protected readonly r = computed(() => this.store.live()
    ? this.server() ?? retention([], this.windows())
    : retention(this.store.gifts(), this.windows()));
  protected readonly windowLabel = computed(() => {
    const w = this.r().windows;
    const end = (s: string) => date(new Date(Date.parse(s) - 1).toISOString());
    return `This period ${date(w.current.from)} – ${end(w.current.to)} · last period ${date(w.prior.from)} – ${end(w.prior.to)}`;
  });
  protected readonly currentDonors = computed(() => {
    const c = this.r().counts;
    return c.new + c.reactivated + c.increased + c.flat + c.decreased;
  });

  protected readonly dollars = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  protected readonly percent = (n: number) => `${Math.round(n)}%`;
  protected readonly segIcon: Record<Segment, string> = {
    new: 'lucideUserPlus', reactivated: 'lucideRotateCcw', increased: 'lucideTrendingUp', flat: 'lucideRepeat', decreased: 'lucideTrendingDown', lapsed: 'lucideCircleAlert',
  };
  protected readonly rate = computed(() => (this.r().priorDonors ? (this.r().retained / this.r().priorDonors) * 100 : 0));
  protected change(s: Segment) { return this.r().cents[s].current - this.r().cents[s].prior; }
  protected name(id: string) { return this.store.donor(id)?.name ?? this.serverNames().get(id) ?? 'Donor'; }
  protected readonly maxSource = computed(() => Math.max(1, ...this.newBySource().map((s) => s.n)));

  private readonly periodNames = computed(() => {
    const p = this.period();
    return p === 'ytd' ? { prior: `${this.thisYear - 1} to date`, current: `${this.thisYear} to date` } : { prior: String(Number(p) - 1), current: p };
  });

  /** Sankey: last period's donors split into kept and lapsed; kept, new and reactivated make this period. */
  protected readonly flowOptions = computed<EChartsCoreOption>(() => {
    const r = this.r(), n = this.periodNames();
    const prior = `${n.prior} donors`, current = `${n.current} donors`;
    const links = [
      { source: prior, target: 'Kept', value: r.retained },
      { source: prior, target: 'Lapsed', value: r.counts.lapsed },
      { source: 'Kept', target: current, value: r.retained },
      { source: 'New', target: current, value: r.counts.new },
      { source: 'Reactivated', target: current, value: r.counts.reactivated },
    ].filter((l) => l.value > 0);
    // Validated pairs (dataviz validate_palette): Kept/Lapsed green/blue, New/Reactivated violet/yellow; every node is labeled.
    const color: Record<string, string> = { [prior]: '#005c2e', [current]: '#005c2e', Kept: GREEN, Lapsed: BLUE, New: '#6250d6', Reactivated: '#eda100' };
    const used = new Set(links.flatMap((l) => [l.source, l.target]));
    return {
      ...BASE,
      tooltip: { ...BASE.tooltip, trigger: 'item', formatter: (p: { dataType: string; name: string; value: number; data: { source?: string; target?: string } }) =>
        p.dataType === 'edge' ? `${p.data.source} → ${p.data.target}: <b>${p.value}</b>` : `${p.name}: <b>${p.value}</b>` },
      series: [{
        type: 'sankey', left: 8, right: 150, top: 16, bottom: 16, nodeWidth: 14, nodeGap: 18, draggable: false, layoutIterations: 0,
        emphasis: { focus: 'adjacency' },
        data: [prior, 'Kept', 'Lapsed', 'New', 'Reactivated', current].filter((x) => used.has(x)).map((name) => ({ name, itemStyle: { color: color[name], borderRadius: 4 } })),
        links, lineStyle: { color: 'gradient', opacity: 0.28, curveness: 0.5 },
        label: { color: INK, fontWeight: 600, fontSize: 12.5, formatter: (p: { name: string; value: number }) => `${p.name}  ${p.value}` },
      }],
    };
  });

  protected readonly yoyOptions = computed<EChartsCoreOption>(() => {
    const ys = [...this.years()].reverse();
    return {
      ...BASE,
      grid: { left: 4, right: 8, top: 36, bottom: 4, containLabel: true },
      legend: { top: 0, left: 4, icon: 'roundRect', itemWidth: 14, itemHeight: 8, textStyle: { color: INK_MUTED, fontSize: 12.5 } },
      tooltip: { ...BASE.tooltip, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(0,122,61,0.06)' } } },
      xAxis: { type: 'category', data: ys.map((y) => `${y.year}\n${pct(y.r.retained, y.r.priorDonors)} kept`), axisLine, axisTick, axisLabel: { color: INK_MUTED, lineHeight: 16 } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: INK_MUTED }, splitLine },
      series: [
        { name: 'Gained (new and returning)', type: 'bar', barGap: '12%', barWidth: 26, data: ys.map((y) => y.r.counts.new + y.r.counts.reactivated),
          itemStyle: { color: GREEN, borderRadius: [6, 6, 0, 0] }, label: { show: true, position: 'top', color: INK, fontWeight: 600 } },
        { name: 'Lost (lapsed)', type: 'bar', barWidth: 26, data: ys.map((y) => y.r.counts.lapsed),
          itemStyle: { color: BLUE, borderRadius: [6, 6, 0, 0] }, label: { show: true, position: 'top', color: INK, fontWeight: 600 } },
      ],
    };
  });

  protected readonly drill = computed(() => {
    const s = this.selected();
    return this.r().donors.filter((d) => d.segment === s).sort((a, b) => b.prior_cents + b.current_cents - (a.prior_cents + a.current_cents));
  });

  protected readonly years = computed(() => this.store.live()
    ? [{ year: this.thisYear, r: this.r(), giving: this.r().counts.new + this.r().counts.reactivated + this.r().retained }]
    : [this.thisYear - 2, this.thisYear - 1, this.thisYear].map((year) => {
    const r = retention(this.store.gifts(), year === this.thisYear ? ytdWindows(this.now) : yearWindows(year));
    return { year, r, giving: r.counts.new + r.counts.reactivated + r.retained };
  }).reverse());

  protected readonly byOwner = computed(() => this.store.boardMembers().map((m) => {
    const mine = this.r().donors.filter((d) => this.store.donor(d.donor_id)?.owner_id === m.id);
    return {
      name: m.name,
      kept: mine.filter((d) => ['increased', 'flat', 'decreased'].includes(d.segment)).length,
      lapsed: mine.filter((d) => d.segment === 'lapsed').length,
    };
  }));

  protected readonly newBySource = computed(() => {
    const counts = new Map<string, number>();
    for (const d of this.r().donors.filter((x) => x.segment === 'new')) {
      const first = this.store.giftsFor(d.donor_id).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))[0];
      const label = first ? SOURCE_LABEL[first.source] : 'Unknown';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
  });

  constructor() {
    // Never keep a server report past the session that fetched it.
    effect(() => {
      if (this.store.signedIn()) return;
      this.server.set(null);
      this.serverNames.set(new Map());
    });
    if (!this.store.live()) return;
    const epoch = this.store.sessionEpoch();
    this.api.retention(this.now).then((report) => {
      if (this.store.sessionEpoch() !== epoch || !this.store.signedIn()) return;
      this.server.set(fromServer(report));
      this.serverNames.set(new Map((report.byCurrency['USD']?.donors ?? []).filter((d) => d.name).map((d) => [d.donor_id, d.name!])));
    }).catch((e) => {
      if (this.store.sessionEpoch() !== epoch) return;
      this.serverError.set(e instanceof ApiError ? e.message : 'The retention report could not load.');
    });
  }

  protected signed(cents: number) {
    return `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${money(Math.abs(cents))}`;
  }

  protected nudge(donorId: string) {
    if (!this.store.createDraft(donorId, 't-nudge', 'Lapsed: gave last period, not this period')) return;
    this.nudged.update((s) => new Set(s).add(donorId));
    toast.success(`Nudge drafted for ${this.name(donorId)}`, { description: 'Approve it in Outreach before it is sent.' });
  }
}
