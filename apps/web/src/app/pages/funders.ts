import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { compactMoney } from '../shared/chart-theme';
import { RouterLink } from '@angular/router';
import { Store } from '../core/store';
import { date, money, today } from '../core/format';
import { downloadCsv } from '../core/csv';
import { Donor } from '../core/models';

@Component({
  selector: 'app-funders',
  imports: [RouterLink, NgIcon, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head no-print">
        <div>
          <h1>Funder reports</h1>
          <p class="lede">One funder's gifts and funded outcomes, in one packet.</p>
        </div>
      </header>

      <div class="builder">
        <aside class="side no-print" aria-label="Packet settings">
          <section class="glass card">
            <h2 class="side-h">Funder</h2>
            <ul class="funders">
              @for (f of funders(); track f.donor.id) {
                <li>
                  <button type="button" class="funder" [attr.aria-pressed]="selected()?.id === f.donor.id" (click)="funderId.set(f.donor.id)">
                    <span class="f-icon" aria-hidden="true"><ng-icon [name]="f.donor.kind === 'foundation' ? 'lucideHeartHandshake' : 'lucideBuilding2'" size="16" /></span>
                    <span class="min-w-0 flex-1 text-start">
                      <span class="block truncate text-[13.5px] font-semibold">{{ f.donor.name }}</span>
                      <span class="block truncate text-xs text-[var(--ink-600)]">{{ f.programs || 'Unrestricted only' }}</span>
                    </span>
                    <span class="text-[13px] font-semibold tabular-nums">{{ compact(f.lifetime) }}</span>
                  </button>
                </li>
              }
            </ul>
          </section>
          <section class="glass card">
            <h2 class="side-h">Period and program</h2>
            <div class="grid grid-cols-2 gap-3">
              <label class="field"><span>From</span><input class="input" type="date" [value]="from()" (input)="from.set($any($event.target).value)" /></label>
              <label class="field"><span>To</span><input class="input" type="date" [value]="to()" [max]="now" (input)="to.set($any($event.target).value)" /></label>
            </div>
            <label class="field mt-3"><span>Program</span>
              <select class="select" (change)="programId.set($any($event.target).value)">
                <option value="">All programs</option>
                @for (pr of store.programs(); track pr.id) { <option [value]="pr.id">{{ pr.title }}</option> }
              </select></label>
          </section>
        </aside>

        @if (packet(); as p) {
          <section class="doc-wrap" aria-labelledby="pk-h">
            <div class="doc-bar no-print">
              <span class="text-muted-foreground text-sm"><ng-icon name="lucideFileText" size="15" aria-hidden="true" /> Live preview</span>
              <span class="flex-1"></span>
              <button hlmBtn variant="outline" size="sm" type="button" (click)="print()"><ng-icon name="lucideFileDown" size="15" /> Print or save PDF</button>
              <button hlmBtn size="sm" type="button" (click)="exportFor(p.funder.id)"><ng-icon name="lucideFileDown" size="15" /> Export CSV</button>
            </div>
            <article class="doc">
              <header class="doc-head">
                <div class="flex items-center gap-2">
                  <svg class="size-7" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#007a3d"/><rect x="8" y="8.5" width="16" height="3.5" rx="1.75" fill="#fff"/><rect x="8" y="14.25" width="10" height="3.5" rx="1.75" fill="#8fd3ad"/><rect x="8" y="20" width="16" height="3.5" rx="1.75" fill="#fff"/></svg>
                  <span class="text-sm font-semibold">Coding in Color</span>
                  <span class="text-muted-foreground ms-auto text-xs">Prepared {{ date(now) }}</span>
                </div>
                <p class="doc-kicker">Funder packet</p>
                <h2 id="pk-h" class="doc-title">{{ p.funder.name }}</h2>
                <p class="text-muted-foreground text-sm">{{ date(from()) }} to {{ date(to()) }} · {{ programId() ? store.program(programId())?.title : 'All programs' }}</p>
              </header>

              <dl class="doc-stats">
                <div><dt>Gifts</dt><dd>{{ p.rows.length }}</dd></div>
                <div><dt>Gross</dt><dd>{{ money(p.gross) }}</dd></div>
                <div><dt>Refunded</dt><dd>{{ money(p.refunds) }}</dd></div>
                <div class="hl"><dt>Net support</dt><dd>{{ money(p.gross - p.refunds) }}</dd></div>
              </dl>

              <h3 class="doc-h">Funded outcomes</h3>
              <p class="note">Approved outcomes for the programs this funder supported. “Not reported” means the figure has not been submitted; it is not zero.</p>
              @if (p.outcomes.length) {
                <div class="outcomes">
                  @for (o of p.outcomes; track o.program + o.metric) {
                    <div class="outcome">
                      <p class="text-xs font-semibold text-[var(--green-700)]">{{ o.program }}</p>
                      <p class="text-[13.5px] font-medium">{{ o.metric }}</p>
                      <div class="o-years">
                        @for (v of o.values; track $index) {
                          <span><small>{{ p.years[$index] }}</small><b>{{ v === null ? 'Not reported' : v === undefined ? '—' : v }}</b></span>
                        }
                      </div>
                    </div>
                  }
                </div>
              } @else { <p class="empty">Gifts were unrestricted; no program outcomes are attributed.</p> }

              <h3 class="doc-h">Gift history</h3>
              <table class="table">
                <caption class="sr-only">Gift history for {{ p.funder.name }}</caption>
                <thead><tr><th scope="col">Date</th><th scope="col">Campaign</th><th scope="col">Program</th><th scope="col">Status</th><th scope="col" class="num">Amount</th></tr></thead>
                <tbody>
                  @for (r of p.rows; track r.id) {
                    <tr><td class="nowrap">{{ date(r.at) }}</td><th scope="row">{{ r.campaign }}</th><td>{{ r.program }}</td>
                      <td><span class="tag" [class.solid]="r.status === 'settled'" [class.warn]="r.status === 'pending'">{{ r.status }}</span></td>
                      <td class="num font-semibold">{{ money(r.amount) }}@if (r.refund) { <span class="block text-xs font-normal text-[var(--ink-600)]">−{{ money(r.refund) }} refunded</span> }</td></tr>
                  } @empty { <tr><td colspan="5">No gifts from this funder in this period.</td></tr> }
                </tbody>
              </table>
              <p class="doc-foot">Generated by Coding in Color from Coding in Color's donor records. <a [routerLink]="['/donors', p.funder.id]" class="no-print">Open {{ p.funder.name }}</a></p>
            </article>
          </section>
        } @else {
          <div class="empty">No institutional funders yet.</div>
        }
      </div>
    </div>
  `,
  styles: `
    .builder { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 20px; align-items: start; }
    .side { display: flex; flex-direction: column; gap: 16px; position: sticky; top: calc(var(--topbar-h) + 24px); }
    .card { border-radius: 20px; padding: 16px; }
    .side-h { font-size: 13px; font-weight: 600; color: var(--muted-foreground); margin-bottom: 10px; }
    .funders { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 360px; overflow-y: auto; }
    .funder { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 14px; border: 1px solid transparent; background: transparent; cursor: pointer;
      transition: background-color 120ms var(--ease), border-color 120ms var(--ease); }
    .funder:hover { background: rgb(255 255 255 / 0.7); }
    .funder[aria-pressed='true'] { background: #fff; border-color: rgb(0 122 61 / 0.35); box-shadow: 0 1px 3px rgb(15 50 30 / 0.1); }
    .f-icon { width: 32px; height: 32px; flex: none; border-radius: 10px; display: grid; place-items: center; background: #eaf2fb; color: #1c5cab; }
    .doc-wrap { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .doc-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .doc-bar > span:first-child { display: inline-flex; align-items: center; gap: 6px; }
    .doc { background: #fff; border-radius: 20px; padding: 36px 40px; box-shadow: 0 30px 60px -30px rgb(15 50 30 / 0.35), 0 0 0 1px rgb(15 26 21 / 0.05); }
    .doc-head { padding-bottom: 20px; border-bottom: 1px solid var(--hair); }
    .doc-kicker { margin-top: 24px; font-size: 13px; font-weight: 600; color: var(--green-700); }
    .doc-title { font-size: 30px; letter-spacing: -0.025em; margin: 2px 0 4px; }
    .doc-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 24px 0 0; }
    .doc-stats div { padding: 14px 16px; border-radius: 14px; background: #f6f9f7; }
    .doc-stats dt { font-size: 12px; color: var(--muted-foreground); }
    .doc-stats dd { margin: 4px 0 0; font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .doc-stats .hl { background: var(--green-50); }
    .doc-stats .hl dd { color: var(--green-700); }
    .doc-h { font-size: 15px; margin: 32px 0 6px; }
    .note { font-size: 12.5px; color: var(--muted-foreground); margin-bottom: 12px; max-width: 72ch; }
    .outcomes { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
    .outcome { padding: 14px; border-radius: 14px; border: 1px solid var(--hair); }
    .o-years { display: flex; gap: 14px; margin-top: 10px; flex-wrap: wrap; }
    .o-years span { display: flex; flex-direction: column; }
    .o-years small { font-size: 11px; color: var(--muted-foreground); }
    .o-years b { font-size: 15px; font-variant-numeric: tabular-nums; }
    .doc-foot { margin-top: 28px; padding-top: 14px; border-top: 1px solid var(--hair); font-size: 12px; color: var(--muted-foreground); display: flex; justify-content: space-between; gap: 12px; }
    .nowrap { white-space: nowrap; }
    @media (max-width: 1100px) { .builder { grid-template-columns: 1fr; } .side { position: static; } }
    @media (max-width: 640px) { .doc { padding: 22px 18px; } .doc-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media print { .builder { display: block; } .doc { box-shadow: none; padding: 0; } }
  `,
})
export class FundersPage {
  protected readonly store = inject(Store);
  protected readonly money = money;
  protected readonly compact = compactMoney;
  protected readonly date = date;
  protected readonly now = today();
  protected readonly funderId = signal<string | null>(null);
  protected readonly from = signal('2023-01-01');
  protected readonly to = signal(this.now);
  protected readonly programId = signal('');

  protected readonly funders = computed(() => this.store.donors()
    .filter((d) => d.kind !== 'individual')
    .map((donor) => {
      const gifts = this.store.giftsFor(donor.id);
      const programs = [...new Set(gifts.map((g) => this.store.program(this.store.campaign(g.campaign_id)?.program_id ?? null)?.title).filter(Boolean))];
      return { donor, lifetime: this.store.lifetime(donor.id), last: this.store.lastGift(donor.id)?.occurred_at ?? null, programs: programs.join(', ') };
    })
    .sort((a, b) => b.lifetime - a.lifetime));

  /** The picked funder, or the largest one so the preview is never empty. */
  protected readonly selected = computed(() => (this.funderId() ? this.store.donor(this.funderId()!) : null) ?? this.funders()[0]?.donor ?? null);

  protected readonly packet = computed(() => {
    const funder = this.selected();
    return funder ? this.build(funder, this.from(), this.to(), this.programId()) : null;
  });

  private build(funder: Donor, from: string, to: string, programId: string) {
    const start = Date.parse(`${from}T00:00:00-07:00`), end = Date.parse(`${to}T23:59:59-07:00`);
    const rows = this.store.giftsFor(funder.id)
      .filter((g) => Date.parse(g.occurred_at) >= start && Date.parse(g.occurred_at) <= end && g.status !== 'void')
      .map((g) => {
        const c = this.store.campaign(g.campaign_id);
        return { id: g.id, at: g.occurred_at, campaign: c?.title ?? 'General support', programId: c?.program_id ?? null,
          program: this.store.program(c?.program_id ?? null)?.title ?? 'Unrestricted', amount: g.amount_cents, refund: g.refund_cents, status: g.status };
      })
      .filter((r) => !programId || r.programId === programId)
      .sort((a, b) => a.at.localeCompare(b.at));
    const settled = rows.filter((r) => r.status === 'settled');
    const funded = [...new Set(rows.map((r) => r.programId).filter((p): p is string => !!p))];
    const years = [...new Set(this.store.outcomes().map((o) => o.year))].sort();
    const outcomes = funded.flatMap((pid) => {
      const metrics = [...new Set(this.store.outcomes().filter((o) => o.program_id === pid && o.approved).map((o) => o.metric))];
      return metrics.map((metric) => ({
        program: this.store.program(pid)?.title ?? '', metric,
        values: years.map((y) => this.store.outcomes().find((o) => o.program_id === pid && o.metric === metric && o.year === y && o.approved)?.value),
      }));
    });
    return {
      funder, rows, years, outcomes,
      gross: settled.reduce((s, r) => s + r.amount, 0), refunds: settled.reduce((s, r) => s + r.refund, 0),
    };
  }

  protected exportFor(id: string) {
    const funder = this.store.donor(id);
    if (!funder) return;
    const p = this.selected()?.id === id ? this.packet()! : this.build(funder, '2000-01-01', this.now, '');
    const slug = funder.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    downloadCsv(`funder-packet-${slug}-${this.now}.csv`, [
      ['Funder packet', funder.name], ['Prepared', this.now], [],
      ['Gift history'], ['Date', 'Campaign', 'Program', 'Status', 'Amount (USD)', 'Refund (USD)'],
      ...p.rows.map((r) => [r.at.slice(0, 10), r.campaign, r.program, r.status, (r.amount / 100).toFixed(2), (r.refund / 100).toFixed(2)]),
      ['Total net', '', '', '', ((p.gross - p.refunds) / 100).toFixed(2)], [],
      ['Funded outcomes'], ['Program', 'Outcome', ...p.years.map(String)],
      ...p.outcomes.map((o) => [o.program, o.metric, ...o.values.map((v) => (v === null ? 'Not reported' : v === undefined ? '' : String(v)))]),
    ]);
  }

  protected print() { window.print(); }
}
