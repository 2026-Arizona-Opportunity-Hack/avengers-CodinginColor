import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../core/store';
import { date, dateShort, money, pct, relativeDue, today } from '../core/format';
import { retention, ytdWindows } from '../core/retention';

@Component({
  selector: 'app-overview',
  imports: [RouterLink],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="label eyebrow">Overview · {{ year }} year to date</p>
          <h1>{{ store.isAdmin() ? 'Organization health' : 'Your portfolio' }}</h1>
          <p class="lede">
            @if (store.isAdmin()) {
              Money in, donors kept and work due across every board member, compared with the same date last year.
            } @else {
              The {{ store.donors().length }} donors you own: what they gave this year and what you owe them next.
            }
          </p>
        </div>
        <div class="actions">
          <a class="btn" routerLink="/outreach">Open outreach</a>
          <a class="btn primary" routerLink="/donors/new">Add donor</a>
        </div>
      </header>

      <section class="stats" aria-label="Key figures">
        <div class="stat">
          <p class="label">Raised, net</p>
          <p class="value">{{ money(report().totals.current) }}</p>
          <p class="delta">{{ delta(report().totals.current, report().totals.prior) }} vs {{ money(report().totals.prior) }} last year</p>
        </div>
        <div class="stat">
          <p class="label">Donors giving</p>
          <p class="value">{{ givingDonors() }}</p>
          <p class="delta">{{ report().counts.new }} new · {{ report().counts.reactivated }} reactivated</p>
        </div>
        <div class="stat">
          <p class="label">Retention</p>
          <p class="value">{{ pct(report().retained, report().priorDonors) }}</p>
          <p class="delta">{{ report().retained }} of {{ report().priorDonors }} last-year donors gave again</p>
        </div>
        <div class="stat">
          <p class="label">Next steps due</p>
          <p class="value">{{ due().length }}</p>
          <p class="delta">{{ overdue() }} overdue · next 7 days</p>
        </div>
      </section>

      <div class="grid-2 section">
        <section aria-labelledby="due-h">
          <div class="section-head">
            <h2 id="due-h">Due in the next 7 days</h2>
            <a routerLink="/outreach">All follow-ups</a>
          </div>
          @if (due().length === 0) {
            <div class="empty"><h3>Nothing due</h3><p>No open next steps in the coming week.</p></div>
          } @else {
            <ul class="list bordered">
              @for (f of due().slice(0, 7); track f.id) {
                <li class="item">
                  <div>
                    <a [routerLink]="['/donors', f.donor_id]">{{ store.donor(f.donor_id)?.name }}</a>
                    <p>{{ f.action }}</p>
                  </div>
                  <span class="tag" [class.solid]="f.due_on < now">{{ relativeDue(f.due_on) }}</span>
                </li>
              }
            </ul>
          }
        </section>

        <section aria-labelledby="gifts-h">
          <div class="section-head">
            <h2 id="gifts-h">Latest gifts</h2>
            <a routerLink="/donations">All donations</a>
          </div>
          <ul class="list bordered">
            @for (g of recentGifts(); track g.id) {
              <li class="item">
                <div>
                  <a [routerLink]="['/donors', g.donor_id]">{{ store.donor(g.donor_id)?.name }}</a>
                  <p>{{ store.campaign(g.campaign_id)?.title ?? 'General support' }} · {{ dateShort(g.occurred_at) }}</p>
                </div>
                <span class="mono amount">{{ money(g.amount_cents) }}@if (g.status === 'pending') {<span class="tag dashed">Pending</span>}</span>
              </li>
            }
          </ul>
        </section>
      </div>

      <section class="section" aria-labelledby="prog-h">
        <div class="section-head">
          <h2 id="prog-h">Raised by program, {{ year }}</h2>
          <p>Gifts tied to a program campaign. General campaigns such as Giving Tuesday are unrestricted.</p>
        </div>
        <table class="table">
          <caption class="sr-only">Net raised by program this year</caption>
          <thead><tr><th scope="col">Program</th><th scope="col" class="num">Net</th><th scope="col" class="num">Gifts</th><th scope="col" style="width:45%"><span class="sr-only">Share</span></th></tr></thead>
          <tbody>
            @for (p of byProgram(); track p.label) {
              <tr>
                <th scope="row" class="rowhead">{{ p.label }}</th>
                <td class="num mono">{{ money(p.cents) }}</td>
                <td class="num mono">{{ p.count }}</td>
                <td><div class="bar-track" aria-hidden="true"><div class="bar-fill" [class.hatch]="p.label === 'Unrestricted'" [style.width.%]="p.share"></div></div></td>
              </tr>
            }
          </tbody>
        </table>
      </section>

      @if (store.isAdmin()) {
        <section class="section" aria-labelledby="board-h">
          <div class="section-head">
            <h2 id="board-h">Board portfolios</h2>
            <p>Who owns which donors, and who has been reached.</p>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Board member</th><th scope="col" class="num">Donors</th><th scope="col" class="num">Raised YTD</th>
                  <th scope="col" class="num">Reached, 90 days</th><th scope="col" class="num">Open steps</th><th scope="col" class="num">Overdue</th><th scope="col">Last contact</th>
                </tr>
              </thead>
              <tbody>
                @for (row of portfolios(); track row.id) {
                  <tr>
                    <th scope="row" class="rowhead"><a [routerLink]="['/donors']" [queryParams]="{ owner: row.id }">{{ row.name }}</a></th>
                    <td class="num mono">{{ row.donors }}</td>
                    <td class="num mono">{{ money(row.raised) }}</td>
                    <td class="num mono">{{ row.reached }} / {{ row.donors }}</td>
                    <td class="num mono">{{ row.open }}</td>
                    <td class="num mono">{{ row.overdue }}</td>
                    <td>{{ row.last ? date(row.last) : 'None' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    </div>
  `,
  styles: `
    .bordered { border-top: 1px solid var(--rule); }
    .item { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .item a { font-weight: 600; }
    .item p { font-size: 13px; margin-top: 2px; }
    .amount { display: inline-flex; gap: 6px; align-items: center; font-weight: 600; }
  `,
})
export class OverviewPage {
  protected readonly store = inject(Store);
  protected readonly money = money;
  protected readonly date = date;
  protected readonly dateShort = dateShort;
  protected readonly pct = pct;
  protected readonly relativeDue = relativeDue;
  protected readonly now = today();
  protected readonly year = Number(this.now.slice(0, 4));

  protected readonly report = computed(() => retention(this.store.gifts(), ytdWindows(this.now)));
  protected readonly givingDonors = computed(() => {
    const c = this.report().counts;
    return c.new + c.reactivated + c.increased + c.flat + c.decreased;
  });

  private readonly openSteps = computed(() => this.store.followUps().filter((f) => f.status === 'open'));
  protected readonly due = computed(() => {
    const horizon = new Date(Date.parse(`${this.now}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    return this.openSteps().filter((f) => f.due_on <= horizon).sort((a, b) => a.due_on.localeCompare(b.due_on));
  });
  protected readonly overdue = computed(() => this.due().filter((f) => f.due_on < this.now).length);

  protected readonly recentGifts = computed(() =>
    [...this.store.gifts()].filter((g) => g.status !== 'void').sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0, 7));

  protected readonly byProgram = computed(() => {
    const totals = new Map<string, { cents: number; count: number }>();
    for (const g of this.store.gifts()) {
      if (!g.occurred_at.startsWith(String(this.year)) || g.status !== 'settled') continue;
      const program = this.store.program(this.store.campaign(g.campaign_id)?.program_id ?? null)?.title ?? 'Unrestricted';
      const row = totals.get(program) ?? { cents: 0, count: 0 };
      row.cents += this.store.netCents(g); row.count++;
      totals.set(program, row);
    }
    const max = Math.max(1, ...[...totals.values()].map((v) => v.cents));
    return [...totals.entries()].map(([label, v]) => ({ label, ...v, share: (v.cents / max) * 100 }))
      .sort((a, b) => b.cents - a.cents);
  });

  protected readonly portfolios = computed(() => {
    const since = new Date(Date.parse(`${this.now}T12:00:00Z`) - 90 * 86_400_000).toISOString();
    return this.store.boardMembers().map((m) => {
      const donors = this.store.donors().filter((d) => d.owner_id === m.id);
      const ids = new Set(donors.map((d) => d.id));
      const comms = this.store.communications().filter((c) => ids.has(c.donor_id) && c.direction !== 'internal');
      const steps = this.openSteps().filter((f) => ids.has(f.donor_id));
      return {
        id: m.id, name: m.name, donors: donors.length,
        raised: this.store.gifts().filter((g) => ids.has(g.donor_id) && g.occurred_at.startsWith(String(this.year)))
          .reduce((s, g) => s + this.store.netCents(g), 0),
        reached: new Set(comms.filter((c) => c.occurred_at >= since).map((c) => c.donor_id)).size,
        open: steps.length, overdue: steps.filter((f) => f.due_on < this.now).length,
        last: comms.map((c) => c.occurred_at).sort().at(-1) ?? null,
      };
    });
  });

  protected delta(current: number, prior: number) {
    if (prior === 0) return 'No prior-year giving';
    const d = Math.round(((current - prior) / prior) * 100);
    return `${d >= 0 ? '+' : '−'}${Math.abs(d)}%`;
  }
}
