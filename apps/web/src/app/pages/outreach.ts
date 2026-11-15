import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../core/store';
import { date, dateShort, money, quarterOf, relativeDue, today } from '../core/format';
import { Draft, FollowUp } from '../core/models';

type Tab = 'approve' | 'followups' | 'quarterly' | 'history';

@Component({
  selector: 'app-outreach',
  imports: [RouterLink],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="label eyebrow">Outreach</p>
          <h1>Follow-ups and messages</h1>
          <p class="lede">Cadence drafts and reminds. A person approves every message, then sends it from their own email or phone. Nothing is sent automatically.</p>
        </div>
      </header>

      <div class="segmented tabs" role="group" aria-label="Outreach sections">
        @for (t of tabs; track t.value) {
          <button type="button" [attr.aria-pressed]="tab() === t.value" (click)="tab.set(t.value)">
            {{ t.label }} <span class="mono">{{ t.count() }}</span>
          </button>
        }
      </div>

      @switch (tab()) {
        @case ('approve') {
          <section aria-labelledby="ap-h">
            <div class="section-head"><h2 id="ap-h">Waiting for a person</h2><p>Edit if needed, approve, send yourself, then record it.</p></div>
            @for (d of queue(); track d.id) {
              <article class="draft" [attr.aria-labelledby]="'dr-' + d.id">
                <header class="draft-head">
                  <div>
                    <p class="label">{{ d.channel === 'text' ? 'Text message' : 'Email' }} · {{ d.reason }}</p>
                    <h3 [id]="'dr-' + d.id">
                      @if (d.donor_id) { To <a [routerLink]="['/donors', d.donor_id]">{{ store.donor(d.donor_id)?.name }}</a> }
                      @else { To board member {{ store.member(d.recipient_member_id)?.name }} }
                      <span class="to">{{ d.to || 'no address on file' }}</span>
                    </h3>
                  </div>
                  <span class="tag" [class.solid]="d.status === 'approved'">{{ d.status === 'approved' ? 'Approved, not sent' : 'Needs approval' }}</span>
                </header>
                @if (d.status === 'pending' && editing() === d.id) {
                  <form class="stack" (submit)="saveEdit($event, d)">
                    @if (d.channel === 'email') { <label class="field"><span>Subject</span><input class="input" name="subject" [value]="d.subject" /></label> }
                    <label class="field"><span>Message</span><textarea class="textarea" name="body" rows="8" [value]="d.body"></textarea></label>
                    <div class="row"><button class="btn primary" type="submit">Save changes</button><button class="btn" type="button" (click)="editing.set(null)">Cancel</button></div>
                  </form>
                } @else {
                  @if (d.channel === 'email') { <p class="subject">{{ d.subject }}</p> }
                  <p class="body">{{ d.body }}</p>
                }
                <footer class="row actions">
                  @if (d.status === 'pending') {
                    <button class="btn primary" type="button" (click)="store.approveDraft(d.id)" [disabled]="!d.to">Approve</button>
                    <button class="btn" type="button" (click)="editing.set(d.id)">Edit</button>
                    <button class="btn link" type="button" (click)="store.discardDraft(d.id)">Discard</button>
                    @if (!d.to) { <span class="hint">Add a {{ d.channel === 'text' ? 'phone number' : 'email' }} to the donor before approving.</span> }
                  } @else {
                    <a class="btn primary" [href]="sendLink(d)">{{ d.channel === 'text' ? 'Open in Messages' : 'Open in email' }}</a>
                    <button class="btn" type="button" (click)="store.markSent(d.id)">I sent it</button>
                    <span class="hint">Approved by {{ store.member(d.approved_by)?.name }}. Recording it adds the message to the donor's timeline.</span>
                  }
                </footer>
              </article>
            } @empty {
              <div class="empty"><h3>Nothing waiting</h3><p>New gifts create thank-you drafts here. Quarterly updates are generated from the Quarterly tab.</p></div>
            }
          </section>
        }

        @case ('followups') {
          @for (group of groups(); track group.label) {
            <section class="section" [attr.aria-labelledby]="'g-' + $index">
              <div class="section-head"><h2 [id]="'g-' + $index">{{ group.label }} <span class="mono">{{ group.items.length }}</span></h2></div>
              @if (group.items.length === 0) { <p class="none">None.</p> }
              @else {
                <div class="table-wrap">
                  <table class="table">
                    <thead><tr><th scope="col">Donor</th><th scope="col">Next step</th><th scope="col">Due</th>@if (store.isAdmin()) {<th scope="col">Owner</th>}<th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      @for (f of group.items; track f.id) {
                        <tr>
                          <th scope="row"><a [routerLink]="['/donors', f.donor_id]">{{ store.donor(f.donor_id)?.name }}</a></th>
                          <td>{{ f.action }}</td>
                          <td class="nowrap"><span class="tag" [class.solid]="f.due_on < now">{{ relativeDue(f.due_on) }}</span> {{ dateShort(f.due_on) }}</td>
                          @if (store.isAdmin()) { <td>{{ store.member(f.owner_id)?.name }}</td> }
                          <td class="row-actions">
                            <button class="btn small" type="button" (click)="draftFor(f)">Draft message</button>
                            <button class="btn small" type="button" (click)="store.setFollowUpStatus(f.id, 'done')">Done</button>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            </section>
          }
          @if (flash()) { <p class="notice" role="status">{{ flash() }}</p> }
        }

        @case ('quarterly') {
          <div class="grid-2">
            <section class="panel" aria-labelledby="q-h">
              <div class="panel-head"><h2 id="q-h">{{ quarter }} donor update</h2></div>
              <div class="panel-body stack">
                <p>Every donor gets a touch each quarter: a short update and the quarterly report. Cadence drafts one email per donor with consent and an email address. Each draft still needs approval.</p>
                <dl class="kv">
                  <dt>Eligible</dt><dd>{{ eligible() }} donors</dd>
                  <dt>Already drafted</dt><dd>{{ quarterlyDrafted() }}</dd>
                  <dt>Template</dt><dd>{{ store.template('t-quarterly')?.name }}</dd>
                </dl>
                <div class="row">
                  <button class="btn primary" type="button" (click)="generateQuarterly()" [disabled]="eligible() - quarterlyDrafted() <= 0">Draft {{ eligible() - quarterlyDrafted() }} updates</button>
                </div>
              </div>
            </section>
            @if (store.isAdmin()) {
              <section class="panel" aria-labelledby="dg-h">
                <div class="panel-head"><h2 id="dg-h">Board assignment digest</h2></div>
                <div class="panel-body stack">
                  <p>Each quarter, every board member gets one email listing the donors they own and how many have an open next step.</p>
                  <dl class="kv"><dt>Recipients</dt><dd>{{ store.boardMembers().length }} board members</dd><dt>Template</dt><dd>{{ store.template('t-digest')?.name }}</dd></dl>
                  <div class="row"><button class="btn" type="button" (click)="generateDigests()">Draft {{ store.boardMembers().length }} digests</button></div>
                </div>
              </section>
            }
          </div>
          @if (flash()) { <p class="notice spaced" role="status">{{ flash() }} <button class="btn link" type="button" (click)="tab.set('approve')">Review drafts</button></p> }

          <section class="section" aria-labelledby="tpl-h">
            <div class="section-head"><h2 id="tpl-h">Templates</h2><p>Merge fields in double braces are filled from the donor record.</p></div>
            <div class="grid-2">
              @for (t of store.templates(); track t.id) {
                <article class="panel">
                  <div class="panel-head"><h3>{{ t.name }}</h3><span class="tag">{{ t.channel }}</span></div>
                  <div class="panel-body">
                    @if (t.subject) { <p class="subject">{{ t.subject }}</p> }
                    <p class="body small">{{ t.body }}</p>
                  </div>
                </article>
              }
            </div>
          </section>
        }

        @case ('history') {
          <section aria-labelledby="h-h">
            <div class="section-head"><h2 id="h-h">Send history</h2><p>Every message a person approved and sent, with who did each step.</p></div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th scope="col">Sent</th><th scope="col">To</th><th scope="col">Channel</th><th scope="col">Subject or message</th><th scope="col">Approved by</th><th scope="col">Sent by</th></tr></thead>
                <tbody>
                  @for (d of sent(); track d.id) {
                    <tr>
                      <td class="nowrap mono">{{ date(d.sent_at!) }}</td>
                      <th scope="row">@if (d.donor_id) { <a [routerLink]="['/donors', d.donor_id]">{{ store.donor(d.donor_id)?.name }}</a> } @else { {{ store.member(d.recipient_member_id)?.name }} }</th>
                      <td><span class="tag">{{ d.channel }}</span></td>
                      <td>{{ d.subject || (d.body.length > 70 ? d.body.slice(0, 70) + '…' : d.body) }}</td>
                      <td>{{ store.member(d.approved_by)?.name }}</td>
                      <td>{{ store.member(d.sent_by)?.name }}</td>
                    </tr>
                  } @empty {
                    <tr><td colspan="6"><div class="empty"><h3>No messages sent yet</h3></div></td></tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      }
    </div>
  `,
  styles: `
    .tabs { margin-bottom: 28px; }
    .tabs button { height: 34px; padding: 0 14px; font-size: 13px; }
    .tabs .mono { margin-left: 6px; }
    .draft { border: 1px solid var(--rule); border-radius: var(--radius); padding: 18px 20px; margin-bottom: 16px; }
    .draft-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 12px; }
    .draft-head h3 { font-size: 15px; margin-top: 4px; }
    .to { font-weight: 400; font-family: var(--mono); font-size: 12px; margin-left: 8px; }
    .subject { font-weight: 600; margin-bottom: 6px; }
    .body { white-space: pre-line; font-size: 13.5px; max-width: 72ch; }
    .body.small { font-size: 12.5px; }
    .actions { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--hair); }
    .hint { font-size: 12.5px; }
    .none { font-size: 13px; }
    .nowrap { white-space: nowrap; }
    .row-actions { display: flex; gap: 6px; justify-content: flex-end; white-space: nowrap; }
    .spaced { margin-top: 16px; }
  `,
})
export class OutreachPage {
  protected readonly store = inject(Store);
  protected readonly date = date;
  protected readonly dateShort = dateShort;
  protected readonly relativeDue = relativeDue;
  protected readonly now = today();
  protected readonly quarter = quarterOf(this.now);
  protected readonly tab = signal<Tab>('approve');
  protected readonly editing = signal<string | null>(null);
  protected readonly flash = signal('');

  protected readonly queue = computed(() => this.store.drafts()
    .filter((d) => d.status === 'pending' || d.status === 'approved')
    .sort((a, b) => (a.status === b.status ? b.created_at.localeCompare(a.created_at) : a.status === 'approved' ? -1 : 1)));
  protected readonly sent = computed(() => this.store.drafts().filter((d) => d.status === 'sent').sort((a, b) => b.sent_at!.localeCompare(a.sent_at!)));
  private readonly open = computed(() => this.store.followUps().filter((f) => f.status === 'open').sort((a, b) => a.due_on.localeCompare(b.due_on)));

  protected readonly groups = computed(() => {
    const week = new Date(Date.parse(`${this.now}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const all = this.open();
    return [
      { label: 'Overdue', items: all.filter((f) => f.due_on < this.now) },
      { label: 'Due this week', items: all.filter((f) => f.due_on >= this.now && f.due_on <= week) },
      { label: 'Later', items: all.filter((f) => f.due_on > week) },
    ];
  });

  protected readonly eligible = computed(() => this.store.donors().filter((d) => d.consent !== 'denied' && d.email).length);
  protected readonly quarterlyDrafted = computed(() =>
    new Set(this.store.drafts().filter((d) => d.template_id === 't-quarterly' && d.reason.startsWith(this.quarter)).map((d) => d.donor_id)).size);

  protected readonly tabs: Array<{ value: Tab; label: string; count: () => number }> = [
    { value: 'approve', label: 'Approve and send', count: () => this.queue().length },
    { value: 'followups', label: 'Next steps', count: () => this.open().length },
    { value: 'quarterly', label: 'Quarterly touch', count: () => Math.max(0, this.eligible() - this.quarterlyDrafted()) },
    { value: 'history', label: 'Send history', count: () => this.sent().length },
  ];

  protected sendLink(d: Draft) {
    return d.channel === 'text'
      ? `sms:${d.to}?&body=${encodeURIComponent(d.body)}`
      : `mailto:${d.to}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
  }

  protected saveEdit(event: Event, d: Draft) {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    this.store.editDraft(d.id, { subject: String(form.get('subject') ?? d.subject), body: String(form.get('body') ?? d.body) });
    this.editing.set(null);
  }

  protected draftFor(f: FollowUp) {
    const donor = this.store.donor(f.donor_id);
    if (!donor) return;
    const lapsed = f.action.startsWith('Re-engage');
    const template = lapsed ? 't-nudge' : donor.preferred_channel === 'text' && donor.phone ? 't-thanks-text' : 't-thanks-email';
    this.store.createDraft(donor.id, template, `Next step: ${f.action}`);
    this.flash.set(`Drafted a message to ${donor.name}. It is waiting under Approve and send.`);
  }

  protected generateQuarterly() {
    const n = this.store.generateQuarterly('t-quarterly');
    this.flash.set(`${n} quarterly updates drafted. Each one needs approval before it is sent.`);
  }

  protected generateDigests() {
    const n = this.store.generateDigests();
    this.flash.set(`${n} board digests drafted.`);
  }

  protected readonly money = money;
}
