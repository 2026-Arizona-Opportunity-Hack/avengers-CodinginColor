import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Store } from '../core/store';

interface Answer { needs_clarification: boolean; explanation: string; total?: number; donors: { id: string; name: string }[] }
@Component({
  selector: 'app-ask-data', imports: [RouterLink],
  template: `<div class="page stack">
    <header class="page-head"><div><h1>Ask your data</h1><p class="lede">Find donors you can access. Ask about retention, gift status, currency or giving amounts.</p></div></header>
    <div class="row examples">@for (example of examples; track example) {
      <button class="btn" type="button" (click)="question.set(example)" [disabled]="busy()">{{ example }}</button>
    }</div>
    <form class="panel stack" (submit)="ask($event)">
      <label class="field">Your question<textarea #questionInput class="input" rows="3" maxlength="500" [value]="question()" (input)="question.set($any($event.target).value)" [disabled]="busy()" required></textarea></label>
      <p>Supported currencies: USD, EUR, GBP, CAD, AUD and JPY. Giving filters use net settled amounts; “over” is a strict threshold.</p>
      <button class="btn primary" type="submit" [disabled]="busy() || !question().trim()">{{ busy() ? 'Finding donors...' : 'Ask' }}</button>
    </form>
    @if (error()) { <p role="alert">{{ error() }}</p> }
    @if (answer(); as result) {
      <section class="panel stack" aria-labelledby="answer-title" aria-live="polite">
        <h2 id="answer-title">{{ result.needs_clarification ? 'A little more detail' : result.total + ' matching donors' }}</h2>
        <p>{{ result.explanation }}</p>
        <ul>@for (donor of result.donors; track donor.id) { <li><a [routerLink]="['/donors', donor.id]">{{ donor.name }}</a></li> }
          @empty { @if (!result.needs_clarification) { <li>No donors match those filters.</li> } }
        </ul>
      </section>
    }
  </div>`,
  styles: `.panel { padding:20px } .examples { flex-wrap:wrap } textarea { width:100% } li { margin:8px 0 }`,
})
export class AskDataPage {
  private readonly api = inject(Api);
  private readonly store = inject(Store);
  protected readonly question = signal('');
  protected readonly answer = signal<Answer | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly examples = ['Show my lapsed donors', 'Donors giving over $100 this year in USD', 'Donors with pending gifts'];
  private generation = 0;
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>('questionInput');
  constructor() {
    effect(() => {
      this.store.sessionEpoch(); this.generation++; this.question.set(''); this.answer.set(null); this.error.set(null); this.busy.set(false);
      const input = this.input(); if (input) input.nativeElement.value = '';
    });
  }
  protected async ask(event: Event) {
    event.preventDefault(); if (this.busy() || !this.question().trim()) return;
    const generation = ++this.generation, epoch = this.store.sessionEpoch();
    this.busy.set(true); this.error.set(null); this.answer.set(null);
    try {
      const answer = await this.api.request<Answer>('/api/v1/ask-data', { method: 'POST', body: JSON.stringify({ question: this.question().trim() }) });
      if (generation === this.generation && epoch === this.store.sessionEpoch() && this.store.signedIn()) this.answer.set(answer);
    } catch (error) {
      if (generation === this.generation && epoch === this.store.sessionEpoch()) this.error.set(error instanceof ApiError ? error.message : 'The search could not load. Try again.');
    } finally { if (generation === this.generation) this.busy.set(false); }
  }
}
