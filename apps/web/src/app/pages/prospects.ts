import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { Store } from '../core/store';
import { money } from '../core/format';
import { SYNTHETIC_PROSPECTS, illustrativeMatches } from './synthetic-prospects';

@Component({
  selector: 'app-prospects',
  imports: [RouterLink, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head"><div><h1>Potential donors</h1>
        <p class="lede">Explore previous giving and shared program interests.</p>
      </div></header>
      @if (!enabled()) {
        <p role="status">Potential donors are unavailable in this workspace.</p>
      } @else {
        <p>{{ store.isAdmin() ? 'All potential donors' : 'Your assigned potential donors' }}</p>
        <div class="filters">
          <label>Search potential donors<input type="search" [value]="query()" (input)="query.set($any($event.target).value)" placeholder="Name or interest" /></label>
          <label>Interest<select [value]="interest()" (change)="interest.set($any($event.target).value)">
            <option value="">All interests</option>
            @for (tag of interests(); track tag) { <option [value]="tag">{{ tag }}</option> }
          </select></label>
          <button hlmBtn variant="outline" type="button" (click)="query.set(''); interest.set('')">Clear filters</button>
        </div>
        <p role="status">{{ results().length }} potential donors</p>
        <div class="prospect-grid">
          <section aria-label="Potential donor results" class="panel">
            <ul>
              @for (prospect of results(); track prospect.id) {
                <li><a [routerLink]="[]" [queryParams]="{ prospect: prospect.id }" [attr.aria-current]="selected()?.id === prospect.id ? 'true' : null">
                  <strong>{{ prospect.name }}</strong><span>{{ prospect.kind }}</span>
                  <span>{{ prospect.interests.join(' · ') }}</span>
                </a></li>
              } @empty { <li class="empty">No potential donors match these filters.</li> }
            </ul>
          </section>
          <section class="panel detail" aria-label="Potential donor detail">
            @if (selected(); as prospect) {
              <a [routerLink]="[]" [queryParams]="{}">Close detail</a>
              <h2>{{ prospect.name }}</h2><p>{{ prospect.kind }}</p>
              <p>Assigned board member: {{ store.member(prospect.ownerId)?.name }}</p>
              <h3>Interest tags</h3><p>{{ prospect.interests.join(' · ') }}</p>
              <h3>Why this match</h3>
              <ul class="reasons">@for (reason of matches(prospect); track reason) { <li>{{ reason }}</li> }
                @empty { <li>No shared program interest found.</li> }</ul>
              <h3>Previous giving to other nonprofits</h3>
              <ul class="giving">@for (gift of prospect.giving; track $index) {
                <li><strong>{{ gift.recipient }}</strong><span>{{ gift.cause }}</span>
                  <span>{{ money(gift.amountCents) }} · <time [attr.datetime]="gift.date">{{ gift.date }}</time></span></li>
              }</ul>
            } @else {
              <h2>{{ detailId() ? 'Potential donor unavailable' : 'Explore a potential donor' }}</h2>
              <p>{{ detailId() ? 'This potential donor is unavailable in your current view.' : 'Select a potential donor to review previous giving and shared program interests.' }}</p>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: `
    :host{display:block}.page{max-width:1200px;margin:auto;padding:32px}.page-head{display:flex;align-items:start;justify-content:space-between;gap:16px}
    h1{font-size:30px;font-weight:650}h2{font-size:22px;font-weight:600;margin-top:12px}h3{font-weight:600;margin:20px 0 8px}
    .lede,li span{color:var(--ink-600)}
    .filters{display:flex;gap:16px;align-items:end;margin:20px 0;flex-wrap:wrap}
    label{display:grid;gap:6px}input,select{border:1px solid var(--border);border-radius:8px;padding:9px;background:var(--glass)}
    .prospect-grid{display:grid;grid-template-columns:minmax(230px,1fr) minmax(0,1.4fr);gap:20px;margin-top:12px}
    .panel{border:1px solid var(--border);border-radius:16px;background:var(--glass);overflow:hidden}.detail,.empty{padding:24px}
    li a{display:grid;gap:6px;padding:18px;text-decoration:none;border-bottom:1px solid var(--border)}li a:hover,li a[aria-current=true]{background:var(--accent)}
    li span{display:block;font-size:14px}.reasons{list-style:disc;padding-left:20px}.reasons li{margin:8px 0}.giving li{padding:12px 0}
    @media(max-width:700px){.page{padding:20px}.prospect-grid{grid-template-columns:1fr}.page-head{flex-wrap:wrap}}
  `,
})
export class ProspectsPage {
  protected readonly store = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly selection = toSignal(this.route.queryParamMap.pipe(map(params => ({
    id: params.get('prospect'), epoch: this.store.sessionEpoch(),
  }))), { initialValue: { id: this.route.snapshot.queryParamMap.get('prospect'), epoch: this.store.sessionEpoch() } });
  protected readonly query = linkedSignal(() => { this.store.sessionEpoch(); return ''; });
  protected readonly interest = linkedSignal(() => { this.store.sessionEpoch(); return ''; });
  protected readonly enabled = computed(() => !this.store.live() && this.store.demoMode() && this.store.signedIn());
  protected readonly visible = computed(() => this.enabled() ? SYNTHETIC_PROSPECTS.filter(p => this.store.isAdmin() || p.ownerId === this.store.me().id) : []);
  protected readonly interests = computed(() => [...new Set(this.visible().flatMap(p => p.interests))].sort());
  protected readonly results = computed(() => this.visible().filter(p =>
    (!this.interest() || p.interests.includes(this.interest())) &&
    `${p.name} ${p.interests.join(' ')}`.toLowerCase().includes(this.query().trim().toLowerCase())));
  // A URL from a previous persona must not reopen a selection when that persona returns.
  protected readonly detailId = computed(() => this.store.sessionEpoch() === this.selection().epoch ? this.selection().id : null);
  protected readonly selected = computed(() => this.visible().find(p => p.id === this.detailId()) ?? null);
  protected readonly money = money;
  protected readonly matches = illustrativeMatches;
}
