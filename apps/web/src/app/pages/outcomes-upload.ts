import { Component, effect, inject, input, output, signal } from '@angular/core';
import { Api, ApiError } from '../core/api';
import { Store } from '../core/store';

@Component({
  selector: 'app-outcomes-upload',
  template: `
    <details class="panel no-print">
      <summary>Upload approved program outcomes</summary>
      <p>Upload a JSON array of aggregate results. Include the program ID, period (exclusive end), metric, value,
        unit, denominator and source. Use null for missing values and 0 only for a reported zero. Keep student records out.</p>
      <button class="btn" type="button" (click)="text.set(example()); approved.set(false)" [disabled]="busy()">Use selected program and period</button>
      <label class="field">JSON file<input type="file" accept=".json,application/json" (change)="readFile($event)" [disabled]="busy()" /></label>
      <label class="field">Review aggregate results<textarea class="input" rows="10" [value]="text()"
        (input)="text.set($any($event.target).value); approved.set(false)" [disabled]="busy()"></textarea></label>
      <p>Supply the actual aggregate source before approving. Re-uploading the same program, period and metric replaces its approved values.</p>
      <label><input type="checkbox" [checked]="approved()" (change)="approved.set($any($event.target).checked)" [disabled]="busy()" />
        I reviewed these aggregate results and approve them for funder reports.</label>
      <p><button class="btn primary" type="button" (click)="save()" [disabled]="!approved() || !text().trim() || busy()">{{ busy() ? 'Saving...' : 'Approve and save outcomes' }}</button></p>
      @if (error()) { <p role="alert">{{ error() }}</p> }
      @if (success()) { <p role="status">{{ success() }}</p> }
    </details>
  `,
  styles: `details { padding:20px } summary { cursor:pointer; font-weight:600 } p,.field { margin:12px 0 } textarea { width:100%; font-family:monospace }`,
})
export class OutcomesUpload {
  private readonly api = inject(Api);
  private readonly store = inject(Store);
  readonly example = input.required<string>();
  readonly saved = output<void>();
  protected readonly text = signal('');
  protected readonly approved = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly success = signal<string | null>(null);
  constructor() {
    effect(() => {
      this.store.sessionEpoch();
      this.text.set(''); this.approved.set(false); this.busy.set(false); this.error.set(null); this.success.set(null);
    });
  }
  protected async readFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0], epoch = this.store.sessionEpoch();
    if (!file || this.busy()) return;
    this.approved.set(false); this.error.set(null); this.success.set(null);
    if (file.size > 100_000) { this.error.set('Choose a JSON file smaller than 100 KB.'); return; }
    this.busy.set(true);
    try { const text = await file.text(); if (epoch === this.store.sessionEpoch() && this.store.signedIn()) this.text.set(text); }
    catch { if (epoch === this.store.sessionEpoch()) this.error.set('The file could not be read. Try again.'); }
    finally { if (epoch === this.store.sessionEpoch()) this.busy.set(false); }
  }
  protected async save() {
    if (!this.approved() || this.busy() || !this.store.signedIn() || !this.store.isAdmin()) return;
    let outcomes: unknown;
    try {
      outcomes = JSON.parse(this.text());
      if (!Array.isArray(outcomes) || !outcomes.length || outcomes.length > 100) throw new Error();
    } catch { this.error.set('Enter a JSON array with 1 to 100 aggregate results.'); return; }
    const epoch = this.store.sessionEpoch();
    this.busy.set(true); this.error.set(null); this.success.set(null);
    try {
      const result = await this.api.request<{ approved: number }>('/api/v1/reports/outcomes', {
        method: 'POST', body: JSON.stringify({ approved: true, outcomes }),
      });
      if (epoch !== this.store.sessionEpoch() || !this.store.signedIn()) return;
      this.success.set(`Approved ${result.approved} aggregate results.`); this.approved.set(false); this.saved.emit();
    } catch (error) {
      if (epoch === this.store.sessionEpoch()) this.error.set(error instanceof ApiError ? error.message : 'The outcomes could not be saved. Try again.');
    } finally { if (epoch === this.store.sessionEpoch()) this.busy.set(false); }
  }
}
