import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Api, ApiError } from '../core/api';
import { Store } from '../core/store';
import { IMPORT_FIELDS, LiveImports, importTotals, type ImportDecision, type ImportLayout,
  type ImportPlan, type ImportPreview, type ImportResult, type ImportSuggestion, type PlanRow, type PreviewRow } from '../core/import-live';

@Component({
  selector: 'app-live-import',
  template: `
    <div class="page stack">
      <header class="page-head"><div><h1>Import</h1><p class="lede">Upload, map, review donors, review gifts, then confirm. Nothing changes donor records until you commit.</p></div></header>
      @if (error()) { <p role="alert">{{ error() }}</p> }
      @if (busy()) { <p role="status">Loading the server review…</p> }
      <fieldset class="stack" [disabled]="busy()"><legend class="sr-only">Import review</legend>
      @if (!batch()) {
        <form class="stack glass panel" (submit)="upload($event)">
          <h2>Upload a source file</h2>
          <label class="field">Source<select class="input" name="source">@for (s of sources; track s) { <option [value]="s">{{ s }}</option> }</select></label>
          <label class="field">CSV or XLSX<input class="input" type="file" name="file" accept=".csv,.xlsx" required /></label>
          <p>Up to 4 MiB. XLSX supports one visible worksheet and textual dates. Formulas and macros are rejected.</p>
          <button class="btn primary" type="submit">Upload for review</button>
        </form>
      } @else if (batch()?.status === 'committed') {
        <section class="glass panel stack" aria-labelledby="result-h"><h2 #stageHeading tabindex="-1" id="result-h">{{ batch()?.replayed ? 'Already imported — no duplicate writes' : 'Import committed' }}</h2>
          <p role="status">{{ batch()?.counts?.donors_created }} donors created, {{ batch()?.counts?.donors_linked }} linked;
            {{ batch()?.counts?.gifts_inserted }} gifts inserted, {{ batch()?.counts?.gifts_corrected }} corrected, {{ batch()?.counts?.skipped }} skipped.</p>
          <button class="btn" type="button" (click)="store.refreshLive()">Reload workspace from server</button>
          <button class="btn" type="button" (click)="clear()">Import another file</button>
        </section>
      } @else {
        <p>Reviewing {{ filename() }} · <strong>{{ phase() === 'mapping' ? '1. Map and validate' : phase() === 'donor' ? '2. Review donor identities' : phase() === 'gift' ? '3. Review gift identities' : '4. Confirm changes' }}</strong></p>
        @if (phase() === 'mapping' && preview(); as p) {
          <form class="glass panel stack" (submit)="applyLayout($event)">
            <h2 #stageHeading tabindex="-1">Map columns and confirm financial facts</h2>
            <p>Automatic aliases retain the source units. For manual mapping, decimal amounts convert 12.34 to 1234 cents; amount_cents already contains integer cents.</p>
            <div class="fields">@for (h of p.headers; track h; let i = $index) {
              <div class="stack"><label class="field">{{ h }}<select class="input" [value]="mapping()[h] === null ? '__ignore' : mapping()[h] ?? ''" (change)="map(h, $any($event.target).value)">
                <option value="">Automatic: {{ p.mapping[i] ?? 'unmapped' }}</option><option value="__ignore">Ignore column</option>
                @for (f of fields; track f) { <option [value]="f">{{ f === 'amount_decimal' ? 'Amount in major units, e.g. dollars' : f === 'amount_cents' ? 'Amount already in cents' : f.replaceAll('_', ' ') }}</option> }
              </select></label>
              @if (p.mapping[i] === null && mapping()[h] === undefined) {
                <button class="btn" type="button" (click)="suggest(h)">Suggest mapping for {{ h }}</button>
                @if (suggestions()[h]; as s) {
                  <p>Suggested: {{ s.target.replaceAll('_', ' ') }} ({{ (s.confidence * 100).toFixed(0) }}% confidence). Review before using.</p>
                  @if (s.target !== 'unknown') {
                    <button class="btn" type="button" (click)="map(h, s.target === 'ignore' ? '__ignore' : s.target)">Use suggestion for {{ h }}</button>
                  }
                }
              }
              </div>
            }</div>
            <div class="fields">
              @if (!mapped('currency')) { <label class="field">Currency for missing values<input class="input" name="currency" maxlength="3" placeholder="USD" [value]="layout().batch_values.currency ?? ''" /></label> }
              @if (!mapped('occurred_at')) { <label class="field">Gift timestamp with timezone, only if missing<input class="input" name="occurred_at" placeholder="2026-11-01T12:00:00-07:00" [value]="layout().batch_values.occurred_at ?? ''" /></label> }
              @if (!mapped('status')) { <label class="field">Confirmed gift status<select class="input" name="status" required [value]="layout().batch_values.status ?? ''"><option value="">Choose status</option><option value="settled">Settled</option><option value="pending">Pending</option><option value="void">Void</option></select></label> }
              @if (!mapped('refund_cents')) { <label class="field">Confirmed refund per row, integer cents<input class="input" name="refund_cents" type="number" min="0" step="1" required [value]="layout().batch_values.refund_cents ?? ''" /></label> }
              <label class="field">Text date format, if needed<select class="input" name="date_format" [value]="layout().date_format ?? ''"><option value="">Timestamp already includes timezone</option>@for (f of dateFormats; track f) { <option [value]="f">{{ f }}</option> }</select></label>
              <label class="field">UTC offset for text dates<input class="input" name="utc_offset" placeholder="-07:00" [value]="layout().utc_offset ?? '-07:00'" /></label>
            </div>
            <p>Confirm batch facts against the source. Mapped status and refund columns retain each row's facts; batch values apply only when that column is unmapped.</p>
            <p>{{ p.counts.rows }} source rows; {{ p.counts.donors }} donor drafts; {{ p.counts.gifts }} gift drafts; {{ p.counts.excluded }} invalid rows excluded.</p>
            @for (issue of p.issues; track $index) { <p role="status">{{ issue.field }}: {{ issue.code }}</p> }
            @if (invalidRows().length) { <label><input type="checkbox" [checked]="skipInvalid()" (change)="skipInvalid.set($any($event.target).checked); applied.set(false)" /> I reviewed and acknowledge excluding all {{ invalidRows().length }} invalid source records.</label> }
            <details><summary>Inspect source rows and validation issues</summary>
              <div class="table-scroll"><table><caption>Source records {{ page() * 50 + 1 }}–{{ page() * 50 + visiblePreview().length }} of {{ previewRows().length }}</caption><thead><tr><th>Record</th><th>Source cells</th><th>Issues</th></tr></thead><tbody>
                @for (r of visiblePreview(); track r.recordNumber) { <tr><td>{{ r.recordNumber }}</td><td><pre>{{ r.raw.join(' | ') }}</pre></td><td>@for (i of r.issues; track $index) { {{ i.field }}: {{ i.code }}<br /> }</td></tr> }
              </tbody></table></div>
              <button class="btn" type="button" (click)="page.update(previous)" [disabled]="page() === 0">Previous records</button>
              <button class="btn" type="button" (click)="page.update(next)" [disabled]="(page() + 1) * 50 >= previewRows().length">Next records</button>
            </details>
            <button class="btn" type="submit">Apply mapping and confirmed facts</button>
          </form>
          <button class="btn primary" type="button" [disabled]="!applied() || p.issues.length > 0 || (p.counts.excluded > 0 && !skipInvalid())" (click)="beginDonors()">Review donor identities</button>
        }
        @if (phase() === 'donor' || phase() === 'gift') {
          <section class="glass panel stack" aria-labelledby="plan-h"><h2 #stageHeading tabindex="-1" id="plan-h">{{ phase() === 'donor' ? 'Donor' : 'Gift' }} proposals</h2>
            <p>{{ rows().length }} proposals · {{ pending() }} decisions still required. Similar names or amounts alone never justify merging.</p>
            @for (r of visiblePlans(); track r.row) {
              <article class="proposal"><h3>Row {{ r.row + 1 }}: {{ label(r.draft) }}</h3><p>Proposed: {{ r.action }} · {{ r.reason }}</p>
                @if (r.matchingRows.length) { <p>Also matches incoming rows {{ r.matchingRows.join(', ') }} (numbered from zero).</p> }
                @for (c of r.candidates; track $index) { <p>Existing candidate: {{ label(c) }}</p> }
                <label class="field">Decision for row {{ r.row + 1 }}<select class="input" [value]="choices()[r.row] ?? ''" (change)="choose(r.row, $any($event.target).value)">
                  <option value="">{{ r.action === 'review' ? 'Choose a reviewed decision' : 'Accept server proposal' }}</option>
                  @for (o of options(r); track o.value) { <option [value]="o.value">{{ o.label }}</option> }
                </select></label>
              </article>
            }
            <div><button class="btn" type="button" (click)="page.update(previous)" [disabled]="page() === 0">Previous proposals</button><button class="btn" type="button" (click)="page.update(next)" [disabled]="(page() + 1) * 50 >= rows().length">Next proposals</button></div>
            <button class="btn primary" type="button" [disabled]="pending() > 0" (click)="approve()">Approve these {{ phase() }} decisions</button>
          </section>
        }
        @if (phase() === 'confirm') {
          <section class="glass panel stack" aria-labelledby="confirm-h"><h2 #stageHeading tabindex="-1" id="confirm-h">Confirm this import</h2>
            <p>Both donor and gift decisions are approved. Commit applies the server's reviewed operations atomically.</p>
            <p>{{ donorCount() }} donor proposals, {{ rows().length }} gift proposals. {{ preview()?.counts?.excluded }} invalid source records explicitly excluded.</p>
            <table><caption>Validated gift rows only; currencies stay separate</caption><thead><tr><th>Currency</th><th>Source net</th><th>Canonical net change</th></tr></thead><tbody>
              @for (t of totals().currencies; track t.currency) { <tr><td>{{ t.currency }}</td><td>{{ decimal(t.source_cents) }}</td><td>{{ decimal(t.delta_cents) }}</td></tr> }
            </tbody></table>
            @if (totals().unavailable) { <p>{{ totals().unavailable }} rows have unavailable financial totals; skipped invalid rows are excluded from the amounts above.</p> }
            <button class="btn primary" type="button" (click)="commit()">Commit reviewed donors and gifts</button>
          </section>
        }
        <div><button class="btn" type="button" (click)="phase.set('mapping'); applied.set(false); plan.set(null)">Restart mapping and review</button>
          <button class="btn" type="button" (click)="abandon()">Abandon import and purge staged data</button></div>
      }
      </fieldset>
    </div>
  `,
  styles: `fieldset { border: 0; padding: 0; min-width: 0 } .panel { padding: 24px; border-radius: 20px }
    .fields { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 16px }
    .proposal { padding-block: 16px; border-bottom: 1px solid var(--border) } .table-scroll { overflow: auto }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 50rem } td,th { padding: 8px; text-align: left }`,
})
export class LiveImportPage {
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  private readonly client = new LiveImports((path, init) => this.api.request(path, init));
  protected readonly fields = IMPORT_FIELDS;
  protected readonly sources = ['spreadsheet', 'zeffy', 'benevity', 'az_gives', 'united_way'];
  protected readonly dateFormats = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'];
  protected readonly batch = signal<ImportResult | null>(null);
  protected readonly preview = signal<ImportPreview | null>(null);
  protected readonly previewRows = signal<PreviewRow[]>([]);
  protected readonly layout = signal<ImportLayout>({ mapping: {}, skip_records: [], batch_values: {} });
  protected readonly mapping = signal<Record<string, string | null>>({});
  protected readonly suggestions = signal<Record<string, ImportSuggestion>>({});
  protected readonly filename = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly phase = signal<'mapping' | 'donor' | 'gift' | 'confirm'>('mapping');
  protected readonly applied = signal(false);
  protected readonly skipInvalid = signal(false);
  protected readonly plan = signal<ImportPlan | null>(null);
  protected readonly rows = signal<PlanRow[]>([]);
  protected readonly choices = signal<Record<number, string>>({});
  protected readonly donorCount = signal(0);
  protected readonly page = signal(0);
  protected readonly previous = (p: number) => Math.max(0, p - 1);
  protected readonly next = (p: number) => p + 1;
  protected readonly invalidRows = computed(() => this.previewRows().filter(r => r.issues.length));
  protected readonly visiblePreview = computed(() => this.previewRows().slice(this.page() * 50, this.page() * 50 + 50));
  protected readonly visiblePlans = computed(() => this.rows().slice(this.page() * 50, this.page() * 50 + 50));
  protected readonly pending = computed(() => this.rows().filter(r => r.action === 'review' && !this.choices()[r.row]).length);
  protected readonly totals = computed(() => importTotals(this.rows(), this.choices()));
  private generation = 0;
  private readonly heading = viewChild<ElementRef<HTMLHeadingElement>>('stageHeading');

  constructor() { effect(() => { this.store.sessionEpoch(); this.generation++; this.busy.set(false); this.clear(); }); }

  protected clear() {
    this.suggestions.set({});
    this.batch.set(null); this.preview.set(null); this.previewRows.set([]); this.rows.set([]); this.plan.set(null);
    this.layout.set({ mapping: {}, skip_records: [], batch_values: {} }); this.mapping.set({}); this.choices.set({});
    this.filename.set(''); this.phase.set('mapping'); this.applied.set(false); this.skipInvalid.set(false); this.page.set(0); this.error.set(null);
  }

  private async run<T>(work: () => Promise<T>, apply: (value: T) => void) {
    if (this.busy()) return;
    const generation = ++this.generation;
    this.busy.set(true); this.error.set(null);
    try { const value = await work(); if (generation === this.generation) {
      apply(value); setTimeout(() => { if (generation === this.generation) this.heading()?.nativeElement.focus(); }, 0);
    } }
    catch (e) {
      if (generation !== this.generation) return;
      if (e instanceof ApiError && e.status === 409) { this.plan.set(null); this.phase.set('mapping'); this.applied.set(false); }
      this.error.set(e instanceof ApiError && e.status === 409 ? 'The review changed. Apply mapping again and review fresh proposals.'
        : e instanceof Error ? e.message : 'The import could not be saved.');
    } finally { if (generation === this.generation) this.busy.set(false); }
  }

  protected upload(event: Event) {
    event.preventDefault(); const form = new FormData(event.target as HTMLFormElement);
    const file = form.get('file') as File;
    return this.run(async () => {
      const staged = await this.client.upload(file, String(form.get('source')));
      const batch = staged.status === 'reviewing' ? await this.client.details(staged.batch_id) : staged;
      const rows = batch.status === 'reviewing' ? await this.client.rows<PreviewRow>(batch.batch_id, 'preview') : [];
      return { batch, rows };
    }, ({ batch, rows }) => {
      this.batch.set(batch); this.filename.set(file.name); this.preview.set(batch.preview ?? null); this.previewRows.set(rows);
      if (batch.layout) { this.layout.set({ ...batch.layout, mapping: batch.layout.mapping ?? {},
        batch_values: batch.layout.batch_values ?? {}, skip_records: batch.layout.skip_records ?? [] }); this.mapping.set(batch.layout.mapping ?? {}); }
      this.skipInvalid.set(rows.some(r => r.issues.length) && rows.filter(r => r.issues.length).every(r => batch.layout?.skip_records?.includes(r.recordNumber)));
    });
  }

  protected async suggest(header: string) {
    await this.run(() => this.client.suggest(this.batch()!.batch_id, header), result => {
      if (result.suggestion) this.suggestions.update(s => ({ ...s, [header]: result.suggestion! }));
      else this.error.set('Suggestions are unavailable. Choose a mapping manually.');
    });
  }

  protected map(header: string, value: string) {
    const mapping = { ...this.mapping() }; if (!value) delete mapping[header]; else mapping[header] = value === '__ignore' ? null : value;
    this.mapping.set(mapping); this.applied.set(false);
  }
  protected mapped(field: string) {
    return this.preview()?.headers.some((h, i) => {
      const target = Object.hasOwn(this.mapping(), h) ? this.mapping()[h] : this.preview()?.mapping[i];
      return (target === 'refund_decimal' ? 'refund_cents' : target === 'amount_decimal' ? 'amount_cents' : target) === field;
    });
  }
  protected applyLayout(event: Event) {
    event.preventDefault(); const form = new FormData(event.target as HTMLFormElement);
    return this.run(async () => {
      const batch_values: ImportLayout['batch_values'] = {};
      if (!this.mapped('status')) {
        const status = String(form.get('status') ?? '');
        if (!['settled', 'pending', 'void'].includes(status)) throw new Error('Confirm a gift status for each included row.');
        batch_values.status = status;
      }
      if (!this.mapped('refund_cents')) {
        const refund = String(form.get('refund_cents') ?? '').trim();
        if (!/^\d+$/.test(refund) || !Number.isSafeInteger(Number(refund))) throw new Error('Confirm nonnegative integer refund cents.');
        batch_values.refund_cents = Number(refund);
      }
      for (const field of ['currency', 'occurred_at'] as const) if (String(form.get(field) ?? '').trim()) batch_values[field] = String(form.get(field)).trim();
      const date_format = String(form.get('date_format') ?? '');
      const layout: ImportLayout = { mapping: this.mapping(), batch_values,
        skip_records: this.skipInvalid() ? this.invalidRows().map(r => r.recordNumber) : [],
        ...(date_format ? { date_format, utc_offset: String(form.get('utc_offset')) } : {}) };
      const result = await this.client.layout(this.batch()!.batch_id, layout);
      return { result, layout, rows: await this.client.rows<PreviewRow>(this.batch()!.batch_id, 'preview') };
    }, ({ result, layout, rows }) => { this.preview.set(result.preview!); this.layout.set(layout); this.previewRows.set(rows); this.applied.set(true); this.page.set(0); });
  }

  private async proposals(kind: 'donor' | 'gift') {
    const id = this.batch()!.batch_id;
    return { plan: await this.client.plan(id, kind), rows: await this.client.rows<PlanRow>(id, kind, true), kind };
  }
  private showPlan(value: Awaited<ReturnType<LiveImportPage['proposals']>>) {
    this.plan.set(value.plan); this.rows.set(value.rows); this.choices.set({}); this.page.set(0); this.phase.set(value.kind);
    if (value.kind === 'donor') this.donorCount.set(value.rows.length);
  }
  protected beginDonors() { return this.run(() => this.proposals('donor'), value => this.showPlan(value)); }
  protected choose(row: number, value: string) { this.choices.update(c => ({ ...c, [row]: value })); }
  protected options(row: PlanRow) {
    const options = [{ value: 'skip', label: 'Skip this row' }];
    if (row.action !== 'review' || ['invalid_donor', 'invalid_gift', 'conflicting_identity', 'donor_unresolved'].includes(row.reason)) return options;
    if (this.phase() === 'donor') return [...options, { value: 'new', label: 'Create a separate donor' }, ...row.candidates.map(c => ({ value: `link:${c['id']}`, label: `Link to ${this.label(c)}` }))];
    return row.existingIds.length && ['changed_transaction', 'conflicting_batch_transaction'].includes(row.reason)
      ? [...options, ...row.candidates.map(c => ({ value: `correct:${c['id']}`, label: `Correct ${this.label(c)}` }))]
      : [...options, { value: 'insert', label: 'Insert a separate gift' }];
  }
  protected approve() {
    const kind = this.phase() as 'donor' | 'gift';
    const decisions = Object.entries(this.choices()).filter(([, value]) => !!value).map(([row, value]) => {
      const [action, id] = value.split(':'); return { kind, row: Number(row), action,
        ...(action === 'link' ? { donor_id: id } : action === 'correct' ? { gift_id: id } : {}) } as ImportDecision;
    });
    return this.run(async () => {
      const result = await this.client.review(this.batch()!.batch_id, kind, this.plan()!, decisions);
      if (result.status !== 'ready') throw new Error(`Review the ${result.total_pending ?? ''} remaining decisions.`);
      return kind === 'donor' ? this.proposals('gift') : null;
    }, value => { if (value) this.showPlan(value); else this.phase.set('confirm'); });
  }
  protected commit() { return this.run(() => this.client.commit(this.batch()!.batch_id, this.plan()!), result => {
    this.previewRows.set([]); this.rows.set([]); this.choices.set({}); this.preview.set(null); this.plan.set(null); this.batch.set(result);
  }); }
  protected abandon() { return this.run(() => this.client.abandon(this.batch()!.batch_id), () => this.clear()); }
  protected decimal(value: string) { const n = BigInt(value), abs = n < 0n ? -n : n; return `${n < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`; }
  protected label(row: Record<string, unknown>): string { return row['name'] ? `${row['name']} ${row['email'] ?? ''}`
    : `${row['currency'] ?? '?'} ${row['amount_cents'] === undefined ? 'unavailable' : this.decimal(String(row['amount_cents']))} · ${row['occurred_at'] ?? ''}`; }
}
