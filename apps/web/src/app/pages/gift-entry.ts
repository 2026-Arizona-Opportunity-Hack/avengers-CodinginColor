import { Component, effect, inject, input, signal } from '@angular/core';
import { Store } from '../core/store';
import { today } from '../core/format';
import type { GiftStatus } from '../core/models';
import { moneyCents, validGiftDate } from './donor-new';

@Component({
  selector: 'app-gift-entry',
  template: `
    <details class="panel section">
      <summary class="panel-head">Log a historical gift</summary>
      <form class="panel-body stack" (submit)="submit($event)" novalidate>
        <p>Record a gift already received or pending. This does not send a payment or contact the donor.</p>
        <fieldset class="form-grid" [disabled]="saving() || !!pending">
          <label class="field"><span>Amount</span><input class="input" name="amount" inputmode="decimal" required maxlength="20" /></label>
          <label class="field"><span>Refund amount</span><input class="input" name="refund" inputmode="decimal" value="0" maxlength="20" /></label>
          <label class="field"><span>Currency</span><select class="select" name="currency">
            @for (code of currencies; track code) { <option [value]="code" [selected]="code === 'USD'">{{ code }}</option> }
          </select></label>
          <label class="field"><span>Status</span><select class="select" name="status">
            <option value="settled">Settled</option><option value="pending">Pending</option><option value="void">Void</option>
          </select></label>
          <label class="field"><span>Date</span><input class="input" type="date" name="date" [value]="now" [max]="now" required /></label>
          <label class="field"><span>Campaign</span><select class="select" name="campaign">
            <option value="">General support</option>
            @for (campaign of store.campaigns(); track campaign.id) { <option [value]="campaign.id">{{ campaign.title }}</option> }
          </select></label>
        </fieldset>
        @if (message()) { <p class="notice" role="status">{{ message() }}</p> }
        @if (failed() && store.notice()) { <p class="error" role="alert">{{ store.notice() }}</p> }
        <button class="btn primary" type="submit" [disabled]="saving()">{{ saving() ? 'Saving...' : pending ? 'Retry gift save' : 'Save gift' }}</button>
      </form>
    </details>
  `,
})
export class GiftEntry {
  protected readonly store = inject(Store);
  readonly donorId = input.required<string>();
  protected readonly currencies = Intl.supportedValuesOf('currency');
  protected readonly now = today();
  protected readonly saving = signal(false);
  protected readonly failed = signal(false);
  protected readonly message = signal('');
  protected pending: Parameters<Store['addGift']>[0] | null = null;
  private requestId = crypto.randomUUID();
  private generation = 0;
  constructor() {
    effect(() => {
      this.donorId(); this.generation++;
      this.pending = null; this.requestId = crypto.randomUUID();
      this.message.set(''); this.failed.set(false); this.saving.set(false);
    });
  }

  protected async submit(event: Event) {
    event.preventDefault();
    if (this.saving()) return;
    const form = event.target as HTMLFormElement;
    if (!this.pending) {
      const data = new FormData(form);
      const value = (key: string) => String(data.get(key) ?? '').trim();
      const amount = moneyCents(value('amount'));
      const refund = /^0(?:\.0{1,2})?$/.test(value('refund')) || !value('refund') ? 0 : moneyCents(value('refund'));
      if (amount === null || refund === null || refund > amount) {
        this.message.set('Enter a positive amount and a refund between zero and the amount, with at most two decimal places.'); return;
      }
      if (!validGiftDate(value('date'), this.now)) { this.message.set('Enter a valid gift date no later than today.'); return; }
      const currency = value('currency');
      const status = value('status') as GiftStatus;
      if (!this.currencies.includes(currency) || !['settled', 'pending', 'void'].includes(status)) return;
      this.pending = { donor_id: this.donorId(), amount_cents: amount, refund_cents: refund, currency, status,
        campaign_id: value('campaign') || null, occurred_at: `${value('date')}T12:00:00-07:00`, source: 'manual' };
    }
    const epoch = this.store.sessionEpoch();
    const generation = this.generation;
    this.saving.set(true); this.failed.set(false);
    try {
      const saved = await this.store.addGift(this.pending, this.requestId);
      if (epoch !== this.store.sessionEpoch() || generation !== this.generation) return;
      if (saved.kind !== 'saved') {
        this.failed.set(true);
        if (saved.kind === 'invalid') {
          this.pending = null; this.requestId = crypto.randomUUID();
          this.message.set('The gift was rejected. Correct the details and submit again.');
        } else this.message.set('Gift save could not be confirmed. Retry with these same details to avoid duplicates.');
        return;
      }
      this.store.selectedCurrency.set(this.pending.currency ?? 'USD');
      this.pending = null; this.requestId = crypto.randomUUID();
      form.reset(); this.message.set('Gift saved to the timeline.');
    } finally { if (generation === this.generation) this.saving.set(false); }
  }
}
