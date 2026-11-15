import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '../core/store';
import { date, money, relativeDue, today } from '../core/format';
import { CommunicationKind, Consent, SOURCE_LABEL } from '../core/models';

type TimelineEntry =
  | { type: 'gift'; at: string; id: string; title: string; detail: string; amount: number; status: string; source: string }
  | { type: CommunicationKind; at: string; id: string; title: string; detail: string; by: string; direction: string; viaDraft: boolean };

const KIND_LABEL: Record<CommunicationKind, string> = { email: 'Email', text: 'Text', call: 'Call', meeting: 'Meeting', note: 'Note' };

@Component({
  selector: 'app-donor-detail',
  imports: [RouterLink],
  template: `
    @let d = donor();
    @if (!d) {
      <div class="page">
        <header class="page-head"><div><p class="label eyebrow">Donor</p><h1>Donor not found</h1>
          <p class="lede">This record does not exist or is owned by another board member.</p></div></header>
        <a class="btn" routerLink="/donors">Back to donors</a>
      </div>
    } @else {
      <div class="page">
        <nav aria-label="Breadcrumb" class="crumbs"><a routerLink="/donors">Donors</a> <span aria-hidden="true">/</span> <span aria-current="page">{{ d.name }}</span></nav>
        <header class="page-head">
          <div>
            <p class="label eyebrow">{{ d.kind === 'individual' ? 'Individual donor' : d.kind === 'foundation' ? 'Foundation' : 'Company' }}</p>
            <h1>{{ d.name }}</h1>
            <p class="lede">Owned by <strong>{{ store.member(d.owner_id)?.name ?? 'nobody' }}</strong> · donor since {{ since() }} · {{ d.sources.length }} source{{ d.sources.length === 1 ? '' : 's' }} merged</p>
          </div>
          <div class="actions">
            <button class="btn" type="button" (click)="openLog()">Log contact</button>
            <button class="btn primary" type="button" (click)="draftThanks()">Draft thank-you</button>
          </div>
        </header>

        @if (flash()) { <p class="notice" role="status">{{ flash() }} @if (flashOutreach()) { <a routerLink="/outreach">Open outreach</a> }</p> }

        <section class="stats" aria-label="Giving summary">
          <div class="stat"><p class="label">Lifetime, net</p><p class="value">{{ money(store.lifetime(d.id)) }}</p></div>
          <div class="stat"><p class="label">This year</p><p class="value">{{ money(thisYear()) }}</p></div>
          <div class="stat"><p class="label">Gifts</p><p class="value">{{ gifts().length }}</p></div>
          <div class="stat"><p class="label">Last contact</p><p class="value small">{{ lastContact() ? date(lastContact()!) : 'Never' }}</p></div>
        </section>

        <div class="split section">
          <div>
            <section aria-labelledby="next-h">
              <div class="section-head">
                <h2 id="next-h">Next steps</h2>
                <p>Planned. Not done yet.</p>
              </div>
              <ul class="list steps-list">
                @for (f of steps(); track f.id) {
                  <li class="step">
                    <div>
                      <p class="strong">{{ f.action }}</p>
                      <p class="meta"><span class="tag" [class.solid]="f.due_on < now">{{ relativeDue(f.due_on) }}</span> {{ date(f.due_on) }} · {{ f.kind === 'quarterly' ? 'Quarterly touch' : 'Next step' }}</p>
                    </div>
                    <div class="row">
                      <button class="btn small" type="button" (click)="store.setFollowUpStatus(f.id, 'done')">Mark done</button>
                      <button class="btn small link" type="button" (click)="store.setFollowUpStatus(f.id, 'dismissed')">Dismiss</button>
                    </div>
                  </li>
                } @empty {
                  <li class="none">No open next step. Every donor should have one.</li>
                }
              </ul>
              <form class="add-step" (submit)="addStep($event)">
                <label class="field grow"><span>New next step</span>
                  <input class="input" name="action" required maxlength="200" placeholder="Invite to Day of Compute" [value]="stepAction()" (input)="stepAction.set($any($event.target).value)" /></label>
                <label class="field"><span>Due</span>
                  <input class="input" type="date" name="due" required [value]="stepDue()" (input)="stepDue.set($any($event.target).value)" /></label>
                <button class="btn" type="submit" [disabled]="!stepAction().trim() || !stepDue()">Add</button>
              </form>
            </section>

            <section class="section" aria-labelledby="tl-h">
              <div class="section-head">
                <h2 id="tl-h">Timeline</h2>
                <div class="segmented" role="group" aria-label="Filter timeline">
                  @for (f of filters; track f.value) {
                    <button type="button" [attr.aria-pressed]="filter() === f.value" (click)="filter.set(f.value)">{{ f.label }}</button>
                  }
                </div>
              </div>
              <ol class="timeline" aria-label="Gifts and communications, newest first">
                @for (e of timeline(); track e.id) {
                  <li>
                    <time class="mono when" [attr.datetime]="e.at">{{ date(e.at) }}</time>
                    <span class="tag kind" [class.solid]="e.type === 'gift'">{{ e.type === 'gift' ? 'Gift' : kindLabel[e.type] }}</span>
                    <div class="what">
                      @if (e.type === 'gift') {
                        <p class="strong"><span class="mono">{{ money(e.amount) }}</span> · {{ e.title }}</p>
                        <p>{{ e.detail }} · via {{ e.source }} @if (e.status !== 'settled') { <span class="tag dashed">{{ e.status }}</span> }</p>
                      } @else {
                        <p class="strong">{{ e.title }}</p>
                        <p class="body">{{ e.detail }}</p>
                        <p class="by">{{ e.direction === 'inbound' ? 'Received by' : 'By' }} {{ e.by }}@if (e.viaDraft) { · approved draft }</p>
                      }
                    </div>
                  </li>
                } @empty {
                  <li class="none">Nothing recorded yet.</li>
                }
              </ol>
            </section>
          </div>

          <aside class="stack" aria-label="Profile">
            <section class="panel">
              <div class="panel-head"><h2>Profile</h2>
                <button class="btn small" type="button" (click)="editing.set(!editing())" [attr.aria-expanded]="editing()">{{ editing() ? 'Cancel' : 'Edit' }}</button></div>
              @if (!editing()) {
                <dl class="kv panel-body">
                  <dt>Email</dt><dd>@if (d.email) { <a [href]="'mailto:' + d.email">{{ d.email }}</a> } @else { Not on file }</dd>
                  <dt>Phone</dt><dd>@if (d.phone) { <a [href]="'tel:' + d.phone">{{ d.phone }}</a> } @else { Not on file }</dd>
                  @if (d.kind === 'individual') { <dt>Company</dt><dd>{{ d.company ?? 'Not on file' }}</dd> }
                  <dt>Consent</dt><dd><span class="tag" [class.solid]="d.consent === 'granted'">{{ d.consent }}</span></dd>
                  <dt>Prefers</dt><dd>{{ d.preferred_channel === 'text' ? 'Text message' : 'Email' }}</dd>
                  <dt>Sources</dt><dd>{{ sourceNames() }}</dd>
                  @for (f of store.customFields(); track f.key) {
                    <dt>{{ f.label }}</dt><dd>{{ d.custom[f.key] || 'Not set' }}</dd>
                  }
                </dl>
              } @else {
                <form class="panel-body stack" (submit)="saveProfile($event)">
                  <label class="field"><span>Name</span><input class="input" name="name" required maxlength="300" [value]="d.name" /></label>
                  <label class="field"><span>Email</span><input class="input" name="email" type="email" [value]="d.email ?? ''" /></label>
                  <label class="field"><span>Phone</span><input class="input" name="phone" type="tel" [value]="d.phone ?? ''" /></label>
                  <label class="field"><span>Company</span><input class="input" name="company" [value]="d.company ?? ''" /></label>
                  <label class="field"><span>Consent to contact</span>
                    <select class="select" name="consent">
                      @for (c of consents; track c) { <option [value]="c" [selected]="d.consent === c">{{ c }}</option> }
                    </select></label>
                  @for (f of store.customFields(); track f.key) {
                    <label class="field"><span>{{ f.label }}</span>
                      @if (f.type === 'select') {
                        <select class="select" [name]="'custom_' + f.key">
                          <option value="">Not set</option>
                          @for (o of f.options; track o) { <option [value]="o" [selected]="d.custom[f.key] === o">{{ o }}</option> }
                        </select>
                      } @else {
                        <input class="input" [name]="'custom_' + f.key" [type]="f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'" [value]="d.custom[f.key] ?? ''" />
                      }
                    </label>
                  }
                  <button class="btn primary" type="submit">Save profile</button>
                </form>
              }
            </section>

            <section class="panel">
              <div class="panel-head"><h2>Owner</h2></div>
              <div class="panel-body stack">
                <p><strong>{{ store.member(d.owner_id)?.name ?? 'Unassigned' }}</strong><br />{{ store.member(d.owner_id)?.email }}</p>
                @if (store.isAdmin()) {
                  <label class="field"><span>Reassign to</span>
                    <select class="select" (change)="reassign($any($event.target).value)">
                      @for (m of store.boardMembers(); track m.id) { <option [value]="m.id" [selected]="m.id === d.owner_id">{{ m.name }}</option> }
                    </select></label>
                  <p class="hint">Reassignment is recorded in the audit log.</p>
                } @else {
                  <p class="hint">Only an admin can change the owner.</p>
                }
              </div>
            </section>

            @if (store.isAdmin()) {
              <button class="btn" type="button" (click)="archive()">Archive donor</button>
            }
          </aside>
        </div>

        <dialog #logDialog class="modal" aria-labelledby="log-h" (close)="logOpen.set(false)">
          <form method="dialog" (submit)="saveLog($event)">
            <div class="panel-head"><h2 id="log-h">Log contact with {{ d.name }}</h2></div>
            <div class="panel-body stack">
              <fieldset>
                <legend class="field-legend">Type</legend>
                <div class="segmented">
                  @for (k of kinds; track k) {
                    <button type="button" [attr.aria-pressed]="logKind() === k" (click)="logKind.set(k)">{{ kindLabel[k] }}</button>
                  }
                </div>
              </fieldset>
              <label class="field"><span>Summary</span><input class="input" name="summary" required maxlength="140" placeholder="Texted about Day of Compute" /></label>
              <label class="field"><span>Details</span><textarea class="textarea" name="body" maxlength="2000" placeholder="What was said, what they asked for"></textarea></label>
              <label class="field"><span>When</span><input class="input" type="date" name="when" required [value]="now" /></label>
            </div>
            <div class="foot">
              <button class="btn" type="button" (click)="logDialog.close()">Cancel</button>
              <button class="btn primary" type="submit">Save to timeline</button>
            </div>
          </form>
        </dialog>
      </div>
    }
  `,
  styles: `
    .crumbs { font-size: 13px; margin-bottom: 16px; display: flex; gap: 8px; }
    .value.small { font-size: 20px; }
    .strong { font-weight: 600; }
    .steps-list { border-top: 1px solid var(--rule); }
    .step { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
    .meta { font-size: 12.5px; margin-top: 4px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .none { font-size: 13px; padding: 14px 0; }
    .add-step { display: flex; gap: 10px; align-items: flex-end; margin-top: 12px; flex-wrap: wrap; }
    .add-step .grow { flex: 1; min-width: 200px; }
    .timeline { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule); }
    .timeline li { display: grid; grid-template-columns: 112px 84px 1fr; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--hair); }
    .when { font-size: 12px; padding-top: 2px; }
    .kind { justify-self: start; }
    .what p { font-size: 13.5px; }
    .body { white-space: pre-line; margin-top: 2px; }
    .by { font-size: 12px; margin-top: 4px; }
    .hint { font-size: 12.5px; }
    .field-legend { font-size: 13px; font-weight: 500; margin-bottom: 6px; }
    @media (max-width: 640px) { .timeline li { grid-template-columns: 1fr; gap: 4px; } }
  `,
})
export class DonorDetailPage {
  protected readonly store = inject(Store);
  private readonly router = inject(Router);
  readonly id = input.required<string>();

  protected readonly money = money;
  protected readonly date = date;
  protected readonly relativeDue = relativeDue;
  protected readonly kindLabel = KIND_LABEL;
  protected readonly kinds: CommunicationKind[] = ['text', 'email', 'call', 'meeting', 'note'];
  protected readonly consents: Consent[] = ['unknown', 'granted', 'denied'];
  protected readonly filters = [
    { value: 'all', label: 'All' }, { value: 'gifts', label: 'Gifts' }, { value: 'comms', label: 'Communications' },
  ] as const;
  protected readonly now = today();

  protected readonly filter = signal<'all' | 'gifts' | 'comms'>('all');
  protected readonly editing = signal(false);
  protected readonly flash = signal('');
  protected readonly flashOutreach = computed(() => this.flash().startsWith('Thank-you drafted'));
  protected readonly stepAction = signal('');
  protected readonly stepDue = signal(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  protected readonly logKind = signal<CommunicationKind>('text');
  protected readonly logOpen = signal(false);
  private readonly logDialog = viewChild<ElementRef<HTMLDialogElement>>('logDialog');

  protected readonly donor = computed(() => this.store.donor(this.id()));
  protected readonly gifts = computed(() => this.store.giftsFor(this.id()));
  protected readonly thisYear = computed(() =>
    this.gifts().filter((g) => g.occurred_at.startsWith(this.now.slice(0, 4))).reduce((s, g) => s + this.store.netCents(g), 0));
  protected readonly since = computed(() => {
    const first = this.gifts().map((g) => g.occurred_at).sort()[0] ?? this.donor()?.created_at;
    return first ? first.slice(0, 4) : '—';
  });
  protected readonly sourceNames = computed(() => (this.donor()?.sources ?? []).map((s) => SOURCE_LABEL[s]).join(', '));
  protected readonly steps = computed(() =>
    this.store.followUps().filter((f) => f.donor_id === this.id() && f.status === 'open').sort((a, b) => a.due_on.localeCompare(b.due_on)));
  protected readonly lastContact = computed(() =>
    this.store.communicationsFor(this.id()).filter((c) => c.direction !== 'internal').map((c) => c.occurred_at).sort().at(-1) ?? null);

  protected readonly timeline = computed<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [];
    if (this.filter() !== 'comms') {
      for (const g of this.gifts()) {
        const campaign = this.store.campaign(g.campaign_id);
        const program = this.store.program(campaign?.program_id ?? null);
        entries.push({
          type: 'gift', at: g.occurred_at, id: g.id, title: campaign?.title ?? 'General support',
          detail: g.refund_cents ? `Refunded ${money(g.refund_cents)}` : program ? `Restricted to ${program.title}` : 'Unrestricted',
          amount: g.amount_cents, status: g.status, source: SOURCE_LABEL[g.source],
        });
      }
    }
    if (this.filter() !== 'gifts') {
      for (const c of this.store.communicationsFor(this.id())) {
        entries.push({
          type: c.kind, at: c.occurred_at, id: c.id, title: c.summary, detail: c.body,
          by: this.store.member(c.member_id)?.name ?? 'Unknown', direction: c.direction, viaDraft: !!c.draft_id,
        });
      }
    }
    return entries.sort((a, b) => b.at.localeCompare(a.at));
  });

  protected openLog() {
    this.logKind.set(this.donor()?.preferred_channel ?? 'text');
    this.logDialog()?.nativeElement.showModal();
  }

  protected saveLog(event: Event) {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const summary = String(form.get('summary') ?? '').trim();
    const when = String(form.get('when') ?? this.now);
    if (!summary) return;
    this.store.logCommunication({
      donor_id: this.id(), kind: this.logKind(), summary, body: String(form.get('body') ?? '').trim(),
      occurred_at: `${when}T${new Date().toISOString().slice(11, 19)}Z`,
    });
    (event.target as HTMLFormElement).reset();
    this.logDialog()?.nativeElement.close();
    this.flash.set(`${KIND_LABEL[this.logKind()]} logged on the timeline.`);
  }

  protected addStep(event: Event) {
    event.preventDefault();
    if (!this.stepAction().trim() || !this.stepDue()) return;
    this.store.addFollowUp({ donor_id: this.id(), action: this.stepAction().trim(), due_on: this.stepDue() });
    this.stepAction.set('');
  }

  protected draftThanks() {
    const d = this.donor();
    if (!d) return;
    const template = d.preferred_channel === 'text' && d.phone ? 't-thanks-text' : 't-thanks-email';
    const last = this.store.lastGift(d.id);
    this.store.createDraft(d.id, template, last ? `${money(last.amount_cents)} gift on ${last.occurred_at.slice(0, 10)}` : 'Manual thank-you');
    this.flash.set('Thank-you drafted. It waits for approval before anyone sends it.');
  }

  protected async saveProfile(event: Event) {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const value = (k: string) => String(form.get(k) ?? '').trim() || null;
    const name = value('name');
    if (!name) return;
    const custom: Record<string, string> = {};
    for (const f of this.store.customFields()) {
      const v = value(`custom_${f.key}`);
      if (v) custom[f.key] = v;
    }
    const saved = await this.store.updateDonor(this.id(), {
      name, email: value('email'), phone: value('phone'), company: value('company'),
      consent: (value('consent') ?? 'unknown') as Consent, custom,
    });
    if (!saved) return;
    this.editing.set(false);
    this.flash.set('Profile saved and recorded in the audit log.');
  }

  protected async reassign(ownerId: string) {
    if (!(await this.store.reassign(this.id(), ownerId))) return;
    this.flash.set(`Owner changed to ${this.store.member(ownerId)?.name}.`);
  }

  protected async archive() {
    if (await this.store.archiveDonor(this.id())) this.router.navigateByUrl('/donors');
  }
}
