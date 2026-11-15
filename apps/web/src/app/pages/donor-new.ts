import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '../core/store';
import { Channel, Consent, DonorKind } from '../core/models';
import { today } from '../core/format';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Component({
  selector: 'app-donor-new',
  imports: [RouterLink],
  template: `
    <div class="page">
      <nav aria-label="Breadcrumb" class="crumbs"><a routerLink="/donors">Donors</a> <span aria-hidden="true">/</span> <span aria-current="page">Add donor</span></nav>
      <header class="page-head">
        <div>
          <p class="label eyebrow">Add donor</p>
          <h1>Add one donor by hand</h1>
          <p class="lede">For people who gave outside Zeffy or Benevity, or whom a board member just met. Files with many rows go through Import.</p>
        </div>
      </header>

      <div class="split">
        <form class="stack gap" (submit)="submit($event)" novalidate>
          <fieldset class="stack">
            <legend><h2>Who</h2></legend>
            <div class="segmented" role="group" aria-label="Donor type">
              @for (k of kinds; track k.value) {
                <button type="button" [attr.aria-pressed]="kind() === k.value" (click)="kind.set(k.value)">{{ k.label }}</button>
              }
            </div>
            <div class="form-grid">
              @if (kind() === 'individual') {
                <label class="field"><span>First name</span>
                  <input class="input" name="first" autocomplete="given-name" required [value]="first()" (input)="first.set(val($event))"
                    [attr.aria-invalid]="tried() && !first().trim()" aria-describedby="first-err" />
                  @if (tried() && !first().trim()) { <span id="first-err" class="error">Enter a first name.</span> }
                </label>
                <label class="field"><span>Last name</span>
                  <input class="input" name="last" autocomplete="family-name" [value]="last()" (input)="last.set(val($event))" /></label>
                <label class="field full"><span>Company <span class="opt">(employer, optional)</span></span>
                  <input class="input" name="company" autocomplete="organization" [value]="company()" (input)="company.set(val($event))" /></label>
              } @else {
                <label class="field full"><span>Organization name</span>
                  <input class="input" name="org" autocomplete="organization" required [value]="first()" (input)="first.set(val($event))"
                    [attr.aria-invalid]="tried() && !first().trim()" aria-describedby="org-err" />
                  @if (tried() && !first().trim()) { <span id="org-err" class="error">Enter the organization name.</span> }
                </label>
              }
              <label class="field"><span>Email</span>
                <input class="input" type="email" name="email" autocomplete="email" [value]="email()" (input)="email.set(val($event))"
                  [attr.aria-invalid]="!!emailError()" aria-describedby="email-err" />
                @if (emailError()) { <span id="email-err" class="error">{{ emailError() }}</span> }
              </label>
              <label class="field"><span>Phone</span>
                <input class="input" type="tel" name="phone" autocomplete="tel" [value]="phone()" (input)="phone.set(val($event))" /></label>
            </div>
            @if (duplicate(); as dup) {
              <div class="notice" role="alert">
                <div><strong>Possible duplicate.</strong> {{ dup.name }} already has this {{ dupField() }}. One record per donor:
                  <a [routerLink]="['/donors', dup.id]">open the existing record</a> and log the gift there instead.</div>
              </div>
            }
          </fieldset>

          <fieldset class="stack">
            <legend><h2>Contact preferences</h2></legend>
            <div class="form-grid">
              <label class="field"><span>Consent to contact</span>
                <select class="select" name="consent" (change)="consent.set(val($event))">
                  <option value="unknown">Unknown</option><option value="granted">Granted</option><option value="denied">Denied</option>
                </select></label>
              <label class="field"><span>Prefers</span>
                <select class="select" name="channel" (change)="channel.set(val($event))">
                  <option value="email">Email</option><option value="text">Text message</option>
                </select></label>
              @for (f of store.customFields(); track f.key) {
                <label class="field"><span>{{ f.label }}</span>
                  @if (f.type === 'select') {
                    <select class="select" [name]="'custom_' + f.key"><option value="">Not set</option>
                      @for (o of f.options; track o) { <option [value]="o">{{ o }}</option> }</select>
                  } @else {
                    <input class="input" [name]="'custom_' + f.key" [type]="f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'" />
                  }
                </label>
              }
            </div>
          </fieldset>

          <fieldset class="stack">
            <legend><h2>First gift <span class="opt">(optional)</span></h2></legend>
            <div class="form-grid">
              <label class="field"><span>Amount, USD</span>
                <input class="input" name="amount" inputmode="decimal" placeholder="250" [value]="amount()" (input)="amount.set(val($event))"
                  [attr.aria-invalid]="!!amountError()" aria-describedby="amount-err" />
                @if (amountError()) { <span id="amount-err" class="error">{{ amountError() }}</span> }
              </label>
              <label class="field"><span>Date</span><input class="input" type="date" name="giftDate" [max]="now" [value]="giftDate()" (input)="giftDate.set(val($event))" /></label>
              <label class="field full"><span>Campaign</span>
                <select class="select" name="campaign" (change)="campaignId.set(val($event))">
                  <option value="">General support</option>
                  @for (c of store.campaigns(); track c.id) { <option [value]="c.id">{{ c.title }}</option> }
                </select></label>
            </div>
          </fieldset>

          <div class="row">
            <button class="btn primary" type="submit">Create donor</button>
            <a class="btn" routerLink="/donors">Cancel</a>
          </div>
        </form>

        <aside class="panel" aria-label="Assignment">
          <div class="panel-head"><h2>Owner</h2></div>
          <div class="panel-body stack">
            @if (store.isAdmin()) { <p>New donors go to the active board member with the fewest donors.</p> }
            @else { <p>Donors you add are yours. Admins can reassign them later.</p> }
            <p>This donor will be owned by <strong>{{ store.previewOwner()?.name ?? 'nobody (no active board members)' }}</strong>.</p>
            <table class="table">
              <thead><tr><th scope="col">Board member</th><th scope="col" class="num">Donors</th></tr></thead>
              <tbody>
                @for (m of store.boardMembers(); track m.id) {
                  <tr><th scope="row">{{ m.name }}</th><td class="num mono">{{ store.ownerLoad().get(m.id) }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    .crumbs { font-size: 13px; margin-bottom: 16px; display: flex; gap: 8px; }
    .gap { gap: 32px; }
    legend h2 { margin-bottom: 4px; }
    .opt { font-weight: 400; font-size: 13px; }
  `,
})
export class DonorNewPage {
  protected readonly store = inject(Store);
  private readonly router = inject(Router);
  protected readonly now = today();
  protected readonly kinds: Array<{ value: DonorKind; label: string }> = [
    { value: 'individual', label: 'Individual' }, { value: 'company', label: 'Company' }, { value: 'foundation', label: 'Foundation' },
  ];

  protected readonly kind = signal<DonorKind>('individual');
  protected readonly first = signal('');
  protected readonly last = signal('');
  protected readonly company = signal('');
  protected readonly email = signal('');
  protected readonly phone = signal('');
  protected readonly consent = signal('unknown');
  protected readonly channel = signal('email');
  protected readonly amount = signal('');
  protected readonly giftDate = signal(this.now);
  protected readonly campaignId = signal('');
  protected readonly tried = signal(false);

  protected val(e: Event) { return (e.target as HTMLInputElement).value; }

  protected readonly emailError = computed(() =>
    this.email().trim() && !EMAIL.test(this.email().trim()) ? 'Enter an email like name@example.org.' : '');
  protected readonly amountError = computed(() => {
    const a = this.amount().trim().replace(/[$,]/g, '');
    if (!a) return '';
    return /^\d+(\.\d{1,2})?$/.test(a) && Number(a) > 0 ? '' : 'Enter a positive amount with at most two decimals.';
  });
  private readonly digits = (s: string | null) => (s ?? '').replace(/\D/g, '').slice(-10);
  protected readonly duplicate = computed(() => {
    const email = this.email().trim().toLowerCase();
    const phone = this.digits(this.phone());
    return this.store.allDonors().find((d) =>
      (email && d.email?.toLowerCase() === email) || (phone.length === 10 && this.digits(d.phone) === phone)) ?? null;
  });
  protected readonly dupField = computed(() =>
    this.duplicate()?.email?.toLowerCase() === this.email().trim().toLowerCase() ? 'email' : 'phone number');

  protected submit(event: Event) {
    event.preventDefault();
    this.tried.set(true);
    if (!this.first().trim() || this.emailError() || this.amountError()) return;
    const form = new FormData(event.target as HTMLFormElement);
    const custom: Record<string, string> = {};
    for (const f of this.store.customFields()) {
      const v = String(form.get(`custom_${f.key}`) ?? '').trim();
      if (v) custom[f.key] = v;
    }
    const name = this.kind() === 'individual' ? `${this.first().trim()} ${this.last().trim()}`.trim() : this.first().trim();
    const donor = this.store.addDonor({
      name, email: this.email().trim() || null, phone: this.phone().trim() || null,
      company: this.kind() === 'individual' ? this.company().trim() || null : null, kind: this.kind(),
      consent: this.consent() as Consent, preferred_channel: this.channel() as Channel, custom, source: 'manual',
    });
    const cents = Math.round(Number(this.amount().replace(/[$,]/g, '')) * 100);
    if (cents > 0) {
      this.store.addGift({
        donor_id: donor.id, amount_cents: cents, campaign_id: this.campaignId() || null,
        occurred_at: `${this.giftDate()}T12:00:00-07:00`, source: 'manual',
      });
    }
    this.router.navigate(['/donors', donor.id]);
  }
}
