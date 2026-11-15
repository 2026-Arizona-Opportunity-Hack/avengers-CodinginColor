import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store, type NewDonorInput } from '../core/store';
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
          <p class="lede">Someone who gave outside an import, or a person a board member just met.</p>
        </div>
      </header>

      <div class="split">
        <form class="stack gap" (submit)="submit($event)" novalidate>
          <fieldset class="stack" [disabled]="saving() || !!pendingInput">
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

          <fieldset class="stack" [disabled]="saving() || !!pendingInput">
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

          <fieldset class="stack" [disabled]="saving() || !!pendingInput">
            <legend><h2>First gift <span class="opt">(optional)</span></h2></legend>
            <div class="form-grid">
              <label class="field"><span>Settled amount, USD</span>
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

          @if (message()) { <p class="notice" role="alert">{{ message() }}</p> }
          @if (store.notice()) { <p class="error" role="alert">{{ store.notice() }}</p> }
          <div class="row">
            <button class="btn primary" type="submit" [disabled]="saving() || assignedElsewhere()">{{ saving() ? 'Saving?' : pendingInput ? 'Retry save' : 'Create donor' }}</button>
            <a class="btn" routerLink="/donors">Cancel</a>
          </div>
        </form>

        <aside class="panel" aria-label="Assignment">
          <div class="panel-head"><h2>Owner</h2></div>
          <div class="panel-body stack">
            <p>New donors go to the active board member with the fewest donors. The server confirms the owner when saving.</p>
            @if (store.live() && !store.isAdmin()) { <p>If assigned to another member, only that owner and admins can open the donor or log their gifts.</p> }
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

  protected readonly saving = signal(false);
  protected readonly message = signal('');
  protected readonly assignedElsewhere = signal(false);
  protected pendingInput: NewDonorInput | null = null;
  private readonly requestId = crypto.randomUUID();
  private readonly giftRequestId = crypto.randomUUID();
  private savedDonor: { id: string; owner_id: string | null } | null = null;

  protected val(e: Event) { return (e.target as HTMLInputElement).value; }

  protected readonly emailError = computed(() =>
    this.email().trim() && !EMAIL.test(this.email().trim()) ? 'Enter an email like name@example.org.' : '');
  protected readonly amountError = computed(() => {
    const a = this.amount().trim().replace(/[$,]/g, '');
    if (!this.amount().trim()) return '';
    return moneyCents(a) !== null ? '' : 'Enter a positive amount with at most two decimals.';
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

  protected async submit(event: Event) {
    event.preventDefault();
    if (this.saving() || this.assignedElsewhere()) return;
    this.tried.set(true);
    if (!this.first().trim() || this.emailError() || this.amountError()) return;
    if (this.amount().trim() && !validGiftDate(this.giftDate(), this.now)) { this.message.set('Enter a valid gift date no later than today.'); return; }
    const form = new FormData(event.target as HTMLFormElement);
    const custom: Record<string, string> = {};
    for (const f of this.store.customFields()) {
      const v = String(form.get(`custom_${f.key}`) ?? '').trim();
      if (v) custom[f.key] = v;
    }
    const name = this.kind() === 'individual' ? `${this.first().trim()} ${this.last().trim()}`.trim() : this.first().trim();
    this.pendingInput ??= {
      name, email: this.email().trim() || null, phone: this.phone().trim() || null,
      company: this.kind() === 'individual' ? this.company().trim() || null : null, kind: this.kind(),
      consent: this.consent() as Consent, preferred_channel: this.channel() as Channel, custom, source: 'manual',
    };
    this.saving.set(true);
    const epoch = this.store.sessionEpoch();
    try {
      this.savedDonor ??= await this.store.addDonor(this.pendingInput, this.requestId);
      if (epoch !== this.store.sessionEpoch() || !this.savedDonor) return;
      const donor = this.savedDonor;
      const visible = this.store.isAdmin() || donor.owner_id === this.store.me().id;
      const cents = moneyCents(this.amount().trim().replace(/[$,]/g, ''));
      if (cents !== null) {
        if (!visible) {
          this.assignedElsewhere.set(true);
          this.message.set('Donor saved and assigned to another board member. The first gift was not saved. Ask the assigned owner or an admin to log it.');
          return;
        }
        const saved = await this.store.addGift({ donor_id: donor.id, amount_cents: cents,
          campaign_id: this.campaignId() || null, occurred_at: `${this.giftDate()}T12:00:00-07:00`, source: 'manual',
        }, this.giftRequestId);
        if (epoch !== this.store.sessionEpoch()) return;
        if (!saved) { this.message.set('Donor saved. The first gift could not be confirmed. Retry save to finish without creating another donor or gift.'); return; }
      }
      if (!visible) {
        this.assignedElsewhere.set(true);
        this.message.set('Donor saved and assigned to another board member. The assigned owner and admins can open it.');
        return;
      }
      await this.router.navigate(['/donors', donor.id]);
    } finally { this.saving.set(false); }
  }
}

/** Parse dollars without floating point multiplication or silently rounded cents. */
export function moneyCents(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}
export function validGiftDate(value: string, maximum: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > maximum) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
