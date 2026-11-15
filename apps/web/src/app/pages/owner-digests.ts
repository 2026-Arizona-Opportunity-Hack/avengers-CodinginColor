import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../core/store';
import { date, quarterOf, today } from '../core/format';

@Component({
  selector: 'app-owner-digests',
  imports: [RouterLink],
  template: `
    @if (store.isAdmin()) {
      <section aria-labelledby="owner-digests-heading" class="stack">
        <h2 id="owner-digests-heading">{{ quarter }} owner digests</h2>
        <p>Review each portfolio and its open actions before sharing an update with the owner.</p>
        @for (digest of digests(); track digest.owner.id) {
          <details class="rounded-xl border p-4">
            <summary class="cursor-pointer font-semibold">{{ digest.owner.name }}: {{ digest.donors.length }} donors, {{ digest.tasks.length }} open actions</summary>
            <ul class="mt-3 space-y-3">
              @for (donor of digest.donors; track donor.id) {
                <li><a [routerLink]="['/donors', donor.id]">{{ donor.name }}</a>
                  <ul>
                    @for (task of digest.tasks; track task.id) {
                      @if (task.donor_id === donor.id) {
                        <li>{{ task.action }}: {{ date(task.due_on) }}{{ task.due_on < currentDate ? ' (overdue)' : '' }}</li>
                      }
                    }
                  </ul>
                </li>
              } @empty { <li>No assigned donors.</li> }
            </ul>
          </details>
        } @empty { <p>No active board members.</p> }
      </section>
    }
  `,
})
export class OwnerDigests {
  protected readonly store = inject(Store);
  protected readonly date = date;
  protected readonly currentDate = today();
  protected readonly quarter = quarterOf(this.currentDate);
  protected readonly digests = computed(() => this.store.isAdmin() ? this.store.boardMembers().map(owner => {
    const donors = this.store.donors().filter(d => d.owner_id === owner.id);
    const ids = new Set(donors.map(d => d.id));
    const tasks = this.store.followUps().filter(f => f.owner_id === owner.id && f.status === 'open' && ids.has(f.donor_id))
      .sort((a, b) => a.due_on.localeCompare(b.due_on));
    return { owner, donors, tasks };
  }) : []);
}
