import { Component, computed, effect, inject, signal } from '@angular/core';
import { Api, ApiError } from '../core/api';
import { Store } from '../core/store';
import { date, today } from '../core/format';
import type { ApiFunderPacket } from '../core/report-models';
import { OutcomesUpload } from './outcomes-upload';

/** Date inputs include the last day; the reporting API uses a Phoenix exclusive end. */
export function packetQuery(funderId: string, programId: string, from: string, through: string): string | null {
  const valid = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    !Number.isNaN(Date.parse(`${day}T12:00:00Z`)) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day;
  if (!funderId || !programId || !valid(from) || !valid(through) || from > through) return null;
  const end = new Date(`${through}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
  return new URLSearchParams({ funderId, programId, from, to: end.toISOString().slice(0, 10) }).toString();
}

@Component({
  selector: 'app-live-funders',
  imports: [OutcomesUpload],
  template: `
    <div class="page stack">
      <header class="page-head"><div><h1>Funder reports</h1><p class="lede">Gift history, program outcomes and provenance for one funder.</p></div></header>
      <form class="toolbar glass no-print" (submit)="$event.preventDefault()" aria-label="Funder packet settings">
        <label class="field">Funder<select class="select" [value]="selectedFunder()" (change)="funderId.set($any($event.target).value)">
          @for (donor of store.donors(); track donor.id) { <option [value]="donor.id">{{ donor.name }}</option> }
        </select></label>
        <label class="field">Program<select class="select" [value]="selectedProgram()" (change)="programId.set($any($event.target).value)">
          @for (program of store.programs(); track program.id) { <option [value]="program.id">{{ program.title }}</option> }
        </select></label>
        <label class="field">From<input class="input" type="date" [value]="from()" (input)="from.set($any($event.target).value)" /></label>
        <label class="field">Through<input class="input" type="date" [value]="through()" (input)="through.set($any($event.target).value)" /></label>
      </form>
      <app-outcomes-upload [example]="outcomeExample()" (saved)="refresh.update(increment)" />
      @if (!query()) { <p role="status">Choose a funder, program and valid date range.</p> }
      @if (loading()) { <p role="status">Loading report…</p> }
      @if (error()) { <p role="alert">{{ error() }}</p> }
      @if (packet(); as p) {
        <div class="row no-print"><button class="btn" type="button" (click)="print()" [disabled]="loading()">Print or save PDF</button>
          <button class="btn primary" type="button" (click)="download()" [disabled]="loading() || downloading()">{{ downloading() ? 'Downloading…' : 'Download CSV' }}</button></div>
        <article class="panel report" aria-labelledby="packet-title">
          <header><p>Coding in Color · Funder packet</p><h2 id="packet-title">{{ p.funder.name }}</h2>
            <p>{{ p.program.title }} · {{ date(p.period.from) }} to {{ date(p.period.to) }} (end exclusive)</p></header>
          <h3>Giving totals</h3><p>Unattributed gifts are shown separately. Pending and void gifts contribute zero net giving.</p>
          <div class="table-scroll"><table><caption>Totals by attribution and currency</caption><thead><tr><th>Attribution</th><th>Currency</th><th>Gifts</th><th>Gross</th><th>Refunded</th><th>Net</th></tr></thead><tbody>
            @for (row of totals(); track row.attribution + row.currency) {
              <tr><th>{{ row.attribution === 'program' ? p.program.title : 'Unattributed' }}</th><td>{{ row.currency }}</td><td>{{ row.gifts }}</td>
                <td>{{ amount(row.gross_cents) }}</td><td>{{ amount(row.refund_cents) }}</td><td>{{ amount(row.net_cents) }}</td></tr>
            } @empty { <tr><td colspan="6">No gifts in this period.</td></tr> }
          </tbody></table></div>
          <h3>Approved program outcomes</h3>
          @if (p.outcomes_status === 'unavailable') { <p>No approved outcome data is available for this program and period. This does not mean zero outcomes.</p> }
          @for (outcome of p.outcomes; track $index) {
            <section><h4>{{ outcome.metric }}</h4><p>{{ outcome.value === null ? 'Not reported' : outcome.value }} {{ outcome.unit }} · denominator {{ outcome.denominator ?? 'not reported' }}</p>
              <p>{{ date(outcome.period.from) }} to {{ date(outcome.period.to) }} (end exclusive). Source: {{ outcome.source }}. Approved {{ date(outcome.approved_at) }}.</p></section>
          }
          <h3>Gift history</h3><div class="table-scroll"><table><caption>Gifts and source provenance</caption><thead><tr><th>Date</th><th>Attribution</th><th>Status</th><th>Currency</th><th>Amount</th><th>Refunded</th><th>Net</th><th>Source</th><th>Transaction</th></tr></thead><tbody>
            @for (gift of p.gifts; track gift.id) { <tr><td>{{ date(gift.occurred_at) }}</td><td>{{ gift.attribution }}</td><td>{{ gift.status }}</td><td>{{ gift.currency }}</td>
              <td>{{ amount(gift.amount_cents) }}</td><td>{{ amount(gift.refund_cents) }}</td><td>{{ amount(gift.net_cents) }}</td><td>{{ gift.source }}</td><td>{{ gift.external_id ?? 'Not supplied' }}</td></tr> }
          </tbody></table></div>
        </article>
      }
    </div>
  `,
  styles: `.report { padding: 24px } .report h3 { margin-top: 24px; margin-bottom: 8px } .report h2 { font-size: 26px }
    .toolbar { display:flex; gap:16px; flex-wrap:wrap; padding:20px; border-radius:20px } .field { flex:1; min-width:160px }
    .table-scroll { overflow:auto } th,td { padding:10px; text-align:left; border-bottom:1px solid var(--border); vertical-align:top }
    @media print { .no-print { display:none } .report { box-shadow:none; border:0; padding:0 } .table-scroll { overflow:visible } }`,
})
export class LiveFundersPage {
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  protected readonly from = signal(`${today().slice(0, 4)}-01-01`);
  protected readonly through = signal(today());
  protected readonly funderId = signal('');
  protected readonly programId = signal('');
  protected readonly selectedFunder = computed(() => this.funderId() || this.store.donors()[0]?.id || '');
  protected readonly selectedProgram = computed(() => this.programId() || this.store.programs()[0]?.id || '');
  protected readonly query = computed(() => packetQuery(this.selectedFunder(), this.selectedProgram(), this.from(), this.through()));
  protected readonly packet = signal<ApiFunderPacket | null>(null);
  protected readonly loading = signal(false);
  protected readonly downloading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly refresh = signal(0);
  protected readonly increment = (value: number) => value + 1;
  protected readonly outcomeExample = computed(() => {
    const query = new URLSearchParams(this.query() ?? '');
    return JSON.stringify([{ program_id: this.selectedProgram(), from: this.from(), to: query.get('to') ?? '',
      metric: 'Program completions', value: null, unit: 'participants', denominator: null, source: '' }], null, 2);
  });
  protected readonly date = date;
  protected readonly totals = computed(() => (['program', 'unattributed'] as const).flatMap(attribution =>
    Object.entries(this.packet()?.totals[attribution] ?? {}).map(([currency, totals]) => ({ attribution, currency, ...totals }))));
  private generation = 0;
  private loadedQuery: string | null = null;

  constructor() {
    effect(() => {
      this.refresh();
      const query = this.query(), epoch = this.store.sessionEpoch(), generation = ++this.generation;
      this.packet.set(null); this.loadedQuery = null; this.error.set(null); this.downloading.set(false);
      const allowed = !!query && this.store.signedIn() && this.store.isAdmin();
      this.loading.set(allowed);
      if (!allowed) return;
      void this.api.request<ApiFunderPacket>(`/api/v1/reports/funder-packet?${query}`).then(packet => {
        if (generation === this.generation && epoch === this.store.sessionEpoch() && this.store.signedIn()) {
          this.packet.set(packet); this.loadedQuery = query;
        }
      }).catch(error => { if (generation === this.generation) this.error.set(this.message(error)); })
        .finally(() => { if (generation === this.generation) this.loading.set(false); });
    });
  }
  protected amount(cents: number) { const n = BigInt(cents); return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`; }
  private message(error: unknown) { return error instanceof ApiError ? error.message : 'The report could not be loaded. Try again.'; }
  protected print() { if (this.loadedQuery === this.query() && this.packet() && !this.loading()) window.print(); }
  protected async download() {
    const query = this.loadedQuery, epoch = this.store.sessionEpoch(), generation = this.generation;
    if (!query || query !== this.query() || !this.store.signedIn() || !this.store.isAdmin() || this.downloading()) return;
    this.downloading.set(true); this.error.set(null);
    try {
      const blob = await this.api.request<Blob>(`/api/v1/reports/funder-packet?${query}&format=csv`, {}, 'blob');
      if (epoch !== this.store.sessionEpoch() || generation !== this.generation || !this.store.signedIn()) return;
      const href = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = href; link.download = 'coding-in-color-funder-packet.csv'; link.click(); URL.revokeObjectURL(href);
    } catch (error) { if (generation === this.generation && epoch === this.store.sessionEpoch()) this.error.set(this.message(error)); }
    finally { if (generation === this.generation) this.downloading.set(false); }
  }
}
