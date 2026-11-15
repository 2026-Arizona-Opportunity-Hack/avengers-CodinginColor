import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { GiftEntry } from './gift-entry';
import { GroundedUpdate } from './grounded-update';
import { DebriefEntry } from './debrief-entry';
import { Store } from '../core/store';
import { date, relativeDue, today } from '../core/format';
import { CommunicationKind, Consent, SOURCE_LABEL } from '../core/models';

type TimelineEntry =
  | { type: 'gift'; at: string; id: string; title: string; detail: string; amount: number; status: string; source: string }
  | { type: CommunicationKind; at: string; id: string; title: string; detail: string; by: string; direction: string; viaDraft: boolean };

const KIND_LABEL: Record<CommunicationKind, string> = { email: 'Email', text: 'Text', call: 'Call', meeting: 'Meeting', note: 'Note' };
const KIND_ICON: Record<CommunicationKind | 'gift', string> = {
  gift: 'lucideHandCoins', email: 'lucideMail', text: 'lucideMessageSquare', call: 'lucidePhone', meeting: 'lucideCalendar', note: 'lucideStickyNote',
};

@Component({
  selector: 'app-donor-detail',
  imports: [RouterLink, NgIcon, HlmButtonImports, GiftEntry, GroundedUpdate, DebriefEntry],
  template: `
    @let d = donor();
    @if (!d) {
      <div class="page">
        <header class="page-head"><div><h1>Donor not found</h1>
          <p class="lede">This record does not exist or is owned by another board member.</p></div></header>
        <a class="btn" routerLink="/donors">Back to donors</a>
      </div>
    } @else {
      <div class="page">
        <nav aria-label="Breadcrumb" class="crumbs"><a routerLink="/donors">{{ store.isAdmin() ? 'Donors' : 'Your donors' }}</a>
          <ng-icon name="lucideChevronRight" size="14" aria-hidden="true" /><span aria-current="page">{{ d.name }}</span></nav>
        <header class="hero glass">
          <span class="hero-avatar" [attr.data-kind]="d.kind" aria-hidden="true">
            @if (d.kind === 'individual') { {{ store.initials(d.name) }} } @else { <ng-icon name="lucideBuilding2" size="26" /> }
          </span>
          <div class="min-w-0 flex-1">
            <p class="kind">{{ d.kind === 'individual' ? (d.company ? 'Individual · ' + d.company : 'Individual donor') : d.kind === 'foundation' ? 'Foundation' : 'Company' }}</p>
            <h1>{{ d.name }}</h1>
            <div class="facts">
              <span><ng-icon name="lucideUser" size="14" aria-hidden="true" />Owned by <strong>{{ store.member(d.owner_id)?.name ?? 'nobody' }}</strong></span>
              <span><ng-icon name="lucideHistory" size="14" aria-hidden="true" />Donor since {{ since() }}</span>
              <span><ng-icon name="lucideDatabase" size="14" aria-hidden="true" />{{ d.sources.length }} source{{ d.sources.length === 1 ? '' : 's' }} merged</span>
              <span class="consent" [attr.data-consent]="d.consent"><ng-icon [name]="d.consent === 'granted' ? 'lucideCircleCheck' : 'lucideCircleAlert'" size="14" aria-hidden="true" />Consent {{ d.consent }}</span>
            </div>
          </div>
          <div class="hero-actions">
            <button hlmBtn variant="outline" size="sm" type="button" (click)="openLog('text')"><ng-icon name="lucideMessageSquare" size="15" /> Log text</button>
            <button hlmBtn variant="outline" size="sm" type="button" (click)="openLog('call')"><ng-icon name="lucidePhone" size="15" /> Log call</button>
            <button hlmBtn size="sm" type="button" (click)="draftThanks()"><ng-icon name="lucideHeartHandshake" size="15" /> Draft thank-you</button>
          </div>
        </header>

        @if (flash()) { <p class="notice" role="status">{{ flash() }} @if (flashOutreach()) { <a routerLink="/outreach">Open follow-ups</a> }</p> }

        <section class="stats" aria-label="Giving summary">
          <div class="stat"><p class="label">Lifetime, net · {{ store.currency() }}</p><p class="value">{{ money(lifetime()) }}</p></div>
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
                      <p class="meta"><span class="tag" [class.danger]="f.due_on < now" [class.warn]="f.due_on >= now"><ng-icon [name]="f.due_on < now ? 'lucideCircleAlert' : 'lucideClock'" size="12" aria-hidden="true" />{{ relativeDue(f.due_on) }}</span> {{ date(f.due_on) }} · {{ f.kind === 'quarterly' ? 'Quarterly touch' : 'Next step' }}</p>
                    </div>
                    <div class="row">
                      @if (!store.live() || f.kind !== 'quarterly') { <button class="btn small" type="button" (click)="store.setFollowUpStatus(f.id, 'done')">Mark done</button> }
                      @if (!store.live()) { <button class="btn small link" type="button" (click)="store.setFollowUpStatus(f.id, 'dismissed')">Dismiss</button> }
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

            <app-gift-entry [donorId]="d.id" />
            <app-grounded-update [donorId]="d.id" />
            <app-debrief-entry [donorId]="d.id" />

            <section class="section" aria-labelledby="tl-h">
              <div class="section-head">
                <h2 id="tl-h">Donation history · {{ store.currency() }}</h2>
              </div>
              <ol class="timeline" aria-label="Donations, newest first">
                @for (e of giftTimeline(); track e.id) {
                  <li>
                    <span class="node" [attr.data-type]="e.type" aria-hidden="true"><ng-icon [name]="icons[e.type]" size="15" /></span>
                    <div class="what">
                      <p class="when"><span class="kind-label">Gift</span> · <time [attr.datetime]="e.at">{{ date(e.at) }}</time></p>
                        <p class="strong"><span class="amount">{{ money(e.amount) }}</span> {{ e.title }}</p>
                        <p>{{ e.detail }} · via {{ e.source }} @if (e.status !== 'settled') { <span class="tag dashed">{{ e.status }}</span> }</p>
                    </div>
                  </li>
                } @empty {
                  <li class="none">No donations recorded in {{ store.currency() }}.</li>
                }
              </ol>
            </section>
            <section class="section" aria-labelledby="communications-h">
              <div class="section-head"><h2 id="communications-h">Communications log</h2><p>Recorded contacts and internal notes</p></div>
              <ol class="timeline" aria-label="Communications, newest first">
                @for (e of contactTimeline(); track e.id) {
                  <li><span class="node" [attr.data-type]="e.type" aria-hidden="true"><ng-icon [name]="icons[e.type]" size="15" /></span>
                    <div class="what"><p class="when">{{ kindLabel[e.type] }} · <time [attr.datetime]="e.at">{{ date(e.at) }}</time></p>
                      <p class="strong">{{ e.title }}</p><p class="body">{{ e.detail }}</p>
                      <p class="by">{{ e.direction === 'inbound' ? 'Received by' : 'By' }} {{ e.by }}@if (e.viaDraft) { · approved draft }</p>
                    </div>
                  </li>
                } @empty { <li class="none">No communications recorded.</li> }
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
                  @for (k of kinds(); track k) {
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
    .crumbs { font-size: 13px; margin-bottom: 14px; display: flex; align-items: center; gap: 6px; color: var(--muted-foreground); }
    .crumbs a { color: var(--muted-foreground); text-decoration: none; }
    .crumbs a:hover { color: var(--foreground); text-decoration: underline; }
    .crumbs span[aria-current] { color: var(--foreground); font-weight: 500; }
    .hero { display: flex; gap: 20px; align-items: center; padding: 22px 24px; border-radius: 24px; margin-bottom: 20px; flex-wrap: wrap; }
    .hero-avatar { width: 64px; height: 64px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 22px; font-weight: 600;
      background: linear-gradient(135deg, #dcefe3, #b9e0c8); color: var(--green-700); }
    .hero-avatar[data-kind='company'], .hero-avatar[data-kind='foundation'] { border-radius: 18px; background: linear-gradient(135deg, #eaf2fb, #cde2fb); color: #1c5cab; }
    .kind { font-size: 13px; color: var(--muted-foreground); }
    .hero h1 { font-size: 28px; margin-top: 2px; }
    .facts { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; font-size: 13px; color: var(--ink-600); }
    .facts span { display: inline-flex; align-items: center; gap: 6px; }
    .facts ng-icon { color: var(--ink-400); }
    .consent[data-consent='granted'] ng-icon { color: var(--positive); }
    .consent[data-consent='denied'] ng-icon { color: var(--danger); }
    .hero-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .value.small { font-size: 20px; }
    .strong { font-weight: 600; }
    .steps-list { padding: 4px 18px; border-radius: 18px; background: var(--glass); border: 1px solid var(--glass-edge); box-shadow: var(--glass-shadow); }
    .step { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
    .meta { font-size: 12.5px; margin-top: 4px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .none { font-size: 13px; padding: 14px 0; }
    .add-step { display: flex; gap: 10px; align-items: flex-end; margin-top: 12px; flex-wrap: wrap; }
    .add-step .grow { flex: 1; min-width: 200px; }
    .timeline { list-style: none; margin: 0; padding: 4px 0 0; position: relative; }
    .timeline::before { content: ''; position: absolute; inset-block: 8px; inset-inline-start: 17px; width: 2px; border-radius: 2px; background: rgb(15 26 21 / 0.08); }
    .timeline li { position: relative; display: flex; gap: 14px; padding: 10px 0; }
    .node { position: relative; z-index: 1; width: 36px; height: 36px; flex: none; border-radius: 12px; display: grid; place-items: center;
      background: #fff; color: var(--ink-600); box-shadow: 0 0 0 4px var(--background), 0 1px 3px rgb(15 50 30 / 0.12); }
    .node[data-type='gift'] { background: var(--green-600); color: #fff; }
    .node[data-type='text'], .node[data-type='email'] { color: #1c5cab; }
    .what { flex: 1; min-width: 0; padding: 10px 14px 12px; border-radius: 16px; background: var(--glass); border: 1px solid var(--glass-edge); box-shadow: var(--glass-shadow); }
    .when { font-size: 12px; color: var(--muted-foreground); margin-bottom: 2px; }
    .kind-label { font-weight: 600; color: var(--foreground); }
    .amount { font-size: 15px; font-weight: 700; margin-inline-end: 4px; }
    .what p { font-size: 13.5px; }
    .body { white-space: pre-line; margin-top: 2px; }
    .by { font-size: 12px; margin-top: 4px; }
    .hint { font-size: 12.5px; }
    .field-legend { font-size: 13px; font-weight: 500; margin-bottom: 6px; }
    @media (max-width: 640px) { .hero { padding: 18px; } .hero-actions { width: 100%; } }
  `,
})
export class DonorDetailPage {
  protected readonly store = inject(Store);
  private readonly router = inject(Router);
  readonly id = input.required<string>();

  protected readonly money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: this.store.currency(), minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
  protected readonly date = date;
  protected readonly relativeDue = relativeDue;
  protected readonly kindLabel = KIND_LABEL;
  protected readonly icons = KIND_ICON;
  protected readonly kinds = computed<CommunicationKind[]>(() => this.store.live() ? ['text', 'email', 'call', 'meeting'] : ['text', 'email', 'call', 'meeting', 'note']);
  protected readonly consents: Consent[] = ['unknown', 'granted', 'denied'];
  protected readonly now = today();

  protected readonly editing = signal(false);
  protected readonly flash = signal('');
  protected readonly flashOutreach = computed(() => this.flash().startsWith('Thank-you drafted'));
  protected readonly stepAction = signal('');
  protected readonly stepDue = signal(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  protected readonly logKind = signal<CommunicationKind>('text');
  protected readonly logOpen = signal(false);
  private readonly logDialog = viewChild<ElementRef<HTMLDialogElement>>('logDialog');

  protected readonly donor = computed(() => this.store.historicalDonor(this.id()));
  protected readonly gifts = computed(() => this.store.ledgerGifts().filter(g => g.donor_id === this.id()));
  protected readonly lifetime = computed(() => this.gifts().reduce((s, g) => s + this.store.netCents(g), 0));
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
    this.store.historicalContacts(this.id()).filter((c) => c.direction !== 'internal' && c.status !== 'failed').map((c) => c.occurred_at).sort().at(-1) ?? null);

  protected readonly timeline = computed<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [];
    {
      for (const g of this.gifts()) {
        const campaign = this.store.campaign(g.campaign_id);
        const program = this.store.program(campaign?.program_id ?? null);
        entries.push({
          type: 'gift', at: g.occurred_at, id: g.id, title: campaign?.title ?? 'General support',
          detail: g.refund_cents ? `Refunded ${this.money(g.refund_cents)}` : program ? `Restricted to ${program.title}` : 'Unrestricted',
          amount: g.amount_cents, status: g.status, source: SOURCE_LABEL[g.source],
        });
      }
    }
    {
      for (const c of this.store.historicalContacts(this.id())) {
        entries.push({
          type: c.kind, at: c.occurred_at, id: c.id, title: c.summary, detail: c.body,
          by: this.store.member(c.member_id)?.name ?? 'Unknown', direction: c.direction, viaDraft: !!c.draft_id,
        });
      }
    }
    return entries.sort((a, b) => b.at.localeCompare(a.at));
  });
  protected readonly giftTimeline = computed(() => this.timeline().filter(e => e.type === 'gift'));
  protected readonly contactTimeline = computed(() => this.timeline().filter(e => e.type !== 'gift'));

  protected openLog(kind?: CommunicationKind) {
    this.logKind.set(kind ?? this.donor()?.preferred_channel ?? 'text');
    this.logDialog()?.nativeElement.showModal();
  }

  protected async saveLog(event: Event) {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const summary = String(form.get('summary') ?? '').trim();
    const when = String(form.get('when') ?? this.now);
    if (!summary) return;
    if (!await this.store.logCommunication({
      donor_id: this.id(), kind: this.logKind(), summary, body: String(form.get('body') ?? '').trim(),
      occurred_at: `${when}T12:00:00-07:00`,
    })) return;
    (event.target as HTMLFormElement).reset();
    this.logDialog()?.nativeElement.close();
    this.flash.set(`${KIND_LABEL[this.logKind()]} saved to the communications log.`);
  }

  protected async addStep(event: Event) {
    event.preventDefault();
    if (!this.stepAction().trim() || !this.stepDue()) return;
    if (!await this.store.addFollowUp({ donor_id: this.id(), action: this.stepAction().trim(), due_on: this.stepDue() })) return;
    this.stepAction.set('');
  }

  protected async draftThanks() {
    const d = this.donor();
    if (!d) return;
    const template = d.preferred_channel === 'text' && d.phone ? 't-thanks-text' : 't-thanks-email';
    const last = this.store.lastGift(d.id);
    if (!await this.store.createDraft(d.id, template, last ? `${this.money(last.amount_cents)} gift on ${last.occurred_at.slice(0, 10)}` : 'Manual thank-you')) return;
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
