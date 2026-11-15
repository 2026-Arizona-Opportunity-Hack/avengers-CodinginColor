import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../core/store';
import { date, money } from '../core/format';
import { SOURCE_LABEL, Source } from '../core/models';
import { downloadCsv } from '../core/csv';

@Component({
  selector: 'app-donations',
  imports: [RouterLink],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="label eyebrow">Donations</p>
          <h1>History of donations</h1>
          <p class="lede">Every gift ever recorded, from every source. Money only: conversations live on each donor's timeline.</p>
        </div>
        <div class="actions">
          <button class="btn" type="button" (click)="exportCsv()" [disabled]="rows().length === 0">Download CSV</button>
        </div>
      </header>

      <form class="filters" (submit)="$event.preventDefault()" aria-label="Filter donations">
        <label class="field"><span>Year</span>
          <select class="select" (change)="year.set(val($event))">
            <option value="">All years</option>
            @for (y of years(); track y) { <option [value]="y">{{ y }}</option> }
          </select></label>
        <label class="field grow"><span>Campaign</span>
          <select class="select" (change)="campaign.set(val($event))">
            <option value="">All campaigns</option>
            <option value="none">General support (no campaign)</option>
            @for (c of store.campaigns(); track c.id) { <option [value]="c.id">{{ c.title }}</option> }
          </select></label>
        <label class="field"><span>Source</span>
          <select class="select" (change)="source.set(val($event))">
            <option value="">All sources</option>
            @for (s of sources; track s) { <option [value]="s">{{ sourceLabel[s] }}</option> }
          </select></label>
        <label class="field"><span>Status</span>
          <select class="select" (change)="status.set(val($event))">
            <option value="">Any status</option><option value="settled">Settled</option><option value="pending">Pending</option><option value="void">Void</option>
          </select></label>
      </form>

      <section class="stats totals" aria-label="Totals for the filtered gifts" aria-live="polite">
        <div class="stat"><p class="label">Gifts</p><p class="value">{{ rows().length }}</p></div>
        <div class="stat"><p class="label">Gross settled</p><p class="value">{{ money(totals().gross) }}</p></div>
        <div class="stat"><p class="label">Refunded</p><p class="value">{{ money(totals().refunds) }}</p></div>
        <div class="stat"><p class="label">Net</p><p class="value">{{ money(totals().net) }}</p></div>
      </section>

      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Gifts, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Date</th><th scope="col">Donor</th><th scope="col">Campaign</th><th scope="col">Program</th>
              <th scope="col">Source</th><th scope="col">Status</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Refund</th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.gift.id) {
              <tr>
                <td class="mono nowrap">{{ date(r.gift.occurred_at) }}</td>
                <th scope="row"><a [routerLink]="['/donors', r.gift.donor_id]">{{ r.donor }}</a></th>
                <td>{{ r.campaign }}</td>
                <td>{{ r.program }}</td>
                <td>{{ sourceLabel[r.gift.source] }}</td>
                <td><span class="tag" [class.solid]="r.gift.status === 'settled'" [class.dashed]="r.gift.status !== 'settled'">{{ r.gift.status }}</span></td>
                <td class="num mono">{{ money(r.gift.amount_cents) }}</td>
                <td class="num mono">{{ r.gift.refund_cents ? money(r.gift.refund_cents) : '' }}</td>
              </tr>
            } @empty {
              <tr><td colspan="8"><div class="empty"><h3>No gifts match</h3><p>Change the filters above.</p></div></td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: `
    .filters { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 20px; }
    .filters .field { min-width: 150px; }
    .filters .grow { flex: 1; min-width: 220px; }
    .totals { margin-bottom: 24px; }
    .nowrap { white-space: nowrap; font-size: 12.5px; }
  `,
})
export class DonationsPage {
  protected readonly store = inject(Store);
  protected readonly money = money;
  protected readonly date = date;
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly sources = Object.keys(SOURCE_LABEL) as Source[];
  protected readonly year = signal('');
  protected readonly campaign = signal('');
  protected readonly source = signal('');
  protected readonly status = signal('');
  protected val(e: Event) { return (e.target as HTMLSelectElement).value; }

  protected readonly years = computed(() =>
    [...new Set(this.store.gifts().map((g) => g.occurred_at.slice(0, 4)))].sort().reverse());

  protected readonly rows = computed(() => this.store.gifts()
    .filter((g) => !this.year() || g.occurred_at.startsWith(this.year()))
    .filter((g) => !this.campaign() || (this.campaign() === 'none' ? !g.campaign_id : g.campaign_id === this.campaign()))
    .filter((g) => !this.source() || g.source === this.source())
    .filter((g) => !this.status() || g.status === this.status())
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .map((gift) => {
      const campaign = this.store.campaign(gift.campaign_id);
      return {
        gift,
        donor: this.store.donor(gift.donor_id)?.name ?? 'Unknown',
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

  protected exportCsv() {
    downloadCsv('cic-donations.csv', [
      ['Date', 'Donor', 'Campaign', 'Program', 'Source', 'Status', 'Amount (USD)', 'Refund (USD)'],
      ...this.rows().map((r) => [
        r.gift.occurred_at.slice(0, 10), r.donor, r.campaign, r.program, SOURCE_LABEL[r.gift.source], r.gift.status,
        (r.gift.amount_cents / 100).toFixed(2), (r.gift.refund_cents / 100).toFixed(2),
      ]),
    ]);
  }
}
