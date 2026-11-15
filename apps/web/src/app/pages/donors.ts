import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { Store } from '../core/store';
import { dateShort, money, relativeDue, today } from '../core/format';
import { SOURCE_LABEL, Source } from '../core/models';

type Sort = 'name' | 'lifetime' | 'recent';

@Component({
  selector: 'app-donors',
  imports: [RouterLink, NgIcon, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>{{ store.isAdmin() ? 'Donors' : 'Your donors' }}</h1>
          <p class="lede">One record per donor, merged across every source.</p>
        </div>
        <div class="actions">
          @if (store.isAdmin()) { <a hlmBtn variant="outline" routerLink="/import"><ng-icon name="lucideUpload" size="16" /> Import file</a> }
          @if (!store.live()) { <a hlmBtn routerLink="/donors/new"><ng-icon name="lucideUserPlus" size="16" /> Add donor</a> }
        </div>
      </header>

      <section class="summary" aria-label="Summary">
        <div class="chip glass"><ng-icon name="lucideUsers" size="16" aria-hidden="true" /><span><strong>{{ store.donors().length }}</strong> donors</span></div>
        <div class="chip glass"><ng-icon name="lucideHandCoins" size="16" aria-hidden="true" /><span><strong>{{ money(totalLifetime()) }}</strong> lifetime giving</span></div>
        <div class="chip glass"><ng-icon name="lucideCalendarClock" size="16" aria-hidden="true" /><span><strong>{{ withoutStep() }}</strong> without a next step</span></div>
      </section>

      <form class="toolbar glass" role="search" (submit)="$event.preventDefault()">
        <label class="search">
          <span class="sr-only">Search donors</span>
          <ng-icon name="lucideSearch" size="16" aria-hidden="true" />
          <input type="search" placeholder="Search name, email, phone or company" [value]="q()" (input)="q.set($any($event.target).value)" />
        </label>
        @if (store.isAdmin()) {
          <label class="pick"><span class="sr-only">Owner</span>
            <select class="select" (change)="ownerOverride.set($any($event.target).value)">
              <option value="" [selected]="!ownerFilter()">All owners</option>
              @for (m of store.boardMembers(); track m.id) { <option [value]="m.id" [selected]="ownerFilter() === m.id">{{ m.name }}</option> }
              <option value="none" [selected]="ownerFilter() === 'none'">Unassigned</option>
            </select>
          </label>
        }
        <label class="pick"><span class="sr-only">Source</span>
          <select class="select" (change)="sourceFilter.set($any($event.target).value)">
            <option value="">All sources</option>
            @for (s of sources; track s) { <option [value]="s">{{ sourceLabel[s] }}</option> }
          </select>
        </label>
        <label class="pick"><span class="sr-only">Sort</span>
          <select class="select" (change)="sort.set($any($event.target).value)">
            <option value="name">Sort: Name A–Z</option>
            <option value="lifetime">Sort: Lifetime giving</option>
            <option value="recent">Sort: Most recent gift</option>
          </select>
        </label>
      </form>

      <p class="count" aria-live="polite">Showing <strong>{{ rows().length }}</strong> of {{ store.donors().length }}</p>

      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Donors</caption>
          <colgroup>
            <col style="width: 21%" />@if (store.isAdmin()) { <col style="width: 13%" /> }<col style="width: 19%" /><col style="width: 11%" /><col style="width: 11%" /><col style="width: 8%" /><col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Donor</th>
              @if (store.isAdmin()) { <th scope="col">Owner</th> }
              <th scope="col">Contact</th>
              <th scope="col">Sources</th>
              <th scope="col">Last gift</th>
              <th scope="col" class="num">Lifetime</th>
              <th scope="col">Next step</th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.donor.id) {
              <tr class="clickable" (click)="open($event, r.donor.id)">
                <th scope="row">
                  <div class="who">
                    <span class="avatar" [attr.data-kind]="r.donor.kind" aria-hidden="true">
                      @if (r.donor.kind === 'individual') { {{ store.initials(r.donor.name) }} } @else { <ng-icon name="lucideBuilding2" size="15" /> }
                    </span>
                    <span class="min-w-0">
                      <a [routerLink]="['/donors', r.donor.id]">{{ r.donor.name }}</a>
                      <span class="sub">{{ r.donor.kind === 'individual' ? (r.donor.company ?? 'Individual') : (r.donor.kind === 'foundation' ? 'Foundation' : 'Company') }}</span>
                    </span>
                  </div>
                </th>
                @if (store.isAdmin()) {
                  <td class="nowrap">
                    @if (store.member(r.donor.owner_id); as m) {
                      <span class="owner"><span class="mini" aria-hidden="true">{{ store.initials(m.name) }}</span>{{ m.name }}</span>
                    } @else { <span class="tag dashed">Unassigned</span> }
                  </td>
                }
                <td class="contact">
                  @if (r.donor.email) { <a [href]="'mailto:' + r.donor.email">{{ r.donor.email }}</a> } @else { <span class="none">No email</span> }
                  @if (r.donor.phone) { <a [href]="'sms:' + r.donor.phone" [attr.aria-label]="'Text ' + r.donor.name + ' at ' + r.donor.phone">{{ r.donor.phone }}</a> } @else { <span class="none">No phone</span> }
                </td>
                <td><span class="row tight">@for (s of r.donor.sources; track s) {<span class="tag">{{ sourceLabel[s] }}</span>}</span></td>
                <td class="nowrap">@if (r.last) { <span class="font-semibold">{{ money(r.last.amount_cents) }}</span> <span class="sub inline">{{ dateShort(r.last.occurred_at) }}</span> } @else { <span class="sub inline">None</span> }</td>
                <td class="num font-semibold">{{ money(r.lifetime) }}</td>
                <td class="step">
                  @if (r.next) {
                    <span class="sub-strong">{{ r.next.action }}</span>
                    <span class="due" [class.late]="r.next.due_on < now">
                      <ng-icon [name]="r.next.due_on < now ? 'lucideCircleAlert' : 'lucideClock'" size="13" aria-hidden="true" />{{ relativeDue(r.next.due_on) }}</span>
                  } @else { <span class="tag dashed">No next step</span> }
                </td>
              </tr>
            } @empty {
              <tr><td [attr.colspan]="store.isAdmin() ? 7 : 6"><div class="empty"><h3>No donors match</h3><p>Clear the search or filters.</p></div></td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: `
    .summary { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
    .chip { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border-radius: 999px; font-size: 13.5px; color: var(--ink-600); }
    .chip ng-icon { color: var(--primary); }
    .chip strong { color: var(--foreground); font-weight: 600; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px; border-radius: 18px; margin-bottom: 12px; }
    .search { flex: 1; min-width: 240px; display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 14px;
      border-radius: 12px; background: rgb(255 255 255 / 0.8); border: 1px solid var(--border); color: var(--muted-foreground); }
    .search:focus-within { border-color: var(--primary); box-shadow: 0 0 0 4px rgb(0 122 61 / 0.14); }
    .search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--foreground); font-size: 14px; }
    .pick .select { min-width: 170px; height: 40px; border-radius: 12px; }
    .count { font-size: 13px; margin: 0 4px 8px; color: var(--muted-foreground); }
    table { table-layout: fixed; }
    td, th { overflow-wrap: anywhere; }
    .contact a, .contact .none { font-weight: 400 !important; }
    tr.clickable { cursor: pointer; }
    tr.clickable:hover th a { text-decoration: underline; }
    .who { display: flex; align-items: center; gap: 12px; }
    .avatar { width: 34px; height: 34px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 600;
      background: var(--green-50); color: var(--green-700); }
    .avatar[data-kind='company'], .avatar[data-kind='foundation'] { border-radius: 10px; background: #eaf2fb; color: #1c5cab; }
    .sub { display: block; font-weight: 400; font-size: 12.5px; color: var(--muted-foreground); margin-top: 1px; }
    .sub.inline { display: inline; margin-inline-start: 4px; }
    .sub-strong { display: block; font-size: 13px; }
    .owner { display: inline-flex; align-items: center; gap: 8px; font-size: 13.5px; white-space: normal; }
    .mini { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; font-weight: 600; background: rgb(15 26 21 / 0.06); color: var(--ink-600); }
    .contact a, .contact .none { display: block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--ink-600); text-decoration: none; }
    .contact a:hover { color: var(--green-700); text-decoration: underline; }
    .icon-link { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; color: var(--ink-600);
      background: rgb(255 255 255 / 0.7); border: 1px solid var(--border); transition: background-color 150ms var(--ease), color 150ms var(--ease); }
    .icon-link:hover { background: #fff; color: var(--primary); }
    .who a { white-space: nowrap; }
    .step .sub-strong { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .tight { gap: 4px; }
    .nowrap { white-space: nowrap; }

    .due { display: inline-flex; align-items: center; gap: 4px; margin-top: 3px; font-size: 12px; font-weight: 500; color: var(--amber-600); }
    .due.late { color: var(--red-600); }
  `,
})
export class DonorsPage {
  protected readonly store = inject(Store);
  private readonly router = inject(Router);

  /** The whole row opens the donor; the name link stays the keyboard and screen-reader path. */
  protected open(event: MouseEvent, id: string) {
    if ((event.target as HTMLElement).closest('a, button, input, select')) return;
    if (window.getSelection()?.toString()) return;
    this.router.navigate(['/donors', id]);
  }
  protected readonly money = money;
  protected readonly dateShort = dateShort;
  protected readonly relativeDue = relativeDue;
  protected readonly now = today();
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

  protected readonly totalLifetime = computed(() => this.store.donors().reduce((s, d) => s + this.store.lifetime(d.id), 0));
  protected readonly withoutStep = computed(() => {
    const open = new Set(this.store.followUps().filter((f) => f.status === 'open').map((f) => f.donor_id));
    return this.store.donors().filter((d) => !open.has(d.id)).length;
  });

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
