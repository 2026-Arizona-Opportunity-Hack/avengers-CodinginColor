import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Store } from '../core/store';
import { today } from '../core/format';

interface Proposal { subject: string; body: string; context_hash: string; facts: Array<{ id: string; text: string }> }
@Component({
  selector: 'app-grounded-update',
  imports: [RouterLink],
  template: `@if (store.live()) {
    <details class="panel update no-print"><summary>Draft a program update</summary>
      <p>Use recorded gifts and approved program results, then review the message before saving it.</p>
      <div class="filters">
        <label class="field">Program<select class="select" [value]="selectedProgram()" (change)="program.set($any($event.target).value)" [disabled]="busy()">
          @for (p of store.programs(); track p.id) { <option [value]="p.id">{{ p.title }}</option> }</select></label>
        <label class="field">From<input class="input" type="date" [value]="from()" (input)="from.set($any($event.target).value)" [disabled]="busy()" /></label>
        <label class="field">Through<input class="input" type="date" [value]="through()" (input)="through.set($any($event.target).value)" [disabled]="busy()" /></label>
      </div>
      <button class="btn" type="button" (click)="propose()" [disabled]="busy() || !query()">Suggest update</button>
      @if (proposal(); as p) {
        <details><summary>Review source facts</summary><ul>@for (fact of p.facts; track fact.id) { <li>{{ fact.text }}</li> } @empty { <li>No reported program results or recorded program gifts are available for this period.</li> }</ul></details>
        <label class="field">Subject<input class="input" maxlength="200" [value]="subject()" (input)="subject.set($any($event.target).value)" [disabled]="busy() || saved()" /></label>
        <label class="field">Message<textarea class="textarea" rows="10" maxlength="5000" [value]="body()" (input)="body.set($any($event.target).value)" [disabled]="busy() || saved()"></textarea></label>
        <button class="btn primary" type="button" (click)="save()" [disabled]="busy() || saved() || !subject().trim() || !body().trim()">Save draft for approval</button>
      }
      @if (error()) { <p role="alert">{{ error() }}</p> }
      @if (saved()) { <p role="status">Draft saved. <a routerLink="/outreach">Review, approve and send in Follow-ups.</a></p> }
    </details>
  }`,
  styles: `.update { padding:18px; margin:16px 0 } summary { font-weight:600; cursor:pointer } p,.field,details { margin:12px 0 } .filters { display:flex; flex-wrap:wrap; gap:12px } .filters .field { flex:1; min-width:150px } textarea { width:100% }`,
})
export class GroundedUpdate {
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  readonly donorId = input.required<string>();
  protected readonly program = signal('');
  protected readonly selectedProgram = computed(() => this.program() || this.store.programs()[0]?.id || '');
  protected readonly from = signal(`${today().slice(0,4)}-01-01`);
  protected readonly through = signal(today());
  protected readonly proposal = signal<Proposal | null>(null);
  protected readonly subject = signal('');
  protected readonly body = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly saved = signal(false);
  protected readonly query = computed(() => {
    try {
      const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T12:00:00Z`).toISOString().slice(0,10) === s;
      if (!this.selectedProgram() || !valid(this.from()) || !valid(this.through()) || this.from() > this.through()) return null;
      const end = new Date(`${this.through()}T12:00:00Z`); end.setUTCDate(end.getUTCDate()+1);
      return { donor_id:this.donorId(),program_id:this.selectedProgram(),from:this.from(),to:end.toISOString().slice(0,10) };
    } catch { return null; }
  });
  private generation = 0;
  constructor() {
    effect(() => {
      this.donorId(); this.selectedProgram(); this.from(); this.through(); this.store.sessionEpoch(); this.generation++;
      this.proposal.set(null); this.subject.set(''); this.body.set(''); this.saved.set(false); this.error.set(null); this.busy.set(false);
    });
  }
  protected async propose() {
    const query = this.query(), epoch = this.store.sessionEpoch(), generation = this.generation;
    if (!query || this.busy() || !this.store.signedIn()) return;
    this.busy.set(true); this.error.set(null); this.saved.set(false);
    try {
      const proposal = await this.api.request<Proposal>('/api/v1/drafts/grounded/propose',{method:'POST',body:JSON.stringify(query)});
      if (epoch !== this.store.sessionEpoch() || generation !== this.generation || !this.store.signedIn()) return;
      this.proposal.set(proposal); this.subject.set(proposal.subject); this.body.set(proposal.body);
    } catch (e) { if (generation === this.generation && epoch === this.store.sessionEpoch()) this.error.set(this.message(e)); }
    finally { if (generation === this.generation) this.busy.set(false); }
  }
  protected async save() {
    const query = this.query(), proposal = this.proposal(), epoch = this.store.sessionEpoch(), generation = this.generation;
    if (!query || !proposal || this.busy() || this.saved() || !this.store.signedIn()) return;
    this.busy.set(true); this.error.set(null);
    try {
      await this.api.request('/api/v1/drafts/grounded',{method:'POST',body:JSON.stringify({...query,context_hash:proposal.context_hash,subject:this.subject(),body:this.body()})});
      if (epoch !== this.store.sessionEpoch() || generation !== this.generation || !this.store.signedIn()) return;
      this.saved.set(true); await this.store.refreshLive();
    } catch (e) { if (generation === this.generation && epoch === this.store.sessionEpoch()) this.error.set(this.message(e)); }
    finally { if (generation === this.generation) this.busy.set(false); }
  }
  private message(e: unknown) { return e instanceof ApiError ? e.message : 'The update could not be saved. Try again.'; }
}
