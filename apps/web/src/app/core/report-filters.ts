import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Store } from './store';
import { today } from './format';

/** Reporting filters persist while navigating between overview and retention. */
@Injectable({ providedIn: 'root' })
export class ReportFilters {
  private readonly store = inject(Store);
  readonly from = signal(`${today().slice(0, 4)}-01-01`);
  readonly through = signal(today());
  readonly program = signal('');
  readonly owner = signal('');
  readonly campaign = signal('');
  readonly cohort = signal('');
  constructor() {
    effect(() => {
      this.store.sessionEpoch();
      this.owner.set(''); this.program.set(''); this.campaign.set(''); this.cohort.set('');
    });
  }
  readonly valid = computed(() => {
    const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T12:00:00Z`))
      && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
    return validDay(this.from()) && validDay(this.through()) && this.from() <= this.through()
      && this.from().slice(0, 4) === this.through().slice(0, 4) && (!this.cohort() || /^\d{4}$/.test(this.cohort()));
  });
  readonly query = computed(() => Object.fromEntries(Object.entries({ from: this.from(), programId: this.program(),
    ownerId: this.owner(), campaignId: this.campaign(), cohort: this.cohort() }).filter(([, value]) => !!value)));
  private readonly firstYears = computed(() => {
    const first = new Map<string, string>();
    for (const g of this.store.allGifts()) if (g.status === 'settled' && g.amount_cents > g.refund_cents) {
      const day = this.day(g.occurred_at), before = first.get(g.donor_id);
      if (!before || day < before) first.set(g.donor_id, day);
    }
    return new Map([...first].map(([id, day]) => [id, day.slice(0, 4)]));
  });
  readonly gifts = computed(() => this.store.ledgerGifts().filter(g =>
    (!this.program() || this.store.campaign(g.campaign_id)?.program_id === this.program())
    && (!this.campaign() || g.campaign_id === this.campaign())
    && (!this.owner() || this.store.historicalDonor(g.donor_id)?.owner_id === this.owner())
    && (!this.cohort() || this.firstYears().get(g.donor_id) === this.cohort())));
  readonly donors = computed(() => {
    const ids = new Set(this.gifts().map(g => g.donor_id));
    return this.store.donors().filter(d => (!this.owner() || d.owner_id === this.owner())
      && (!(this.program() || this.campaign() || this.cohort()) || ids.has(d.id)));
  });
  visible(id: string | null) { return id === null ? !(this.owner() || this.program() || this.campaign() || this.cohort()) : this.donors().some(d => d.id === id); }
  day(at: string) { return new Date(Date.parse(at) - 7 * 3600_000).toISOString().slice(0, 10); }
}
