import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../core/store';
import { date, money, today } from '../core/format';
import { downloadCsv } from '../core/csv';
import { Donor } from '../core/models';

@Component({
  selector: 'app-funders',
  imports: [RouterLink],
  template: `
    <div class="page">
      <header class="page-head no-print">
        <div>
          <p class="label eyebrow">Funder reports</p>
          <h1>Funder packets</h1>
          <p class="lede">Gift history plus the program outcomes it funded, for one funder, in one file. Built for grant reports and renewals.</p>
        </div>
      </header>

      <section class="no-print" aria-labelledby="list-h">
        <div class="section-head"><h2 id="list-h">Institutional funders</h2><p>Foundations and companies. Export uses all-time history.</p></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th scope="col">Funder</th><th scope="col">Type</th><th scope="col">Programs funded</th><th scope="col">Last gift</th><th scope="col" class="num">Lifetime, net</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              @for (f of funders(); track f.donor.id) {
                <tr [class.picked]="funderId() === f.donor.id">
                  <th scope="row"><a [routerLink]="['/donors', f.donor.id]">{{ f.donor.name }}</a></th>
                  <td><span class="tag">{{ f.donor.kind }}</span></td>
                  <td>{{ f.programs || 'Unrestricted only' }}</td>
                  <td>{{ f.last ? date(f.last) : 'None' }}</td>
                  <td class="num mono">{{ money(f.lifetime) }}</td>
                  <td class="actions-cell">
                    <button class="btn small" type="button" (click)="preview(f.donor.id)">Preview</button>
                    <button class="btn small primary" type="button" (click)="exportFor(f.donor.id)">Export CSV</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      @if (packet(); as p) {
        <section class="section packet" aria-labelledby="pk-h">
          <div class="no-print controls">
            <label class="field"><span>From</span><input class="input" type="date" [value]="from()" (input)="from.set($any($event.target).value)" /></label>
            <label class="field"><span>To</span><input class="input" type="date" [value]="to()" [max]="now" (input)="to.set($any($event.target).value)" /></label>
            <label class="field"><span>Program</span>
              <select class="select" (change)="programId.set($any($event.target).value)">
                <option value="">All programs</option>
                @for (pr of store.programs(); track pr.id) { <option [value]="pr.id">{{ pr.title }}</option> }
              </select></label>
            <span class="spacer"></span>
            <button class="btn" type="button" (click)="print()">Print or save PDF</button>
            <button class="btn primary" type="button" (click)="exportFor(p.funder.id)">Export CSV</button>
          </div>

          <header class="packet-head">
            <p class="label">Funder packet · Coding in Color</p>
            <h2 id="pk-h">{{ p.funder.name }}</h2>
            <p>{{ date(from()) }} to {{ date(to()) }} · {{ programId() ? store.program(programId())?.title : 'All programs' }} · prepared {{ date(now) }}</p>
          </header>

          <div class="stats">
            <div class="stat"><p class="label">Gifts</p><p class="value">{{ p.rows.length }}</p></div>
            <div class="stat"><p class="label">Gross</p><p class="value">{{ money(p.gross) }}</p></div>
            <div class="stat"><p class="label">Refunded</p><p class="value">{{ money(p.refunds) }}</p></div>
            <div class="stat"><p class="label">Net</p><p class="value">{{ money(p.gross - p.refunds) }}</p></div>
          </div>

          <h3 class="sub-h">Gift history</h3>
          <table class="table">
            <thead><tr><th scope="col">Date</th><th scope="col">Campaign</th><th scope="col">Program</th><th scope="col">Status</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Refund</th></tr></thead>
            <tbody>
              @for (r of p.rows; track r.id) {
                <tr><td class="mono">{{ date(r.at) }}</td><th scope="row">{{ r.campaign }}</th><td>{{ r.program }}</td><td>{{ r.status }}</td>
                  <td class="num mono">{{ money(r.amount) }}</td><td class="num mono">{{ r.refund ? money(r.refund) : '' }}</td></tr>
              } @empty { <tr><td colspan="6">No gifts from this funder in this period.</td></tr> }
            </tbody>
          </table>

          <h3 class="sub-h">Funded outcomes</h3>
          <p class="note">Approved program outcomes for the programs this funder supported. “Not reported” means the program has not submitted the figure; it is not zero.</p>
          <table class="table">
            <thead><tr><th scope="col">Program</th><th scope="col">Outcome</th>@for (y of p.years; track y) {<th scope="col" class="num">{{ y }}</th>}</tr></thead>
            <tbody>
              @for (o of p.outcomes; track o.program + o.metric) {
                <tr><th scope="row">{{ o.program }}</th><td>{{ o.metric }}</td>
                  @for (v of o.values; track $index) { <td class="num mono">{{ v === null ? 'Not reported' : v === undefined ? '—' : v }}</td> }</tr>
              } @empty { <tr><td [attr.colspan]="2 + p.years.length">Gifts were unrestricted; no program outcomes are attributed.</td></tr> }
            </tbody>
          </table>
        </section>
      }
    </div>
  `,
  styles: `
    .actions-cell { display: flex; gap: 6px; justify-content: flex-end; white-space: nowrap; }
    tr.picked { background: var(--wash); }
    .controls { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 24px; }
    .packet { border-top: 1px solid var(--rule); padding-top: 28px; }
    .packet-head { margin-bottom: 20px; }
    .packet-head h2 { font-size: 24px; margin: 4px 0; }
    .sub-h { margin: 28px 0 10px; }
    .note { font-size: 13px; margin-bottom: 10px; max-width: 72ch; }
  `,
})
export class FundersPage {
  protected readonly store = inject(Store);
  protected readonly money = money;
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

  protected readonly packet = computed(() => {
    const id = this.funderId();
    const funder = id ? this.store.donor(id) : null;
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

  protected preview(id: string) {
    this.funderId.set(id);
    queueMicrotask(() => document.getElementById('pk-h')?.scrollIntoView({ block: 'start' }));
  }

  protected exportFor(id: string) {
    const funder = this.store.donor(id);
    if (!funder) return;
    const p = this.funderId() === id ? this.packet()! : this.build(funder, '2000-01-01', this.now, '');
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
