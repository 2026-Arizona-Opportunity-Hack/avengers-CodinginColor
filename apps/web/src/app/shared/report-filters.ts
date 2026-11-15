import { Component, inject } from '@angular/core';
import { Store } from '../core/store';
import { ReportFilters } from '../core/report-filters';

@Component({
  selector: 'app-report-filters',
  template: `<form class="filters panel no-print" (submit)="$event.preventDefault()" aria-label="Reporting filters">
    <label class="field">From<input class="input" type="date" [value]="filters.from()" (input)="filters.from.set($any($event.target).value)" /></label>
    <label class="field">Through<input class="input" type="date" [value]="filters.through()" (input)="filters.through.set($any($event.target).value)" /></label>
    <label class="field">Program<select class="select" [value]="filters.program()" (change)="filters.program.set($any($event.target).value); filters.campaign.set('')">
      <option value="">All programs</option>@for (p of store.programs(); track p.id) { <option [value]="p.id">{{ p.title }}</option> }</select></label>
    @if (store.isAdmin()) { <label class="field">Owner<select class="select" [value]="filters.owner()" (change)="filters.owner.set($any($event.target).value)">
      <option value="">All owners</option>@for (m of store.boardMembers(); track m.id) { <option [value]="m.id">{{ m.name }}</option> }</select></label> }
    <label class="field">Campaign<select class="select" [value]="filters.campaign()" (change)="filters.campaign.set($any($event.target).value)">
      <option value="">All campaigns</option>@for (c of store.campaigns(); track c.id) { @if (!filters.program() || c.program_id === filters.program()) { <option [value]="c.id">{{ c.title }}</option> } }</select></label>
    <label class="field">Acquisition year<input class="input" type="number" min="1" max="9999" placeholder="All years" [value]="filters.cohort()" (input)="filters.cohort.set($any($event.target).value)" /></label>
    @if (!filters.valid()) { <p role="alert">Choose valid dates within one calendar year and a four-digit acquisition year, or leave that year empty.</p> }
  </form>`,
  styles: `.filters { display:flex; flex-wrap:wrap; gap:12px; padding:16px; margin-bottom:20px } .field { flex:1; min-width:140px }`,
})
export class ReportFiltersControl {
  protected readonly store = inject(Store);
  protected readonly filters = inject(ReportFilters);
}
