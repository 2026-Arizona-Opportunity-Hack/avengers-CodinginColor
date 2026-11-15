import { Component, effect, inject, input, signal } from '@angular/core';
import { Api, ApiError, type DebriefInput } from '../core/api';
import { Store } from '../core/store';

function stamp(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value ? `${value}:00-07:00` : null;
}

@Component({
  selector: 'app-debrief-entry',
  template: `@if (store.live() && store.signedIn()) {
    <details class="panel section"><summary class="panel-head">Review meeting notes</summary>
      <div class="panel-body stack">
        <p>Notes stay in this browser until you review and save. Dates use Phoenix time. Nothing is sent to the donor.</p>
        <fieldset [disabled]="busy() || !!pending || saved()">
          <label class="field">Paste notes<textarea class="textarea" rows="4" maxlength="7000" [value]="raw()" (input)="raw.set($any($event.target).value)"></textarea></label>
          <p>Optional lines: Action: follow-up title, Due: YYYY-MM-DD, Subject: email subject, Draft: message. Dates are never guessed.</p>
          <button class="btn" type="button" (click)="propose()" [disabled]="!raw().trim()">Prepare review</button>
        </fieldset>
        @if (ready()) {
          <form (submit)="save($event)">
            <fieldset class="stack" [disabled]="busy() || !!pending || saved()" (input)="reviewed.set(false)" (change)="reviewed.set(false)">
              <label class="field">Contact note<textarea class="textarea" rows="4" maxlength="2000" [value]="note()" (input)="note.set($any($event.target).value)"></textarea></label>
              <label class="field">Contact occurred at (Phoenix)<input class="input" type="datetime-local" [value]="occurred()" (input)="occurred.set($any($event.target).value)" /></label>
              <label class="field">Next action (optional)<input class="input" maxlength="200" [value]="action()" (input)="action.set($any($event.target).value)" /></label>
              <label class="field">Action due at (Phoenix)<input class="input" type="datetime-local" [value]="due()" (input)="due.set($any($event.target).value)" /></label>
              <label class="field">Draft channel<select class="select" [value]="channel()" (change)="channel.set($any($event.target).value)"><option value="">No draft</option><option value="email">Email</option><option value="sms">Text</option></select></label>
              @if (channel()) {
                <label class="field">Subject<input class="input" maxlength="200" [value]="subject()" (input)="subject.set($any($event.target).value)" /></label>
                <label class="field">Draft message<textarea class="textarea" rows="4" maxlength="5000" [value]="body()" (input)="body.set($any($event.target).value)"></textarea></label>
              }
            </fieldset>
            <label><input type="checkbox" [checked]="reviewed()" (change)="reviewed.set($any($event.target).checked)" [disabled]="busy() || !!pending || saved()" /> I reviewed these facts and dates.</label>
            <button class="btn primary" type="submit" [disabled]="busy() || saved() || !reviewed()">{{ busy() ? 'Saving...' : pending ? 'Retry same save' : 'Save reviewed debrief' }}</button>
          </form>
        }
        @if (message()) { <p role="status">{{ message() }}</p> }
      </div>
    </details>
  }`,
})
export class DebriefEntry {
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  readonly donorId = input.required<string>();
  protected readonly raw = signal('');
  protected readonly note = signal('');
  protected readonly occurred = signal('');
  protected readonly action = signal('');
  protected readonly due = signal('');
  protected readonly channel = signal<'' | 'email' | 'sms'>('');
  protected readonly subject = signal('');
  protected readonly body = signal('');
  protected readonly ready = signal(false);
  protected readonly reviewed = signal(false);
  protected readonly busy = signal(false);
  protected readonly saved = signal(false);
  protected readonly message = signal('');
  protected pending: DebriefInput | null = null;
  private generation = 0;
  constructor() {
    effect(() => {
      this.donorId(); this.store.sessionEpoch(); this.store.signedIn(); this.generation++;
      this.clear();
    });
  }
  private clear() {
    for (const field of [this.raw, this.note, this.occurred, this.action, this.due, this.subject, this.body, this.message]) field.set('');
    this.channel.set(''); this.ready.set(false); this.reviewed.set(false); this.busy.set(false); this.saved.set(false); this.pending = null;
  }
  protected propose() {
    if (this.pending || this.busy() || this.saved()) return;
    const lines = this.raw().trim().split(/\r?\n/);
    const field = (key: string) => lines.find(line => new RegExp(`^${key}:`, 'i').test(line))?.replace(/^[^:]+:\s*/, '').trim() ?? '';
    this.note.set(lines.filter(line => !/^(Action|Due|Subject|Draft):/i.test(line)).join('\n'));
    this.action.set(field('Action')); this.due.set(/^\d{4}-\d{2}-\d{2}$/.test(field('Due')) ? `${field('Due')}T09:00` : '');
    this.subject.set(field('Subject')); this.body.set(field('Draft')); this.channel.set(field('Draft') ? 'email' : '');
    this.reviewed.set(false); this.ready.set(true); this.message.set('Review the proposal and enter the actual contact time.');
  }
  protected async save(event: Event) {
    event.preventDefault();
    if (this.busy() || this.saved() || !this.ready() || !this.reviewed() || !this.store.signedIn() || !this.store.live()) return;
    if (!this.pending) {
      const occurred = stamp(this.occurred()), due = stamp(this.due());
      if (!this.note().trim() || this.note().trim().length > 2000 || !occurred || Date.parse(occurred) > Date.now()) {
        this.message.set('Enter a contact note and a valid contact time no later than now.'); return;
      }
      if ((this.action().trim() || this.due()) && (!this.action().trim() || this.action().trim().length > 200 || !due)) {
        this.message.set('A next action needs both a title and an explicit valid due date.'); return;
      }
      if (this.channel() && (!this.body().trim() || this.body().trim().length > 5000 || this.subject().length > 200 || /[\r\n]/.test(this.subject()))) {
        this.message.set('Enter a draft message and a single-line subject.'); return;
      }
      this.pending = { request_id: crypto.randomUUID(), reviewed: true, note: this.note().trim(), occurred_at: occurred,
        ...(this.action().trim() ? { next_action: { title: this.action().trim(), due_at: due! } } : {}),
        ...(this.channel() ? { draft: { channel: this.channel() as 'email' | 'sms', subject: this.channel() === 'email' ? this.subject() : null, body: this.body().trim() } } : {}),
      };
    }
    const generation = this.generation, epoch = this.store.sessionEpoch();
    const current = () => generation === this.generation && epoch === this.store.sessionEpoch() && this.store.signedIn();
    this.busy.set(true); this.message.set('');
    try {
      await this.api.saveDebrief(this.donorId(), this.pending);
      if (!current()) return;
      this.clear(); this.ready.set(true); this.saved.set(true); this.message.set('Debrief saved. Any draft still needs approval in Follow-ups.');
      try { await this.store.refreshLive(); } catch { if (current()) this.message.set('Debrief saved. Reload to refresh the timeline.'); }
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 400) { this.pending = null; this.reviewed.set(false); }
      this.message.set(error instanceof ApiError && error.status === 400 ? 'The debrief was rejected. Correct and review the details again.' : 'Save could not be confirmed. Retry this same debrief to avoid duplicates.');
    } finally { if (current()) this.busy.set(false); }
  }
}
