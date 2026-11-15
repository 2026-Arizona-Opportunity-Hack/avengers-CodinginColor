import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../core/store';
import { dateShort, money, relativeDue } from '../core/format';
import { SOURCE_LABEL, Source } from '../core/models';

type Sort = 'name' | 'lifetime' | 'recent';

@Component({
  selector: 'app-donors',
  imports: [RouterLink],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="label eyebrow">Donors</p>
          <h1>{{ store.isAdmin() ? 'All donors' : 'Your donors' }}</h1>
          <p class="lede">One record per person or organization, merged across every source. Each has exactly one board owner.</p>
        </div>
        <div class="actions">
          @if (store.isAdmin()) { <a class="btn" routerLink="/import">Import file</a> }
          <a class="btn primary" routerLink="/donors/new">Add donor</a>
        </div>
      </header>

      <form class="filters" role="search" (submit)="$event.preventDefault()">
        <label class="field grow">
          <span>Search</span>
          <input class="input" type="search" placeholder="Name, email, phone or company" [value]="q()" (input)="q.set($any($event.target).value)" />
        </label>
        @if (store.isAdmin()) {
          <label class="field">
            <span>Owner</span>
            <select class="select" (change)="ownerOverride.set($any($event.target).value)">
              <option value="" [selected]="!ownerFilter()">Everyone</option>
              @for (m of store.boardMembers(); track m.id) { <option [value]="m.id" [selected]="ownerFilter() === m.id">{{ m.name }}</option> }
              <option value="none" [selected]="ownerFilter() === 'none'">Unassigned</option>
            </select>
          </label>
        }
        <label class="field">
          <span>Source</span>
          <select class="select" (change)="sourceFilter.set($any($event.target).value)">
            <option value="">Any source</option>
            @for (s of sources; track s) { <option [value]="s">{{ sourceLabel[s] }}</option> }
          </select>
        </label>
        <label class="field">
          <span>Sort</span>
          <select class="select" (change)="sort.set($any($event.target).value)">
            <option value="name">Name A–Z</option>
            <option value="lifetime">Lifetime giving</option>
            <option value="recent">Most recent gift</option>
          </select>
        </label>
      </form>

      <p class="count" aria-live="polite"><strong>{{ rows().length }}</strong> of {{ store.donors().length }} donors</p>

      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Donors</caption>
          <thead>
            <tr>
              <th scope="col">Donor</th>
              <th scope="col">Owner</th>
              <th scope="col">Contact</th>
              <th scope="col">Sources</th>
              <th scope="col">Last gift</th>
              <th scope="col" class="num">Lifetime</th>
              <th scope="col">Next step</th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.donor.id) {
              <tr>
                <th scope="row">
                  <a [routerLink]="['/donors', r.donor.id]">{{ r.donor.name }}</a>
                  <span class="sub">{{ r.donor.kind === 'individual' ? (r.donor.company ?? 'Individual') : (r.donor.kind === 'foundation' ? 'Foundation' : 'Company') }}</span>
                </th>
                <td>{{ store.member(r.donor.owner_id)?.name ?? 'Unassigned' }}</td>
                <td class="contact">
                  <span>{{ r.donor.email ?? 'No email' }}</span>
                  <span>{{ r.donor.phone ?? 'No phone' }}</span>
                </td>
                <td><span class="row tight">@for (s of r.donor.sources; track s) {<span class="tag">{{ sourceLabel[s] }}</span>}</span></td>
                <td class="nowrap">@if (r.last) { <span class="mono">{{ money(r.last.amount_cents) }}</span> · {{ dateShort(r.last.occurred_at) }} } @else { None }</td>
                <td class="num mono">{{ money(r.lifetime) }}</td>
                <td>
                  @if (r.next) {
                    <span class="sub-strong">{{ r.next.action }}</span>
                    <span class="sub">{{ relativeDue(r.next.due_on) }}</span>
                  } @else { <span class="tag dashed">None set</span> }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="7"><div class="empty"><h3>No donors match</h3><p>Clear the search or filters.</p></div></td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: `
    .filters { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 16px; }
    .filters .field { min-width: 160px; }
    .filters .grow { flex: 1; min-width: 240px; }
    .count { font-size: 13px; margin-bottom: 8px; }
    .sub { display: block; font-weight: 400; font-size: 12.5px; margin-top: 2px; }
    .sub-strong { display: block; font-size: 13px; }
    .contact span { display: block; font-size: 12.5px; }
    .tight { gap: 4px; }
    .nowrap { white-space: nowrap; }
  `,
})
export class DonorsPage {
  protected readonly store = inject(Store);
  protected readonly money = money;
  protected readonly dateShort = dateShort;
  protected readonly relativeDue = relativeDue;
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly sources = Object.keys(SOURCE_LABEL) as Source[];

  /** Bound from ?owner= so the overview's board table links straight to a portfolio. */
  readonly owner = input<string>('');
  protected readonly q = signal('');
  protected readonly sort = signal<Sort>('name');
  protected readonly sourceFilter = signal('');
  protected readonly ownerOverride = signal<string | null>(null);
  /** A user-picked owner replaces the query-param value. */
  protected readonly ownerFilter = computed(() => this.ownerOverride() ?? this.owner() ?? '');

  protected readonly rows = computed(() => {
    const q = this.q().trim().toLowerCase();
    const owner = this.ownerFilter();
    const src = this.sourceFilter();
    const steps = this.store.followUps().filter((f) => f.status === 'open');
    return this.store.donors()
      .filter((d) => !q || [d.name, d.email, d.phone, d.company].some((v) => v?.toLowerCase().includes(q)))
      .filter((d) => !owner || (owner === 'none' ? !d.owner_id : d.owner_id === owner))
      .filter((d) => !src || d.sources.includes(src as Source))
      .map((donor) => ({
        donor,
        last: this.store.lastGift(donor.id),
        lifetime: this.store.lifetime(donor.id),
        next: steps.filter((f) => f.donor_id === donor.id).sort((a, b) => a.due_on.localeCompare(b.due_on))[0] ?? null,
      }))
      .sort((a, b) => {
        if (this.sort() === 'lifetime') return b.lifetime - a.lifetime;
        if (this.sort() === 'recent') return (b.last?.occurred_at ?? '').localeCompare(a.last?.occurred_at ?? '');
        return a.donor.name.localeCompare(b.donor.name);
      });
  });
}
