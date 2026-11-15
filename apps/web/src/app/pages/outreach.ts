import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { toast } from '@spartan-ng/brain/sonner';
import { Store } from '../core/store';
import { date, dateShort, money, quarterOf, relativeDue, today } from '../core/format';
import { Draft, FollowUp } from '../core/models';
import { OwnerDigests } from './owner-digests';

type Tab = 'approve' | 'followups' | 'quarterly' | 'history';

/**
 * Outreach inbox: a queue on the left, the one selected item on the right. Every message is
 * drafted by Coding in Color, approved by a person and sent by a person from their own email or phone.
 */
@Component({
  selector: 'app-outreach',
  imports: [RouterLink, NgIcon, HlmButtonImports, OwnerDigests],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Follow-ups and messages</h1>
          <p class="lede">Next steps, quarterly touches and thank-yous. Coding in Color drafts; a person approves and sends every message.</p>
        </div>
      </header>

      <div class="tabs" role="tablist" aria-label="Follow-ups">
        @for (t of tabs; track t.value) {
          <button type="button" role="tab" [attr.aria-selected]="tab() === t.value" (click)="setTab(t.value)">
            {{ t.label }} <span class="badge" [class.hot]="t.value === 'approve' && t.count() > 0">{{ t.count() }}</span>
          </button>
        }
      </div>

      @switch (tab()) {
        @case ('approve') {
          <div class="inbox glass">
            <ul class="queue" aria-label="Messages waiting for a person">
              @for (d of queue(); track d.id) {
                <li>
                  <button type="button" class="q-item" [attr.aria-current]="selectedDraft()?.id === d.id" (click)="pick(d.id)">
                    <span class="q-avatar" aria-hidden="true">{{ store.initials(recipient(d)) }}</span>
                    <span class="min-w-0 flex-1">
                      <span class="q-top"><span class="q-name">{{ recipient(d) }}</span><span class="q-when">{{ dateShort(d.created_at) }}</span></span>
                      <span class="q-sub">{{ d.channel === \'text\' ? \'Text: \' : \'\' }}{{ d.subject || d.body }}</span>
                      <span class="q-state" [attr.data-state]="d.status"><span class="q-dot" aria-hidden="true"></span>{{ d.status === 'approved' ? 'Approved, ready to send' : 'Needs approval' }}</span>
                    </span>
                  </button>
                </li>
              } @empty {
                <li class="q-empty"><ng-icon name="lucideCircleCheck" size="22" aria-hidden="true" /><p class="font-semibold">Inbox zero</p><p>New gifts create thank-you drafts here.</p></li>
              }
            </ul>

            <section class="pane" aria-live="polite" [attr.aria-label]="selectedDraft() ? 'Message to ' + recipient(selectedDraft()!) : 'No message selected'">
              @if (selectedDraft(); as d) {
                <ol class="trail" aria-label="Approval trail">
                  <li class="done"><span class="dot" aria-hidden="true"></span>Drafted by Coding in Color<small>{{ date(d.created_at) }}</small></li>
                  <li [class.done]="d.status === 'approved'" [class.now]="d.status === 'pending'"><span class="dot" aria-hidden="true"></span>
                    Approved by a person<small>{{ d.status === 'approved' ? store.member(d.approved_by)?.name : 'Waiting for you' }}</small></li>
                  <li [class.now]="d.status === 'approved'"><span class="dot" aria-hidden="true"></span>Sent by a person<small>From their own {{ d.channel === 'text' ? 'phone' : 'email' }}</small></li>
                </ol>

                <div class="msg-wrap">
                  <div class="msg" [attr.data-channel]="d.channel">
                    <div class="msg-meta">
                      <span><span class="k">To</span> {{ recipient(d) }} <span class="addr">{{ d.to || 'no address on file' }}</span></span>
                      <span><span class="k">Why</span> {{ d.reason }}</span>
                    </div>
                    @if (editing() === d.id) {
                      <form class="stack mt-4" (submit)="saveEdit($event, d)">
                        @if (d.channel === 'email') { <label class="field"><span>Subject</span><input class="input" name="subject" [value]="d.subject" /></label> }
                        <label class="field"><span>Message</span><textarea class="textarea" name="body" rows="10" [value]="d.body"></textarea></label>
                        <div class="row"><button hlmBtn type="submit">Save changes</button><button hlmBtn variant="ghost" type="button" (click)="editing.set(null)">Cancel</button></div>
                      </form>
                    } @else if (d.channel === 'text') {
                      <div class="sms"><p>{{ d.body }}</p></div>
                    } @else {
                      <p class="subject">{{ d.subject }}</p>
                      <p class="body">{{ d.body }}</p>
                    }
                  </div>

                  @if (d.donor_id && store.donor(d.donor_id); as donor) {
                    <aside class="ctx" aria-label="Donor context">
                      <a class="ctx-name" [routerLink]="['/donors', donor.id]">{{ donor.name }} <ng-icon name="lucideArrowUpRight" size="14" aria-hidden="true" /></a>
                      <dl>
                        <div><dt>Lifetime</dt><dd>{{ money(store.lifetime(donor.id)) }}</dd></div>
                        <div><dt>Last gift</dt><dd>{{ store.lastGift(donor.id) ? money(store.lastGift(donor.id)!.amount_cents) + ' · ' + dateShort(store.lastGift(donor.id)!.occurred_at) : 'None' }}</dd></div>
                        <div><dt>Owner</dt><dd>{{ store.member(donor.owner_id)?.name ?? 'Unassigned' }}</dd></div>
                        <div><dt>Consent</dt><dd><span class="tag" [class.solid]="donor.consent === 'granted'" [class.danger]="donor.consent === 'denied'">{{ donor.consent }}</span></dd></div>
                        <div><dt>Prefers</dt><dd>{{ donor.preferred_channel === 'text' ? 'Text' : 'Email' }}</dd></div>
                      </dl>
                    </aside>
                  }
                </div>

                <footer class="bar">
                  @if (d.status === 'pending') {
                    @if (!d.to) { <p class="hint"><ng-icon name="lucideCircleAlert" size="14" color="var(--attention)" aria-hidden="true" /> Add a {{ d.channel === 'text' ? 'phone number' : 'email' }} to the donor before approving.</p> }
                    @if (!store.live()) { <button hlmBtn variant="ghost" type="button" (click)="discard(d)">Discard</button> }
                    <button hlmBtn variant="outline" type="button" (click)="editing.set(d.id)" [disabled]="editing() === d.id">Edit</button>
                    <button hlmBtn type="button" (click)="approve(d)" [disabled]="!d.to"><ng-icon name="lucideCheck" size="16" /> Approve</button>
                  } @else {
                    <p class="hint">Open it, send it yourself, then record it. Recording adds it to the donor's timeline.</p>
                    <a hlmBtn variant="outline" [href]="store.live() ? '#' : sendLink(d)" (click)="compose($event, d)"><ng-icon [name]="d.channel === 'text' ? 'lucideMessageSquare' : 'lucideMail'" size="16" /> {{ d.channel === 'text' ? 'Open in Messages' : 'Open in email' }}</a>
                    <button hlmBtn type="button" (click)="markSent(d)"><ng-icon name="lucideSend" size="16" /> I sent it</button>
                  }
                </footer>
              } @else {
                <div class="pane-empty"><ng-icon name="lucideListChecks" size="28" aria-hidden="true" /><p>Select a message to review it.</p></div>
              }
            </section>
          </div>
        }

        @case ('followups') {
          <div class="inbox glass">
            <div class="queue">
              @for (group of groups(); track group.label) {
                <p class="q-group">{{ group.label }} <span>{{ group.items.length }}</span></p>
                <ul [attr.aria-label]="group.label">
                  @for (f of group.items; track f.id) {
                    <li>
                      <button type="button" class="q-item" [attr.aria-current]="selectedStep()?.id === f.id" (click)="pickStep(f.id)">
                        <span class="q-avatar" aria-hidden="true">{{ store.initials(store.donor(f.donor_id)?.name ?? '?') }}</span>
                        <span class="min-w-0 flex-1">
                          <span class="q-top"><span class="q-name">{{ store.donor(f.donor_id)?.name }}</span>
                            <span class="q-due" [class.late]="f.due_on < now">{{ relativeDue(f.due_on) }}</span></span>
                          <span class="q-sub">{{ f.action }}</span>
                        </span>
                      </button>
                    </li>
                  }
                </ul>
              }
            </div>
            <section class="pane" aria-live="polite">
              @if (selectedStep(); as f) {
                @if (store.donor(f.donor_id); as donor) {
                  <div class="step-head">
                    <span class="due-big" [class.late]="f.due_on < now">{{ relativeDue(f.due_on) }}</span>
                    <h2 class="text-xl">{{ f.action }}</h2>
                    <p class="text-muted-foreground text-sm">{{ f.kind === 'quarterly' ? 'Quarterly touch' : 'Next step' }} for <a [routerLink]="['/donors', donor.id]">{{ donor.name }}</a> · due {{ date(f.due_on) }}
                      @if (store.isAdmin()) { · owned by {{ store.member(f.owner_id)?.name }} }</p>
                  </div>
                  <div class="ctx wide">
                    <dl>
                      <div><dt>Lifetime</dt><dd>{{ money(store.lifetime(donor.id)) }}</dd></div>
                      <div><dt>Last gift</dt><dd>{{ store.lastGift(donor.id) ? money(store.lastGift(donor.id)!.amount_cents) + ' · ' + dateShort(store.lastGift(donor.id)!.occurred_at) : 'None' }}</dd></div>
                      <div><dt>Prefers</dt><dd>{{ donor.preferred_channel === 'text' ? 'Text' : 'Email' }}</dd></div>
                      <div><dt>Contact</dt><dd>{{ donor.email ?? donor.phone ?? 'None on file' }}</dd></div>
                    </dl>
                  </div>
                  <footer class="bar">
                    <a hlmBtn variant="ghost" [routerLink]="['/donors', donor.id]">Open donor</a>
                    @if (!store.live() || f.kind !== 'quarterly') { <button hlmBtn variant="outline" type="button" (click)="done(f)"><ng-icon name="lucideCircleCheck" size="16" /> Mark done</button> }
                    <button hlmBtn type="button" (click)="draftFor(f)"><ng-icon name="lucideMail" size="16" /> Draft a message</button>
                  </footer>
                }
              } @else {
                <div class="pane-empty"><ng-icon name="lucideCalendarClock" size="28" aria-hidden="true" /><p>No open next steps.</p></div>
              }
            </section>
          </div>
        }

        @case ('quarterly') {
          <div class="grid gap-5 lg:grid-cols-2">
            <section class="campaign glass" aria-labelledby="q-h">
              <span class="c-icon" aria-hidden="true"><ng-icon name="lucideCalendar" size="20" /></span>
              <h2 id="q-h" class="text-lg">{{ quarter }} donor update</h2>
              @if (store.live()) {
                <p class="text-sm">Generate one task per eligible donor this quarter. Draft a message from Next steps; a logged contact completes the quarterly touch.</p>
                @if (store.isAdmin()) { <button hlmBtn type="button" (click)="generateQuarterly()">Generate quarterly tasks</button> }
              } @else {
              <p class="text-muted-foreground text-sm">Every donor gets a touch each quarter: a short update and the quarterly report. One draft per donor with consent and an email, each approved by a person.</p>
              <div class="progress" role="img" [attr.aria-label]="quarterlyDrafted() + ' of ' + eligible() + ' drafted'">
                <span [style.width.%]="eligible() ? (quarterlyDrafted() / eligible()) * 100 : 0"></span></div>
              <p class="text-sm"><strong>{{ quarterlyDrafted() }}</strong> of {{ eligible() }} eligible donors drafted</p>
              <button hlmBtn class="self-start" type="button" (click)="generateQuarterly()" [disabled]="eligible() - quarterlyDrafted() <= 0">
                <ng-icon name="lucidePlus" size="16" /> Draft {{ eligible() - quarterlyDrafted() }} updates</button>
              }
            </section>
            @if (store.isAdmin() && !store.live()) {
              <section class="campaign glass" aria-labelledby="dg-h">
                <span class="c-icon" aria-hidden="true"><ng-icon name="lucideUsers" size="20" /></span>
                <h2 id="dg-h" class="text-lg">Board assignment digest</h2>
                <p class="text-muted-foreground text-sm">One email per board member listing the donors they own and how many have an open next step.</p>
                <p class="text-sm"><strong>{{ store.boardMembers().length }}</strong> board members</p>
                <button hlmBtn variant="outline" class="self-start" type="button" (click)="generateDigests()"><ng-icon name="lucideSend" size="16" /> Draft {{ store.boardMembers().length }} digests</button>
              </section>
            }
          </div>
          @if (store.live() && store.isAdmin()) { <app-owner-digests class="mt-6 block" /> }
          <h2 class="mt-8 mb-3">Templates</h2>
          <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            @for (t of visibleTemplates(); track t.id) {
              <article class="tpl glass">
                <div class="flex items-center justify-between gap-2"><h3>{{ t.name }}</h3>
                  <span class="tag"><ng-icon [name]="t.channel === 'text' ? 'lucideMessageSquare' : 'lucideMail'" size="12" aria-hidden="true" />{{ t.channel === 'text' ? 'Text' : 'Email' }}</span></div>
                @if (t.subject) { <p class="subject mt-2">{{ t.subject }}</p> }
                <p class="body small">{{ t.body }}</p>
              </article>
            }
          </div>
        }

        @case ('history') {
          <div class="inbox glass">
            <ul class="queue" aria-label="Sent messages">
              @for (d of sent(); track d.id) {
                <li>
                  <button type="button" class="q-item" [attr.aria-current]="selectedSent()?.id === d.id" (click)="pickSent(d.id)">
                    <span class="q-avatar" aria-hidden="true">{{ store.initials(recipient(d)) }}</span>
                    <span class="min-w-0 flex-1">
                  <span class="q-top"><span class="q-name">{{ recipient(d) }}</span><span class="q-when">{{ d.sent_at ? dateShort(d.sent_at!) : 'Date unavailable' }}</span></span>
                      <span class="q-sub">{{ d.channel === \'text\' ? \'Text: \' : \'\' }}{{ d.subject || d.body }}</span>
                    </span>
                  </button>
                </li>
              } @empty { <li class="q-empty"><p>No messages sent yet.</p></li> }
            </ul>
            <section class="pane" aria-live="polite">
              @if (selectedSent(); as d) {
                <ol class="trail" aria-label="Audit trail">
                  <li class="done"><span class="dot" aria-hidden="true"></span>Drafted by Coding in Color<small>{{ date(d.created_at) }}</small></li>
                  <li class="done"><span class="dot" aria-hidden="true"></span>Approved by {{ store.member(d.approved_by)?.name }}<small>{{ d.approved_at ? date(d.approved_at) : '' }}</small></li>
                  <li class="done"><span class="dot" aria-hidden="true"></span>Send recorded by {{ store.member(d.sent_by)?.name ?? 'member' }}<small>{{ d.sent_at ? date(d.sent_at!) : 'Date unavailable' }}</small></li>
                </ol>
                <div class="msg" [attr.data-channel]="d.channel">
                  <div class="msg-meta"><span><span class="k">To</span> {{ recipient(d) }} <span class="addr">{{ d.to }}</span></span></div>
                  @if (d.channel === 'text') { <div class="sms"><p>{{ d.body }}</p></div> } @else { <p class="subject">{{ d.subject }}</p><p class="body">{{ d.body }}</p> }
                </div>
              } @else {
                <div class="pane-empty"><ng-icon name="lucideHistory" size="28" aria-hidden="true" /><p>Every sent message, with who approved and who sent it.</p></div>
              }
            </section>
          </div>
        }
      }
    </div>
  `,
  styles: `
    .tabs { display: flex; gap: 20px; border-bottom: 1px solid rgb(15 26 21 / 0.08); margin-bottom: 16px; overflow-x: auto; }
    .tabs button { display: inline-flex; align-items: center; gap: 6px; height: 38px; padding: 0; border: 0; background: transparent; cursor: pointer;
      font-size: 13.5px; font-weight: 500; color: var(--ink-600); white-space: nowrap; box-shadow: inset 0 -2px 0 transparent; transition: color 120ms var(--ease-out), box-shadow 120ms var(--ease-out); }
    .tabs button:hover { color: var(--foreground); }
    .tabs button[aria-selected='true'] { color: var(--foreground); box-shadow: inset 0 -2px 0 var(--primary); }
    .badge { min-width: 18px; padding: 0 5px; border-radius: 5px; font-size: 11.5px; font-weight: 600; line-height: 18px; text-align: center; background: rgb(15 26 21 / 0.06); color: var(--ink-600); }
    .badge.hot { background: var(--green-50); color: var(--green-700); }

    .inbox { display: grid; grid-template-columns: 320px minmax(0, 1fr); border-radius: var(--r-surface); overflow: hidden; min-height: 520px; }
    .queue { list-style: none; margin: 0; padding: 6px; border-inline-end: 1px solid rgb(15 26 21 / 0.06); max-height: calc(100dvh - 230px); overflow-y: auto; }
    .queue ul { list-style: none; margin: 0; padding: 0; }
    .q-group { display: flex; justify-content: space-between; padding: 10px 10px 4px; font-size: 12px; font-weight: 500; color: var(--ink-600); }
    .q-item { width: 100%; display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; text-align: start; cursor: pointer;
      transition: background-color 100ms var(--ease-out); }
    .q-item:hover { background: rgb(15 26 21 / 0.035); }
    .q-item[aria-current='true'] { background: rgb(0 122 61 / 0.07); }
    .q-avatar { width: 26px; height: 26px; flex: none; margin-top: 1px; border-radius: 50%; display: grid; place-items: center; background: rgb(15 26 21 / 0.05); color: var(--ink-600); font-size: 10.5px; font-weight: 600; }
    .q-top { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
    .q-name { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .q-when { font-size: 12px; color: var(--ink-600); flex: none; }
    .q-due { font-size: 12px; font-weight: 500; color: var(--amber-600); flex: none; }
    .q-due.late { color: var(--red-600); }
    .q-sub { display: block; font-size: 12.5px; color: var(--ink-600); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .q-state { display: inline-flex; align-items: center; gap: 5px; margin-top: 2px; font-size: 12px; color: var(--amber-600); }
    .q-state[data-state='approved'] { color: var(--green-700); }
    .q-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .q-empty { padding: 40px 16px; text-align: center; color: var(--ink-600); display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .q-empty ng-icon { color: var(--positive); }

    .pane { display: flex; flex-direction: column; min-width: 0; padding: 20px 24px; gap: 16px; }
    .pane-empty { margin: auto; text-align: center; color: var(--ink-600); display: flex; flex-direction: column; align-items: center; gap: 8px; }
    .trail { list-style: none; margin: 0; padding: 0; display: flex; align-items: center; gap: 0; flex-wrap: wrap; font-size: 12.5px; color: var(--ink-600); }
    .trail li { display: inline-flex; align-items: center; gap: 6px; }
    .trail { flex-wrap: nowrap; overflow-x: auto; white-space: nowrap; }
    .trail li + li::before { content: ''; width: 16px; height: 1px; margin: 0 8px; background: rgb(15 26 21 / 0.15); }
    .trail small { font-size: 12px; color: var(--ink-600); }
    .trail small::before { content: '· '; }
    .trail .dot { width: 8px; height: 8px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px rgb(15 26 21 / 0.3); }
    .trail li.done { color: var(--foreground); font-weight: 500; }
    .trail li.done .dot { background: var(--primary); box-shadow: none; }
    .trail li.now { color: var(--foreground); font-weight: 600; }
    .trail li.now .dot { box-shadow: inset 0 0 0 2px var(--primary); }

    .msg-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 210px; gap: 24px; align-items: start; }
    .msg { padding: 0; }
    .msg-meta { display: flex; flex-direction: column; gap: 2px; padding-bottom: 12px; margin-bottom: 14px; border-bottom: 1px solid rgb(15 26 21 / 0.06); font-size: 13px; }
    .k { display: inline-block; width: 36px; color: var(--ink-600); }
    .addr { color: var(--ink-600); margin-inline-start: 6px; }
    .subject { font-weight: 600; font-size: 15px; margin-bottom: 8px; }
    .body { white-space: pre-line; font-size: 14px; line-height: 1.6; max-width: 66ch; }
    .body.small { font-size: 12.5px; color: var(--ink-600); margin-top: 6px; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
    .sms { display: flex; }
    .sms p { max-width: 380px; padding: 10px 14px; border-radius: 18px 18px 6px 18px; background: #2a78d6; color: #fff; font-size: 14px; line-height: 1.45; white-space: pre-line; }
    .ctx { padding: 14px; border-radius: var(--r-item); background: rgb(15 26 21 / 0.03); }
    .ctx-name { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; text-decoration: none; margin-bottom: 10px; }
    .ctx-name:hover { text-decoration: underline; }
    .ctx dl { margin: 0; display: grid; gap: 8px; }
    .ctx.wide dl { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    .ctx dt { font-size: 12px; color: var(--ink-600); }
    .ctx dd { margin: 0; font-size: 13.5px; font-weight: 500; }
    .bar { margin-top: auto; display: flex; gap: 8px; justify-content: flex-end; align-items: center; flex-wrap: wrap; padding-top: 14px; border-top: 1px solid rgb(15 26 21 / 0.06); }
    .bar .hint { margin-inline-end: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ink-600); }
    .step-head { display: flex; flex-direction: column; gap: 4px; }
    .due-big { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; color: var(--amber-600); }
    .due-big.late { color: var(--red-600); }

    .campaign { border-radius: var(--r-surface); padding: 22px; display: flex; flex-direction: column; gap: 10px; }
    .c-icon { display: none; }
    .progress { height: 6px; border-radius: 999px; background: rgb(15 26 21 / 0.07); overflow: hidden; }
    .progress span { display: block; height: 100%; background: var(--primary); border-radius: 999px; transition: width 300ms var(--ease-out); }
    .tpl { border-radius: var(--r-surface); padding: 18px; }

    @media (max-width: 1100px) { .msg-wrap { grid-template-columns: 1fr; } }
    @media (max-width: 900px) {
      .inbox { grid-template-columns: 1fr; min-height: 0; }
      .pane:has(.pane-empty) { display: none; }
      .queue { border-inline-end: 0; border-bottom: 1px solid rgb(15 26 21 / 0.06); max-height: 300px; }
      .pane { padding: 16px; }
    }
  `,
})
export class OutreachPage {
  protected readonly store = inject(Store);
  protected readonly date = date;
  protected readonly dateShort = dateShort;
  protected readonly relativeDue = relativeDue;
  protected readonly money = (cents: number) => money(cents, this.store.currency());
  protected readonly now = today();
  protected readonly quarter = quarterOf(this.now);
  protected readonly tab = signal<Tab>('approve');
  protected readonly editing = signal<string | null>(null);
  private readonly picked = signal<string | null>(null);
  private readonly pickedStep = signal<string | null>(null);
  private readonly pickedSent = signal<string | null>(null);

  protected readonly queue = computed(() => this.store.drafts()
    .filter((d) => d.status === 'pending' || d.status === 'approved')
    .sort((a, b) => (a.status === b.status ? b.created_at.localeCompare(a.created_at) : a.status === 'approved' ? -1 : 1)));
  protected readonly sent = computed(() => this.store.drafts().filter((d) => d.status === 'sent').sort((a, b) => (b.sent_at ?? '').localeCompare(a.sent_at ?? '')));
  protected readonly visibleTemplates = computed(() => this.store.live() ? [] : this.store.templates());
  private readonly open = computed(() => this.store.followUps().filter((f) => f.status === 'open').sort((a, b) => a.due_on.localeCompare(b.due_on)));

  /** The picked item if it is still in its list, otherwise the first one. */
  protected readonly selectedDraft = computed<Draft | null>(() => this.queue().find((d) => d.id === this.picked()) ?? this.queue()[0] ?? null);
  protected readonly selectedStep = computed<FollowUp | null>(() => this.open().find((f) => f.id === this.pickedStep()) ?? this.open()[0] ?? null);
  protected readonly selectedSent = computed<Draft | null>(() => this.sent().find((d) => d.id === this.pickedSent()) ?? this.sent()[0] ?? null);

  protected readonly groups = computed(() => {
    const week = new Date(Date.parse(`${this.now}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const all = this.open();
    return [
      { label: 'Overdue', items: all.filter((f) => f.due_on < this.now) },
      { label: 'Due this week', items: all.filter((f) => f.due_on >= this.now && f.due_on <= week) },
      { label: 'Later', items: all.filter((f) => f.due_on > week) },
    ].filter((g) => g.items.length);
  });

  protected readonly eligible = computed(() => this.store.donors().filter((d) => d.consent !== 'denied' && d.email).length);
  protected readonly quarterlyDrafted = computed(() =>
    new Set(this.store.drafts().filter((d) => d.template_id === 't-quarterly' && d.reason.startsWith(this.quarter)).map((d) => d.donor_id)).size);

  protected readonly tabs: Array<{ value: Tab; label: string; icon: string; count: () => number }> = [
    { value: 'approve', label: 'Approve and send', icon: 'lucideListChecks', count: () => this.queue().length },
    { value: 'followups', label: 'Next steps', icon: 'lucideCalendarClock', count: () => this.open().length },
    { value: 'quarterly', label: 'Quarterly touch', icon: 'lucideCalendar', count: () => Math.max(0, this.eligible() - this.quarterlyDrafted()) },
    { value: 'history', label: 'Send history', icon: 'lucideHistory', count: () => this.sent().length },
  ];

  protected setTab(t: Tab) { this.tab.set(t); this.editing.set(null); }
  protected pick(id: string) { this.picked.set(id); this.editing.set(null); }
  protected pickStep(id: string) { this.pickedStep.set(id); }
  protected pickSent(id: string) { this.pickedSent.set(id); }

  protected recipient(d: Draft) {
    return d.donor_id ? this.store.donor(d.donor_id)?.name ?? 'Donor' : this.store.member(d.recipient_member_id)?.name ?? 'Board member';
  }

  protected sendLink(d: Draft) {
    return d.channel === 'text'
      ? `sms:${d.to}?&body=${encodeURIComponent(d.body)}`
      : `mailto:${d.to}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
  }

  protected async saveEdit(event: Event, d: Draft) {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    if (!await this.store.editDraft(d.id, { subject: String(form.get('subject') ?? d.subject), body: String(form.get('body') ?? d.body) })) return;
    this.editing.set(null);
    toast('Draft updated', { description: 'It still needs approval.' });
  }

  protected async approve(d: Draft) {
    if (!await this.store.approveDraft(d.id)) return;
    toast.success('Approved', { description: `Now send it to ${this.recipient(d)} from your own ${d.channel === 'text' ? 'phone' : 'email'}.` });
  }

  protected discard(d: Draft) {
    this.store.discardDraft(d.id);
    toast('Draft discarded', { description: `Nothing was sent to ${this.recipient(d)}.` });
  }

  protected async compose(event: Event, d: Draft) {
    if (!this.store.live()) return;
    event.preventDefault();
    const href = await this.store.composeDraft(d.id);
    if (href) location.href = href;
  }

  protected async markSent(d: Draft) {
    if (!await this.store.markSent(d.id)) return;
    toast.success('Recorded as sent', { description: 'Added to the donor’s timeline and the send history.' });
  }

  protected async done(f: FollowUp) {
    if (!await this.store.setFollowUpStatus(f.id, 'done')) return;
    toast.success('Next step done', { description: f.action });
  }

  protected async draftFor(f: FollowUp) {
    const donor = this.store.donor(f.donor_id);
    if (!donor) return;
    const lapsed = f.action.startsWith('Re-engage');
    const template = f.kind === 'quarterly' ? 't-quarterly' : lapsed ? 't-nudge' : donor.preferred_channel === 'text' && donor.phone ? 't-thanks-text' : 't-thanks-email';
    const draft = await this.store.createDraft(donor.id, template, `Next step: ${f.action}`);
    if (!draft) return;
    this.picked.set(draft.id); this.tab.set('approve');
    toast.success(`Drafted a message to ${donor.name}`, { description: 'Review and approve it before anything is sent.' });
  }

  protected async generateQuarterly() {
    const n = await this.store.generateQuarterly('t-quarterly');
    if (n === null) return;
    if (this.store.live()) { this.tab.set('followups'); toast.success(`${n} quarterly tasks created`); return; }
    toast.success(`${n} quarterly updates drafted`, { description: 'Each one needs a person to approve it.' });
  }

  protected generateDigests() {
    const n = this.store.generateDigests();
    toast.success(`${n} board digests drafted`, { description: 'Review them under Approve and send.' });
  }
}
