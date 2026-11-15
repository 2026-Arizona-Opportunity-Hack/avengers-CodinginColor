import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { Store } from './core/store';
import { today } from './core/format';

interface NavItem { path: string; label: string; admin?: boolean; exact?: boolean; count?: () => number; }
interface NavGroup { label: string; items: NavItem[]; }

const ADMIN_PATHS = ['/import', '/funders', '/api', '/settings'];

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="shell" [class.nav-open]="navOpen()">
      <header class="mobile-bar">
        <a routerLink="/" class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#007a3d"/><rect x="8" y="8" width="16" height="4" fill="#fff"/><rect x="8" y="14" width="10" height="4" fill="#00a850"/><rect x="8" y="20" width="16" height="4" fill="#fff"/></svg>Cadence</a>
        <button class="btn small" type="button" (click)="navOpen.set(!navOpen())"
          [attr.aria-expanded]="navOpen()" aria-controls="sidebar">Menu</button>
      </header>

      <aside id="sidebar" class="sidebar" aria-label="Navigation and account">
        <a routerLink="/" class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#007a3d"/><rect x="8" y="8" width="16" height="4" fill="#fff"/><rect x="8" y="14" width="10" height="4" fill="#00a850"/><rect x="8" y="20" width="16" height="4" fill="#fff"/></svg>Cadence</a>
        <p class="org">Coding in Color</p>

        <nav aria-label="Primary">
          @for (group of groups(); track group.label) {
            <p class="label group">{{ group.label }}</p>
            <ul>
              @for (item of group.items; track item.path) {
                <li>
                  <a [routerLink]="item.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: !!item.exact }"
                    ariaCurrentWhenActive="page">
                    <span>{{ item.label }}</span>
                    @if (item.count && item.count() > 0) {
                      <span class="count mono" [attr.aria-label]="item.count() + ' need attention'">{{ item.count() }}</span>
                    }
                  </a>
                </li>
              }
            </ul>
          }
        </nav>

        <div class="session">
          <label class="label" for="session">Signed in as</label>
          <select id="session" class="select" (change)="switchTo($any($event.target).value)">
            @for (m of store.members(); track m.id) {
              <option [value]="m.id" [selected]="m.id === store.sessionId()">{{ m.name }} — {{ m.role === 'admin' ? 'Admin' : 'Board' }}</option>
            }
          </select>
          <p class="session-meta">{{ store.me().title }} · <span class="tag" [class.solid]="store.isAdmin()">{{ store.isAdmin() ? 'Admin' : 'Board' }}</span></p>
          <p class="demo-note"><span class="tag dashed">Demo data</span> Synthetic records only.</p>
        </div>
      </aside>

      <main id="main" tabindex="-1">
        <router-outlet />
      </main>
    </div>
  `,
  styles: `
    .shell { display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); min-height: 100vh; }
    .sidebar { position: sticky; top: 0; height: 100vh; overflow-y: auto; background: var(--tint);
      padding: 20px 14px; display: flex; flex-direction: column; }
    .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px;
      letter-spacing: -0.02em; text-decoration: none; padding: 0 8px; }
    .mark { width: 20px; height: 20px; flex: none; }
    .org { padding: 2px 8px 0 38px; font-size: 12px; }
    nav { margin-top: 20px; flex: 1; }
    .group { padding: 16px 8px 6px; }
    ul { list-style: none; margin: 0; padding: 0; }
    nav a { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 8px;
      border-radius: var(--radius); text-decoration: none; font-size: 13.5px; font-weight: 500; }
    nav a:hover { background: var(--paper); }
    nav a.active { background: var(--brand); color: var(--paper); box-shadow: inset 3px 0 0 var(--accent); }
    .count { font-size: 11px; min-width: 20px; height: 18px; padding: 0 5px; display: inline-grid; place-items: center;
      border: 1px solid currentColor; border-radius: 3px; }
    .session { border-top: 1px solid var(--rule); padding: 14px 8px 0; display: flex; flex-direction: column; gap: 8px; }
    .session .select { font-size: 13px; min-height: 32px; padding: 4px 28px 4px 8px; }
    .session-meta, .demo-note { font-size: 12px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    main { min-width: 0; outline: none; border-left: 1px solid var(--rule); min-height: 100vh; }
    .mobile-bar { display: none; }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      main { border-left: 0; }
      .mobile-bar { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px;
        border-bottom: 1px solid var(--rule); position: sticky; top: 0; background: var(--paper); z-index: 10; }
      .sidebar { display: none; position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--rule); }
      .sidebar > .brand, .sidebar > .org { display: none; }
      .nav-open .sidebar { display: flex; }
    }
  `,
})
export class App {
  protected readonly store = inject(Store);
  private readonly router = inject(Router);
  protected readonly navOpen = signal(false);

  private readonly dueCount = computed(() => {
    const now = today();
    return this.store.followUps().filter((f) => f.status === 'open' && f.due_on <= now).length;
  });
  private readonly approvalCount = computed(() => this.store.drafts().filter((d) => d.status === 'pending' || d.status === 'approved').length);

  protected readonly groups = computed<NavGroup[]>(() => {
    const all: NavGroup[] = [
      { label: 'Relationships', items: [
        { path: '/', label: 'Overview', exact: true },
        { path: '/donors', label: this.store.isAdmin() ? 'Donors' : 'Your donors' },
        { path: '/donations', label: 'Donations' },
        { path: '/outreach', label: 'Outreach', count: () => this.dueCount() + this.approvalCount() },
      ] },
      { label: 'Insights', items: [
        { path: '/retention', label: 'Retention' },
        { path: '/funders', label: 'Funder reports', admin: true },
      ] },
      { label: 'Data', items: [
        { path: '/import', label: 'Import', admin: true },
        { path: '/api', label: 'Read API', admin: true },
        { path: '/settings', label: 'Settings', admin: true },
      ] },
    ];
    return all
      .map((g) => ({ ...g, items: g.items.filter((i) => !i.admin || this.store.isAdmin()) }))
      .filter((g) => g.items.length > 0);
  });

  constructor() {
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => {
      this.navOpen.set(false);
      document.getElementById('main')?.focus({ preventScroll: true });
    });
  }

  protected switchTo(id: string) {
    this.store.setSession(id);
    const url = this.router.url;
    if (!this.store.isAdmin() && ADMIN_PATHS.some((p) => url.startsWith(p))) this.router.navigateByUrl('/');
    else if (url.startsWith('/donors/') && !url.endsWith('/new')) this.router.navigateByUrl('/donors');
  }
}
