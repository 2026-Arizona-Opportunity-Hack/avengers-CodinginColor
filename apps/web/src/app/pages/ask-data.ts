import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowRight, lucideMessageSquare, lucideSend } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { Api, ApiError } from '../core/api';
import { Store } from '../core/store';
import { today } from '../core/format';
import { interpretQuestion, searchDonors, clarify } from '../../../../../packages/reporting/donor-search';

interface Answer { needs_clarification: boolean; explanation: string; total?: number; donors: { id: string; name: string }[] }
@Component({
  selector: 'app-ask-data', imports: [RouterLink, NgIcon, HlmButtonImports],
  providers: [provideIcons({ lucideArrowRight, lucideMessageSquare, lucideSend })],
  template: `<div class="page ask-page" [class.has-question]="submittedQuestion()">
    <header class="welcome">
      <span class="ask-mark"><ng-icon name="lucideMessageSquare" size="24" aria-hidden="true" /></span>
      <h1>Ask your data</h1>
      <p>Which donor relationships will you explore today?</p>
    </header>
    <div class="response" [attr.aria-busy]="busy()">
    @if (submittedQuestion()) {
      <div class="question-bubble"><span class="sr-only">Your question: </span>{{ submittedQuestion() }}</div>
    }
    <p class="search-status" role="status">{{ busy() ? 'Finding donors…' : '' }}</p>
    @if (error()) { <p role="alert">{{ error() }}</p> }
    @if (answer(); as result) {
      <section class="answer stack" aria-labelledby="answer-title" aria-live="polite">
        <h2 id="answer-title">{{ result.needs_clarification ? 'A little more detail' : result.total + ' matching donors' }}</h2>
        <p class="explanation">{{ result.explanation }}</p>
        <ul class="donor-results">@for (donor of result.donors; track donor.id) { <li><a [routerLink]="['/donors', donor.id]"><span>{{ donor.name }}</span><ng-icon name="lucideArrowRight" size="16" aria-hidden="true" /></a></li> }
          @empty { @if (!result.needs_clarification) { <li>No donors match those filters.</li> } }
        </ul>
      </section>
    }
    </div>
    <div class="compose-area">
      <form class="composer" (submit)="ask($event)">
        <label class="sr-only" for="ask-question">Your question</label>
        <textarea #questionInput id="ask-question" rows="3" maxlength="500" placeholder="Ask about your donors…" aria-describedby="ask-help ask-keyboard" [value]="question()" (input)="question.set($any($event.target).value)" (keydown)="onKeydown($event)" [readOnly]="busy()" required></textarea>
        <div class="composer-tools"><span id="ask-keyboard">Enter to ask · Shift + Enter for a new line</span>
          <button hlmBtn class="send" size="icon" type="submit" [disabled]="busy() || !question().trim()" [attr.aria-label]="busy() ? 'Finding donors' : 'Ask your data'"><ng-icon name="lucideSend" size="18" aria-hidden="true" /></button>
        </div>
      </form>
      @if (!submittedQuestion()) {
        <div class="examples" aria-label="Suggested questions">@for (example of examples; track example) {
          <button hlmBtn variant="outline" class="prompt" type="button" (click)="useExample(example)" [disabled]="busy()">{{ example }}</button>
        }</div>
      }
      <p id="ask-help" class="help">Search retention, gift status or giving amounts. USD, EUR, GBP, CAD, AUD and JPY supported. “Over” uses a strict net settled giving threshold.</p>
    </div>
  </div>`,
  styles: `
    :host { display:block; }
    .ask-page { max-width:800px; margin-inline:auto; min-height:calc(100dvh - var(--topbar-h) - 64px); display:flex; flex-direction:column; justify-content:center; gap:28px; }
    .welcome { text-align:center; }
    .ask-mark { display:inline-grid; place-items:center; width:52px; height:52px; border-radius:var(--r-surface); background:var(--accent); color:var(--primary); margin-bottom:18px; }
    h1 { font-size:clamp(28px, 4vw, 36px); letter-spacing:-.035em; line-height:1.2; }
    .welcome p { color:var(--muted-foreground); margin-top:12px; font-size:16px; }
    .response:empty, .search-status:empty { display:none; }
    .response { display:flex; flex-direction:column; gap:24px; }
    .question-bubble { align-self:flex-end; max-width:90%; padding:14px 20px; border-radius:var(--r-overlay) var(--r-overlay) 4px var(--r-overlay); background:var(--accent); white-space:pre-wrap; overflow-wrap:anywhere; }
    .answer h2 { font-size:20px; letter-spacing:-.02em; }
    .explanation { color:var(--muted-foreground); line-height:1.75; }
    .donor-results { list-style:none; padding:0; margin:0; }
    .donor-results a { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:14px 4px; border-bottom:1px solid var(--border); color:var(--primary); text-decoration:none; }
    .donor-results a:hover { background:var(--accent); }
    .compose-area { width:100%; }
    .composer { padding:18px; border-radius:24px; background:var(--glass-strong); box-shadow:var(--glass-shadow); border:1px solid var(--input); }
    .composer:focus-within { outline:2px solid var(--ring); outline-offset:3px; }
    textarea { display:block; width:100%; min-height:90px; max-height:280px; resize:vertical; border:0; background:transparent; color:var(--foreground); font:inherit; font-size:16px; line-height:1.6; outline:none; }
    textarea::placeholder { color:var(--muted-foreground); }
    .composer-tools { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; }
    .composer-tools span, .help { color:var(--muted-foreground); font-size:var(--t-meta); }
    .send { border-radius:var(--r-item); flex-shrink:0; }
    .examples { display:flex; justify-content:center; flex-wrap:wrap; gap:8px; margin-top:20px; }
    .prompt { white-space:normal; height:auto; min-height:40px; text-align:left; border-radius:var(--r-item); font-size:var(--t-meta); }
    .help { text-align:center; margin:16px auto 0; max-width:65ch; line-height:1.6; }
    .has-question { justify-content:flex-start; }
    .has-question .welcome { text-align:left; }
    .has-question .welcome h1 { font-size:var(--t-page); }
    .has-question .welcome .ask-mark, .has-question .welcome p { display:none; }
    .has-question .compose-area { position:sticky; bottom:12px; margin-top:auto; padding-top:16px; background:linear-gradient(transparent, var(--background) 20%); }
    @media (max-width:600px) {
      .ask-page { min-height:calc(100dvh - var(--topbar-h) - 40px); gap:20px; }
      .composer { padding:14px; border-radius:var(--r-overlay); }
      .composer-tools span { max-width:24ch; font-size:12px; }
      .examples { flex-direction:column; }
      .has-question .compose-area { bottom:0; }
    }
  `,
})
export class AskDataPage {
  private readonly api = inject(Api);
  protected readonly store = inject(Store);
  protected readonly question = signal('');
  protected readonly submittedQuestion = signal('');
  protected readonly answer = signal<Answer | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly examples = ['Show my lapsed donors', 'Donors giving over $100 this year in USD', 'Donors with pending gifts'];
  private generation = 0;
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>('questionInput');
  constructor() {
    effect(() => {
      this.store.sessionEpoch(); this.generation++; this.question.set(''); this.submittedQuestion.set(''); this.answer.set(null); this.error.set(null); this.busy.set(false);
      const input = this.input(); if (input) input.nativeElement.value = '';
    });
  }
  protected useExample(example: string) {
    this.question.set(example); this.input()?.nativeElement.focus();
  }
  protected onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); void this.ask(event);
    }
  }
  protected async ask(event: Event) {
    event.preventDefault(); if (this.busy() || !this.question().trim()) return;
    const generation = ++this.generation, epoch = this.store.sessionEpoch();
    this.submittedQuestion.set(this.question().trim());
    this.busy.set(true); this.error.set(null); this.answer.set(null);
    try {
      const question = this.question().trim(), live = this.store.live();
      const filters = live ? null : interpretQuestion(question);
      const answer = live
        ? await this.api.request<Answer>('/api/v1/ask-data', { method: 'POST', body: JSON.stringify({ question }) })
        : filters ? searchDonors(filters, this.store.donors(), this.store.allGifts(), this.store.me().id, today()) : clarify;
      if (generation === this.generation && epoch === this.store.sessionEpoch() && this.store.signedIn()) this.answer.set(answer);
    } catch (error) {
      if (generation === this.generation && epoch === this.store.sessionEpoch()) this.error.set(error instanceof ApiError ? error.message : 'The search could not load. Try again.');
    } finally { if (generation === this.generation) { this.busy.set(false); this.input()?.nativeElement.focus(); } }
  }
}
