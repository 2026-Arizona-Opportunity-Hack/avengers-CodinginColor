import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { HlmAvatarImports } from '@spartan-ng/helm/avatar';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmKbdImports } from '@spartan-ng/helm/kbd';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { toast } from '@spartan-ng/brain/sonner';
import { filter } from 'rxjs';
import { Store } from '../core/store';
import { relativeDue, today } from '../core/format';
import { CommandPalette } from './command-palette';
import { NAV, NavGroup } from './nav';

const ADMIN_PATHS = ['/import', '/funders', '/api', '/settings'];

@Component({
  selector: 'app-shell',
  imports: [
    NgTemplateOutlet, RouterOutlet, RouterLink, RouterLinkActive, NgIcon, CommandPalette,
    HlmAvatarImports, HlmButtonImports, HlmDropdownMenuImports, HlmKbdImports, HlmSheetImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    <a class="skip-link" href="#main">Skip to content</a>

    <ng-template #navList>
      <nav aria-label="Primary" class="flex flex-col gap-5">
        @for (group of groups(); track group.label) {
          <div>
            @if (!$first) { <p class="nav-group">{{ group.label }}</p> }
            <ul class="flex flex-col gap-0.5">
              @for (item of group.items; track item.path) {
                <li>
                  <a class="nav-link" [routerLink]="item.path" routerLinkActive="active" ariaCurrentWhenActive="page"
                    [routerLinkActiveOptions]="{ exact: !!item.exact }">
                    <ng-icon [name]="item.icon" size="17" aria-hidden="true" />
                    <span class="flex-1">{{ item.path === '/donors' && !store.isAdmin() ? 'Your donors' : item.label }}</span>
                    @if (item.path === '/outreach' && attention() > 0) {
                      <span class="count" [attr.aria-label]="attention() + ' need attention'">{{ attention() }}</span>
                    }
                  </a>
                </li>
              }
            </ul>
          </div>
        }
      </nav>
    </ng-template>

    <ng-template #brand>
      <a routerLink="/" class="brand">
        <svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#007a3d"/><rect x="8" y="8.5" width="16" height="3.5" rx="1.75" fill="#fff"/><rect x="8" y="14.25" width="10" height="3.5" rx="1.75" fill="#8fd3ad"/><rect x="8" y="20" width="16" height="3.5" rx="1.75" fill="#fff"/></svg>
        <span class="flex flex-col leading-tight"><span class="font-semibold tracking-tight">Cadence</span><span class="text-muted-foreground text-xs">Coding in Color</span></span>
      </a>
    </ng-template>

    <aside class="rail" aria-label="Sidebar">
      <ng-container [ngTemplateOutlet]="brand" />
      <div class="mt-6 flex-1 overflow-y-auto pe-1"><ng-container [ngTemplateOutlet]="navList" /></div>
      <p class="workspace"><span class="dot" [class.live]="store.live()" aria-hidden="true"></span>{{ store.live() ? 'Live workspace' : 'Demo workspace' }}</p>
    </aside>

    <div class="main-col">
      <header class="topbar frosted">
        <hlm-sheet side="left" #drawer="hlmSheet">
          <button hlmBtn variant="ghost" size="icon" class="lg:hidden" hlmSheetTrigger aria-label="Open navigation">
            <ng-icon name="lucideMenu" size="18" />
          </button>
          <hlm-sheet-content *hlmSheetPortal="let ctx" class="drawer">
            <ng-container [ngTemplateOutlet]="brand" />
            <div class="mt-6 overflow-y-auto" (click)="drawer.close()"><ng-container [ngTemplateOutlet]="navList" /></div>
          </hlm-sheet-content>
        </hlm-sheet>

        <button type="button" class="search" (click)="paletteOpen.set(true)" aria-keyshortcuts="Meta+K Control+K">
          <ng-icon name="lucideSearch" size="16" aria-hidden="true" />
          <span class="flex-1 truncate text-start">Search donors, pages, actions</span>
          <kbd hlmKbd class="hidden sm:inline-flex">⌘K</kbd>
        </button>

        <div class="ms-auto flex items-center gap-1.5">
          @if (store.live()) {
            <label class="field text-xs">Giving currency<select class="select" [value]="store.currency()" (change)="store.selectedCurrency.set($any($event.target).value)">
              @for (currency of store.currencies().length ? store.currencies() : ['USD']; track currency) { <option [value]="currency">{{ currency }}</option> }
            </select></label>
          }
          <button hlmBtn variant="ghost" size="icon" class="relative" [hlmDropdownMenuTrigger]="bell" align="end"
            [attr.aria-label]="'Follow-ups due: ' + due().length">
            <ng-icon name="lucideBell" size="18" />
            @if (due().length) { <span class="bell-dot" aria-hidden="true"></span> }
          </button>
          <ng-template #bell>
            <hlm-dropdown-menu class="w-80">
              <hlm-dropdown-menu-label>Due now · {{ due().length }}</hlm-dropdown-menu-label>
              @for (f of due().slice(0, 5); track f.id) {
                <button hlmDropdownMenuItem (triggered)="router.navigateByUrl('/donors/' + f.donor_id)" class="items-start">
                  <ng-icon [name]="f.due_on < now ? 'lucideCircleAlert' : 'lucideCalendarClock'" size="16"
                    class="mt-0.5" [color]="f.due_on < now ? 'var(--danger)' : 'var(--attention)'" />
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate font-medium">{{ store.donor(f.donor_id)?.name }}</span>
                    <span class="text-muted-foreground truncate text-xs">{{ f.action }} · {{ relativeDue(f.due_on) }}</span>
                  </span>
                </button>
              } @empty {
                <p class="text-muted-foreground px-3 py-4 text-sm">Nothing due. You're caught up.</p>
              }
              @if (!store.live()) {
                <hlm-dropdown-menu-separator />
                <button hlmDropdownMenuItem (triggered)="router.navigateByUrl('/outreach')">
                  <ng-icon name="lucideArrowRight" size="16" /> Open follow-up queue
                </button>
              }
            </hlm-dropdown-menu>
          </ng-template>

          <button type="button" class="account-btn" [hlmDropdownMenuTrigger]="account" align="end">
            <hlm-avatar size="sm" aria-hidden="true"><span hlmAvatarFallback class="avatar-fallback">{{ store.initials(meName()) }}</span></hlm-avatar>
            <span class="hidden min-w-0 flex-col text-start leading-tight md:flex">
              <span class="truncate text-[13px] font-medium">{{ meName() }}</span>
              <span class="text-muted-foreground truncate text-xs">{{ store.isAdmin() ? 'Admin' : 'Board member' }}</span>
            </span>
            <ng-icon name="lucideChevronDown" size="15" class="text-muted-foreground hidden md:block" aria-hidden="true" />
            <span class="sr-only">Account menu</span>
          </button>
          <ng-template #account>
            <hlm-dropdown-menu class="w-72">
              <div class="flex items-center gap-3 px-3 py-2.5">
                <hlm-avatar><span hlmAvatarFallback class="avatar-fallback">{{ store.initials(meName()) }}</span></hlm-avatar>
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold">{{ meName() }}</p>
                  <p class="text-muted-foreground truncate text-xs">{{ store.me().email || store.me().title }}</p>
                </div>
              </div>
              <hlm-dropdown-menu-separator />
              <button hlmDropdownMenuItem (triggered)="router.navigateByUrl('/account')"><ng-icon name="lucideUser" size="16" /> Account and security</button>
              @if (!store.live()) {
                <hlm-dropdown-menu-separator />
                <hlm-dropdown-menu-label>Switch demo account</hlm-dropdown-menu-label>
                @for (m of otherMembers(); track m.id) {
                  <button hlmDropdownMenuItem (triggered)="switchTo(m.id)">
                    <span class="grid size-6 place-items-center rounded-full bg-[var(--green-50)] text-[10px] font-semibold text-[var(--green-700)]" aria-hidden="true">{{ store.initials(m.name) }}</span>
                    <span class="flex-1 truncate">{{ m.name }}</span>
                    <span class="text-muted-foreground text-xs">{{ m.role === 'admin' ? 'Admin' : 'Board' }}</span>
                  </button>
                }
              }
              <hlm-dropdown-menu-separator />
              <button hlmDropdownMenuItem (triggered)="signOut()"><ng-icon name="lucideLogOut" size="16" /> Sign out</button>
            </hlm-dropdown-menu>
          </ng-template>
        </div>
      </header>

      @if (store.notice(); as notice) {
        <div class="notice mx-auto mt-4 max-w-[1320px] items-center" role="alert" style="margin-inline: 16px">
          <ng-icon name="lucideCircleAlert" size="16" color="var(--attention)" aria-hidden="true" />
          <p class="flex-1">{{ notice }}</p>
          <button hlmBtn variant="ghost" size="sm" (click)="store.notice.set(null)">Dismiss</button>
        </div>
      }

      <main id="main" tabindex="-1">
        <!-- Protected views exist only while the session is valid; losing it destroys them. -->
        @if (store.signedIn()) { <router-outlet /> }
      </main>
    </div>

    <app-command-palette [open]="paletteOpen()" (openChange)="paletteOpen.set($event)" [nav]="groups()" />
  `,
  styles: `
    :host { display: block; min-height: 100dvh; }
    .rail {
      position: fixed; inset-block: 0; inset-inline-start: 0; z-index: 30; width: var(--rail-w);
      display: none; flex-direction: column; padding: 18px 12px 14px;
      background: transparent; border-inline-end: 1px solid rgb(15 26 21 / 0.07);
    }
    @media (min-width: 1024px) { .rail { display: flex; } .main-col { padding-inline-start: var(--rail-w); } }
    .brand { display: flex; align-items: center; gap: 10px; padding: 2px 10px; text-decoration: none; font-size: 14.5px; }
    .mark { width: 28px; height: 28px; flex: none; }
    .nav-group { padding: 0 12px 6px; font-size: 12px; font-weight: 500; color: var(--ink-600); }
    .nav-link {
      display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 12px; border-radius: 9px;
      text-decoration: none; font-size: 13.5px; font-weight: 500; color: var(--ink-600);
      transition: background-color 120ms ease, color 120ms ease;
    }
    .nav-link ng-icon { color: var(--ink-400); }
    .nav-link:hover { background: rgb(15 26 21 / 0.04); color: var(--foreground); }
    .nav-link.active { background: rgb(0 122 61 / 0.08); color: var(--green-700); }
    .nav-link.active ng-icon { color: var(--green-700); }
    .count { min-width: 20px; height: 18px; padding: 0 6px; display: inline-grid; place-items: center; border-radius: 6px;
      font-size: 11px; font-weight: 600; background: rgb(0 122 61 / 0.1); color: var(--green-700); }
    .workspace { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 8px 12px; font-size: 12px; color: var(--ink-600); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--attention); flex: none; }
    .dot.live { background: var(--green-500); }

    .topbar {
      position: sticky; top: 0; z-index: 20; height: var(--topbar-h);
      display: flex; align-items: center; gap: 8px; padding: 0 16px 0 20px; border-bottom: 1px solid rgb(15 26 21 / 0.06);
    }
    .search {
      display: flex; align-items: center; gap: 10px; height: 36px; width: min(420px, 100%); padding: 0 8px 0 12px;
      border-radius: var(--r-control); border: 1px solid rgb(15 26 21 / 0.08); background: var(--control-bg);
      color: var(--ink-600); font-size: 13.5px; cursor: pointer; transition: background-color 120ms var(--ease-out);
    }
    .search:hover { background: #fff; }
    .bell-dot { position: absolute; top: 8px; inset-inline-end: 9px; width: 7px; height: 7px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 0 2px #fff; }
    .account-btn {
      display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 8px 0 4px; border-radius: 10px; border: 0; background: transparent;
      cursor: pointer; max-width: 240px; transition: background-color 120ms ease;
    }
    .account-btn:hover { background: rgb(15 26 21 / 0.04); }
    .avatar-fallback { background: var(--green-50); color: var(--green-700); font-weight: 600; font-size: 12px; }
    main { outline: none; }
    :host ::ng-deep .drawer { padding: 20px 14px; background: #fff; }
  `,
})
export class Shell {
  protected readonly store = inject(Store);
  protected readonly router = inject(Router);
  protected readonly paletteOpen = signal(false);
  protected readonly now = today();
  protected readonly relativeDue = relativeDue;

  protected readonly groups = computed<NavGroup[]>(() => NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => (!i.admin || this.store.isAdmin()) && (!this.store.live() || i.live)) }))
    .filter((g) => g.items.length > 0));

  protected readonly meName = computed(() => this.store.me().name || 'Signed in');
  protected readonly otherMembers = computed(() => this.store.members().filter((m) => m.active && m.id !== this.store.me().id));
  protected readonly due = computed(() => this.store.followUps()
    .filter((f) => f.status === 'open' && f.due_on <= this.now)
    .sort((a, b) => a.due_on.localeCompare(b.due_on)));
  private readonly approvals = computed(() => this.store.drafts().filter((d) => d.status === 'pending' || d.status === 'approved').length);
  protected readonly attention = computed(() => this.due().length + this.approvals());

  constructor() {
    // If the session ends while a protected view is open (expired or signed out elsewhere),
    // leave for sign-in and keep the page to return to.
    effect(() => {
      if (this.store.signedIn()) return;
      const url = this.router.url;
      if (!url.startsWith('/sign-in')) this.router.navigate(['/sign-in'], { queryParams: { next: url } });
    });
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => {
      document.getElementById('main')?.focus({ preventScroll: true });
    });
  }

  protected onKey(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.paletteOpen.update((v) => !v);
    }
  }

  protected switchTo(id: string) {
    this.store.setSession(id);
    toast.success(`Signed in as ${this.store.me().name}`, { description: this.store.isAdmin() ? 'Admin: the whole organization' : 'Board member: only your donors' });
    const url = this.router.url;
    if (!this.store.isAdmin() && ADMIN_PATHS.some((p) => url.startsWith(p))) this.router.navigateByUrl('/');
    else if (url.startsWith('/donors/') && !url.endsWith('/new')) this.router.navigateByUrl('/donors');
  }

  protected async signOut() {
    await this.store.signOut();
    this.router.navigateByUrl('/sign-in?signedOut=1');
  }
}
