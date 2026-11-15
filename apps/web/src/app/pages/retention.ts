import { Component, computed, inject, signal } from '@angular/core';
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
  imports: [RouterLink],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="label eyebrow">Retention</p>
          <h1>Who stayed, grew, shrank or left</h1>
          <p class="lede">Each donor who gave in either period is placed in exactly one segment by comparing net settled giving this period with last period.</p>
        </div>
        <div class="segmented" role="group" aria-label="Period">
          @for (p of store.live() ? periods.slice(0, 1) : periods; track p.value) {
            <button type="button" [attr.aria-pressed]="period() === p.value" (click)="period.set(p.value); selected.set(null)">{{ p.label }}</button>
          }
        </div>
      </header>

      <p class="window mono">{{ windowLabel() }}</p>
      @if (store.live()) {
        <p class="live-note" role="status">{{ serverError() ?? (server() ? 'Computed by the server from the gifts you can see.' : 'Loading the report from the server…') }}</p>
      }

      <section class="stats" aria-label="Retention summary">
        <div class="stat"><p class="label">Retention rate</p><p class="value">{{ pct(r().retained, r().priorDonors) }}</p>
          <p class="delta">{{ r().retained }} of {{ r().priorDonors }} prior donors gave again</p></div>
        <div class="stat"><p class="label">Activated</p><p class="value">{{ r().counts.new + r().counts.reactivated }}</p>
          <p class="delta">{{ r().counts.new }} new · {{ r().counts.reactivated }} came back</p></div>
        <div class="stat"><p class="label">Lapsed</p><p class="value">{{ r().counts.lapsed }}</p>
          <p class="delta">{{ money(r().cents.lapsed.prior) }} given last period</p></div>
        <div class="stat"><p class="label">Net raised</p><p class="value">{{ money(r().totals.current) }}</p>
          <p class="delta">vs {{ money(r().totals.prior) }} last period</p></div>
      </section>

      <section class="section" aria-labelledby="flow-h">
        <div class="section-head"><h2 id="flow-h">Donor movement</h2><p>Bar length is donor count.</p></div>
        <div class="flow">
          <p class="label">Last period · {{ r().priorDonors }} donors</p>
          <div class="stackbar" aria-hidden="true">
            @for (s of priorBar(); track s.key) { <span [class]="'seg ' + s.style" [style.flex-grow]="s.n"><b>{{ s.n }}</b></span> }
          </div>
          <p class="label">This period · {{ currentDonors() }} donors</p>
          <div class="stackbar" aria-hidden="true">
            @for (s of currentBar(); track s.key) { <span [class]="'seg ' + s.style" [style.flex-grow]="s.n"><b>{{ s.n }}</b></span> }
          </div>
          <ul class="legend">
            <li><span class="swatch solid"></span>Kept (increased, flat, decreased)</li>
            <li><span class="swatch hatch"></span>Lapsed</li>
            <li><span class="swatch outline"></span>New</li>
            <li><span class="swatch dots"></span>Reactivated</li>
          </ul>
        </div>
      </section>

      <section class="section" aria-labelledby="seg-h">
        <div class="section-head"><h2 id="seg-h">Segments</h2><p>Select a segment to list its donors.</p></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th scope="col">Segment</th><th scope="col">Rule</th><th scope="col" class="num">Donors</th><th scope="col" class="num">Last period</th><th scope="col" class="num">This period</th><th scope="col" class="num">Change</th></tr></thead>
            <tbody>
              @for (s of segments; track s) {
                <tr [class.picked]="selected() === s">
                  <th scope="row"><button class="btn link seg-btn" type="button" (click)="selected.set(selected() === s ? null : s)" [attr.aria-expanded]="selected() === s">{{ copy[s].label }}</button></th>
                  <td>{{ copy[s].rule }}</td>
                  <td class="num mono">{{ r().counts[s] }}</td>
                  <td class="num mono">{{ money(r().cents[s].prior) }}</td>
                  <td class="num mono">{{ money(r().cents[s].current) }}</td>
                  <td class="num mono">{{ signed(r().cents[s].current - r().cents[s].prior) }}</td>
                </tr>
              }
            </tbody>
            <tfoot><tr><td>Total</td><td></td><td class="num mono">{{ r().donors.length }}</td><td class="num mono">{{ money(r().totals.prior) }}</td><td class="num mono">{{ money(r().totals.current) }}</td><td class="num mono">{{ signed(r().totals.current - r().totals.prior) }}</td></tr></tfoot>
          </table>
        </div>

        @if (selected(); as s) {
          <div class="drill" role="region" [attr.aria-label]="copy[s].label + ' donors'">
            <div class="section-head"><h3>{{ copy[s].label }}: {{ drill().length }} donors</h3>
              @if (s === 'lapsed') { <p>Lapsed-donor radar: draft a nudge for each, then approve in Outreach.</p> }</div>
            <table class="table">
              <thead><tr><th scope="col">Donor</th><th scope="col">Owner</th><th scope="col" class="num">Last period</th><th scope="col" class="num">This period</th>@if (s === 'lapsed') {<th scope="col"><span class="sr-only">Action</span></th>}</tr></thead>
              <tbody>
                @for (d of drill(); track d.donor_id) {
                  <tr>
                    <th scope="row"><a [routerLink]="['/donors', d.donor_id]">{{ store.donor(d.donor_id)?.name ?? serverNames().get(d.donor_id) }}</a></th>
                    <td>{{ store.member(store.donor(d.donor_id)?.owner_id ?? null)?.name }}</td>
                    <td class="num mono">{{ money(d.prior_cents) }}</td>
                    <td class="num mono">{{ money(d.current_cents) }}</td>
                    @if (s === 'lapsed') {
                      <td class="num">@if (nudged().has(d.donor_id)) { <span class="tag solid">Drafted</span> } @else {
                        <button class="btn small" type="button" (click)="nudge(d.donor_id)">Draft nudge</button> }</td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section class="section" aria-labelledby="yoy-h">
        <div class="section-head"><h2 id="yoy-h">Year over year</h2><p>Churn and activation patterns, not just totals. {{ thisYear }} is year to date.</p></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th scope="col">Year</th><th scope="col" class="num">Giving donors</th><th scope="col" class="num">New</th><th scope="col" class="num">Reactivated</th><th scope="col" class="num">Kept</th><th scope="col" class="num">Lapsed</th><th scope="col" class="num">Retention</th><th scope="col" class="num">Net raised</th></tr></thead>
            <tbody>
              @for (y of years(); track y.year) {
                <tr>
                  <th scope="row">{{ y.year }}</th>
                  <td class="num mono">{{ y.giving }}</td><td class="num mono">{{ y.r.counts.new }}</td><td class="num mono">{{ y.r.counts.reactivated }}</td>
                  <td class="num mono">{{ y.r.retained }}</td><td class="num mono">{{ y.r.counts.lapsed }}</td>
                  <td class="num mono">{{ pct(y.r.retained, y.r.priorDonors) }}</td><td class="num mono">{{ money(y.r.totals.current) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <div class="grid-2 section">
        @if (store.isAdmin()) {
          <section aria-labelledby="own-h">
            <div class="section-head"><h2 id="own-h">By board member</h2></div>
            <table class="table">
              <thead><tr><th scope="col">Owner</th><th scope="col" class="num">Kept</th><th scope="col" class="num">Lapsed</th><th scope="col" class="num">Retention</th></tr></thead>
              <tbody>
                @for (o of byOwner(); track o.name) {
                  <tr><th scope="row">{{ o.name }}</th><td class="num mono">{{ o.kept }}</td><td class="num mono">{{ o.lapsed }}</td><td class="num mono">{{ pct(o.kept, o.kept + o.lapsed) }}</td></tr>
                }
              </tbody>
            </table>
          </section>
        }
        @if (!store.live()) {
        <section aria-labelledby="src-h">
          <div class="section-head"><h2 id="src-h">Where new donors came from</h2></div>
          <table class="table">
            <thead><tr><th scope="col">Source of first gift</th><th scope="col" class="num">New donors</th></tr></thead>
            <tbody>
              @for (s of newBySource(); track s.label) { <tr><th scope="row">{{ s.label }}</th><td class="num mono">{{ s.n }}</td></tr> }
              @empty { <tr><td colspan="2">No new donors this period.</td></tr> }
            </tbody>
          </table>
        </section>
        }
      </div>
    </div>
  `,
  styles: `
    .window { font-size: 12px; margin: -12px 0 16px; }
    .flow { display: flex; flex-direction: column; gap: 8px; max-width: 900px; }
    .stackbar { display: flex; height: 30px; border: 1px solid var(--brand); border-radius: 3px; overflow: hidden; margin-bottom: 8px; }
    .seg { display: grid; place-items: center; font-family: var(--mono); font-size: 11px; font-weight: 600; min-width: 24px; border-right: 1px solid var(--brand); }
    .seg:last-child { border-right: 0; }
    .seg.solid { background: var(--brand); color: var(--paper); }
    .seg.hatch { background: repeating-linear-gradient(45deg, var(--brand) 0 2px, var(--paper) 2px 6px); }
    .seg.outline { background: var(--paper); }
    .seg.dots { background: radial-gradient(var(--brand) 1.2px, var(--paper) 1.5px) 0 0 / 5px 5px; }
    .seg b { background: var(--paper); color: var(--ink); padding: 0 4px; border-radius: 2px; }
    .seg.solid b { background: var(--brand); color: var(--paper); }
    .legend { list-style: none; padding: 0; margin: 4px 0 0; display: flex; gap: 20px; flex-wrap: wrap; font-size: 12.5px; }
    .legend li { display: flex; align-items: center; gap: 8px; }
    .swatch { width: 16px; height: 12px; border: 1px solid var(--brand); display: inline-block; }
    .swatch.solid { background: var(--brand); }
    .swatch.hatch { background: repeating-linear-gradient(45deg, var(--brand) 0 2px, var(--paper) 2px 5px); }
    .swatch.dots { background: radial-gradient(var(--brand) 1.2px, var(--paper) 1.5px) 0 0 / 4px 4px; }
    .seg-btn { padding: 0; height: auto; font-weight: 600; }
    tr.picked { background: var(--wash); }
    .live-note { font-size: 12.5px; margin: -8px 0 16px; }
    .drill { margin-top: 20px; padding: 16px 20px; border: 1px solid var(--rule); border-radius: var(--radius); }
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
  protected readonly priorBar = computed(() => {
    const c = this.r().counts;
    return [{ key: 'kept', n: this.r().retained, style: 'solid' }, { key: 'lapsed', n: c.lapsed, style: 'hatch' }].filter((s) => s.n > 0);
  });
  protected readonly currentBar = computed(() => {
    const c = this.r().counts;
    return [
      { key: 'kept', n: this.r().retained, style: 'solid' }, { key: 'new', n: c.new, style: 'outline' },
      { key: 'reactivated', n: c.reactivated, style: 'dots' },
    ].filter((s) => s.n > 0);
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
    if (!this.store.live()) return;
    this.api.retention(this.now).then((report) => {
      this.server.set(fromServer(report));
      this.serverNames.set(new Map((report.byCurrency['USD']?.donors ?? []).filter((d) => d.name).map((d) => [d.donor_id, d.name!])));
    }).catch((e) => this.serverError.set(e instanceof ApiError ? e.message : 'The retention report could not load.'));
  }

  protected signed(cents: number) {
    return `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${money(Math.abs(cents))}`;
  }

  protected nudge(donorId: string) {
    this.store.createDraft(donorId, 't-nudge', 'Lapsed: gave last period, not this period');
    this.nudged.update((s) => new Set(s).add(donorId));
  }
}
