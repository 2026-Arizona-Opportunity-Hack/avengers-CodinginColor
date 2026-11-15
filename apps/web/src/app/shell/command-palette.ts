import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import { Store } from '../core/store';
import { NavGroup } from './nav';

interface Action { label: string; icon: string; path: string; admin?: boolean; }

const ACTIONS: Action[] = [
  { label: 'Add a donor', icon: 'lucideUserPlus', path: '/donors/new' },
  { label: 'Import a spreadsheet or export', icon: 'lucideUpload', path: '/import', admin: true },
  { label: 'Review drafts waiting for approval', icon: 'lucideListChecks', path: '/outreach' },
  { label: 'Export a funder packet', icon: 'lucideFileDown', path: '/funders', admin: true },
  { label: 'Your account', icon: 'lucideUser', path: '/account' },
];

/** ⌘K palette: jump to a page, a donor or an action. Only shows what this person may open. */
@Component({
  selector: 'app-command-palette',
  imports: [HlmCommandImports, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-command-dialog [state]="open() ? 'open' : 'closed'" (stateChange)="openChange.emit($event === 'open')"
      title="Search Coding in Color" description="Jump to a page, a donor or an action" dialogContentClass="w-[min(640px,calc(100vw-32px))]">
      <hlm-command>
        <hlm-command-input placeholder="Search donors, pages and actions" />
        <hlm-command-list class="max-h-[min(420px,60vh)]">
          <div *hlmCommandEmptyState hlmCommandEmpty>No matches. Try a donor's name or a page.</div>
          <hlm-command-group>
            <hlm-command-group-label>Pages</hlm-command-group-label>
            @for (p of pages(); track p.path) {
              <button hlmCommandItem [value]="'page ' + p.label" (selected)="go(p.path)">
                <ng-icon [name]="p.icon" /> {{ p.label }}
              </button>
            }
          </hlm-command-group>
          <hlm-command-separator />
          <hlm-command-group>
            <hlm-command-group-label>Actions</hlm-command-group-label>
            @for (a of actions(); track a.path) {
              <button hlmCommandItem [value]="'action ' + a.label" (selected)="go(a.path)">
                <ng-icon [name]="a.icon" /> {{ a.label }}
              </button>
            }
          </hlm-command-group>
          <hlm-command-separator />
          <hlm-command-group>
            <hlm-command-group-label>{{ store.isAdmin() ? 'Donors' : 'Your donors' }}</hlm-command-group-label>
            @for (d of store.donors(); track d.id) {
              <button hlmCommandItem [value]="'donor ' + d.name + ' ' + (d.company ?? '') + ' ' + (d.email ?? '')" (selected)="go('/donors/' + d.id)">
                <span class="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--green-50)] text-[10px] font-semibold text-[var(--green-700)]" aria-hidden="true">{{ store.initials(d.name) }}</span>
                <span class="min-w-0 flex-1 truncate">{{ d.name }}</span>
                <span class="text-muted-foreground text-xs">{{ store.member(d.owner_id)?.name ?? 'Unassigned' }}</span>
              </button>
            }
          </hlm-command-group>
        </hlm-command-list>
      </hlm-command>
    </hlm-command-dialog>
  `,
})
export class CommandPalette {
  protected readonly store = inject(Store);
  private readonly router = inject(Router);
  readonly open = input(false);
  readonly nav = input.required<NavGroup[]>();
  readonly openChange = output<boolean>();

  protected readonly pages = computed(() => this.nav().flatMap((g) => g.items));
  protected readonly actions = computed(() => ACTIONS.filter((a) =>
    (!a.admin || this.store.isAdmin()) && (!this.store.live() || ['/account', '/outreach', '/import', '/donors/new', '/funders'].includes(a.path))));

  protected go(path: string) {
    this.openChange.emit(false);
    this.router.navigateByUrl(path);
  }
}
