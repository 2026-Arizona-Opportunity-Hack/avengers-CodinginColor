import { Component, DestroyRef, ElementRef, effect, inject, input, signal, viewChild } from '@angular/core';
import { Store } from '../core/store';
import { proposeDebrief, validDay, type DebriefSubmission } from '../core/debrief';

@Component({
  selector: 'app-debrief',
  template: `
    <details class="panel section">
      <summary class="panel-head cursor-pointer">Paste meeting notes</summary>
      <div class="panel-body stack">
        <p>Paste a meeting note or transcript, then review the proposed records. Notes stay in this browser until you save the reviewed contact note.</p>
        @if (message()) { <p role="status">{{ message() }}</p> }
        <label class="field"><span>Meeting notes</span><textarea #raw rows="5" maxlength="10000" [disabled]="busy() || !!pending()" [value]="transcript()" (input)="transcript.set(raw.value)" placeholder="Discussed a class visit.&#10;Next: Arrange a visit&#10;Due: 2026-12-01"></textarea></label>
        <button class="btn" type="button" [disabled]="busy() || !!pending()" (click)="propose()">Review proposal</button>
        @if (proposal(); as p) {
          <form (submit)="save($event)" novalidate>
            <fieldset class="stack" [disabled]="busy() || !!pending()">
              <label class="field"><span>Contact note to save</span><textarea name="note" rows="4" maxlength="2000" [value]="p.note" required></textarea></label>
              <label class="field"><span>Conversation time (Arizona)</span><input type="datetime-local" name="at" [value]="contactTime" required /></label>
              <label><input #task type="checkbox" name="task" [checked]="!!p.action" /> Save a next action</label>
              <label class="field"><span>Next action</span><input name="action" maxlength="200" [value]="p.action" /></label>
              <label class="field"><span>Due date (Arizona)</span><input type="date" name="due" [value]="p.due" /></label>
              <p>Only explicit YYYY-MM-DD dates are proposed. Confirm the date if your notes use relative wording.</p>
              <label><input type="checkbox" name="draft" /> Save an editable email draft</label>
              <label class="field"><span>Draft subject</span><input name="subject" maxlength="200" [value]="p.subject" /></label>
              <label class="field"><span>Draft body</span><textarea name="body" rows="4" maxlength="5000" [value]="p.body"></textarea></label>
              <label><input type="checkbox" name="reviewed" required /> This meeting happened. I reviewed the contact note, dates, action and optional draft. Logging it may complete this quarter's touch.</label>
            </fieldset>
            <button class="btn mt-3" type="submit" [disabled]="busy()">{{ pending() ? 'Retry the same save' : 'Save reviewed records' }}</button>
          </form>
        }
      </div>
    </details>
  `,
})
export class Debrief {
  readonly donorId = input.required<string>();
  private readonly store = inject(Store);
  protected readonly transcript = signal('');
  protected readonly proposal = signal<ReturnType<typeof proposeDebrief> | null>(null);
  protected readonly pending = signal<DebriefSubmission | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected contactTime = '';
  private generation = 0;
  private readonly rawInput = viewChild<ElementRef<HTMLTextAreaElement>>('raw');
  constructor() {
    effect(() => { this.donorId(); this.store.sessionEpoch(); this.reset(); });
    inject(DestroyRef).onDestroy(() => this.reset());
  }
  private reset() {
    if (this.rawInput()) this.rawInput()!.nativeElement.value = '';
    this.generation++; this.transcript.set(''); this.proposal.set(null); this.pending.set(null); this.busy.set(false); this.message.set('');
  }
  protected propose() {
    if (!this.transcript().trim()) { this.message.set('Paste a note first.'); return; }
    this.proposal.set(proposeDebrief(this.transcript())); this.message.set('Review and edit every proposed record before saving.');
    this.contactTime = new Date(Date.now() - 7 * 3600_000 - 60_000).toISOString().slice(0, 16);
  }
  protected async save(event: Event) {
    event.preventDefault(); if (this.busy()) return;
    const form = new FormData(event.target as HTMLFormElement), value = (name: string) => String(form.get(name) ?? '').trim();
    if (!this.pending()) {
      const at = value('at'), note = value('note'), due = value('due');
      if (!form.has('reviewed') || !note || note.length > 2000 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)
        || !validDay(at.slice(0, 10)) || Date.parse(`${at}:00-07:00`) > Date.now()
        || (form.has('task') && (!value('action') || value('action').length > 200 || !validDay(due)))
        || (form.has('draft') && (!value('body') || value('body').length > 5000 || /[\r\n]/.test(value('subject'))))) {
        this.message.set('Review the note and real dates, and complete each selected action or draft.'); return;
      }
      this.pending.set({ request_id: crypto.randomUUID(), reviewed: true, note, occurred_at: `${at}:00-07:00`,
        ...(form.has('task') ? { next_action: { title: value('action'), due_at: `${due}T12:00:00-07:00` } } : {}),
        ...(form.has('draft') ? { draft: { channel: 'email' as const, subject: value('subject'), body: value('body') } } : {}) });
    }
    const generation = this.generation, epoch = this.store.sessionEpoch(), donor = this.donorId(); this.busy.set(true);
    const result = await this.store.saveDebrief(donor, this.pending()!);
    if (generation !== this.generation || epoch !== this.store.sessionEpoch() || donor !== this.donorId()) return;
    this.busy.set(false);
    if (result === 'saved') { this.reset(); this.message.set('Contact note and selected records saved. Any draft still needs approval and a human send.'); }
    else {
      if (result === 'invalid') this.pending.set(null);
      this.message.set(result === 'invalid' ? 'The server rejected the proposal. Correct it and review again.' : 'Save could not be confirmed. Retry the same reviewed records.');
    }
  }
}
