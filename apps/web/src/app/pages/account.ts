import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { Store } from '../core/store';

interface Permission { label: string; allowed: boolean; }

/** Account and security: who you are, what your role can do, how sign-in is protected. */
@Component({
  selector: 'app-account',
  imports: [NgIcon, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Account and security</h1>
          <p class="lede">Your profile, what your role can do, and how sign-in is protected.</p>
        </div>
      </header>

      <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section class="panel p-6" aria-labelledby="profile-h">
          <div class="flex items-center gap-4">
            <span class="avatar" aria-hidden="true">{{ store.initials(name()) }}</span>
            <div class="min-w-0">
              <h2 id="profile-h" class="text-lg">{{ name() }}</h2>
              <p class="text-muted-foreground text-sm">{{ store.me().title }}</p>
            </div>
            <span class="role ms-auto" [class.admin]="store.isAdmin()">{{ store.isAdmin() ? 'Admin' : 'Board member' }}</span>
          </div>
          <dl class="kv mt-6">
            <dt>Email</dt><dd>{{ store.me().email || 'Managed by Clerk' }}</dd>
            <dt>Organization</dt><dd>Coding in Color</dd>
            <dt>Donors visible</dt><dd>{{ store.donors().length }} {{ store.isAdmin() ? '(whole organization)' : '(only donors you own)' }}</dd>
            <dt>Workspace</dt><dd>{{ store.live() ? 'Live: every request is checked by the server' : 'Demo: synthetic records stored in this browser' }}</dd>
          </dl>
        </section>

        <section class="panel p-6" aria-labelledby="perm-h">
          <h2 id="perm-h">What your role can do</h2>
          <p class="text-muted-foreground mt-1 text-sm">Least privilege: the server enforces the same rules on every route and query.</p>
          <ul class="perms mt-4">
            @for (p of permissions(); track p.label) {
              <li>
                <ng-icon [name]="p.allowed ? 'lucideCircleCheck' : 'lucideX'" size="16" [color]="p.allowed ? 'var(--positive)' : 'var(--ink-400)'" aria-hidden="true" />
                <span>{{ p.label }}</span>
                <span class="sr-only">{{ p.allowed ? 'Allowed' : 'Not allowed' }}</span>
              </li>
            }
          </ul>
        </section>
      </div>

      <section class="panel mt-5 p-6" aria-labelledby="sec-h">
        <h2 id="sec-h">Sign-in and security</h2>
        <div class="mt-4 grid gap-4 md:grid-cols-3">
          <div class="tile"><ng-icon name="lucideShieldCheck" size="18" aria-hidden="true" />
            <p class="font-medium">Invitation only</p><p class="text-muted-foreground text-sm">No public sign-up and no shared passwords. Clerk holds credentials; Cadence never sees them.</p></div>
          <div class="tile"><ng-icon name="lucideKeyRound" size="18" aria-hidden="true" />
            <p class="font-medium">Second factor for admins</p><p class="text-muted-foreground text-sm">Admin requests must carry a verified second factor, checked on every call.</p></div>
          <div class="tile"><ng-icon name="lucideMonitor" size="18" aria-hidden="true" />
            <p class="font-medium">This session</p><p class="text-muted-foreground text-sm">{{ store.live() ? 'Signed in with Clerk. Donor records stay in memory and clear on sign-out.' : 'Demo session in this browser only.' }}</p></div>
        </div>
        <div class="mt-6 flex flex-wrap gap-2">
          <button hlmBtn variant="outline" (click)="signOut()"><ng-icon name="lucideLogOut" size="16" /> Sign out</button>
        </div>
      </section>
    </div>
  `,
  styles: `
    .avatar { width: 52px; height: 52px; flex: none; border-radius: 50%; display: grid; place-items: center;
      background: var(--green-50); color: var(--green-700); font-weight: 600; font-size: 17px; }
    .role { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: rgb(15 26 21 / 0.06); color: var(--ink-600); }
    .role.admin { background: var(--green-50); color: var(--green-700); }
    .perms { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .perms li { display: flex; align-items: center; gap: 10px; font-size: 14px; }
    .ok { color: var(--positive); }
    .no { color: var(--ink-400); }
    .tile { display: flex; flex-direction: column; gap: 6px; padding: 16px; border-radius: 16px; background: rgb(255 255 255 / 0.6); border: 1px solid var(--border); }
    .tile ng-icon { color: var(--primary); }
  `,
})
export class AccountPage {
  protected readonly store = inject(Store);
  private readonly router = inject(Router);
  protected readonly name = computed(() => this.store.me().name || 'Signed in');

  protected readonly permissions = computed<Permission[]>(() => {
    const admin = this.store.isAdmin();
    return [
      { label: admin ? 'See every donor in the organization' : 'See and update the donors you own', allowed: true },
      { label: 'Log calls, texts, meetings and notes', allowed: true },
      { label: 'Approve and send drafted messages for your donors', allowed: true },
      { label: 'Reassign donors between board members', allowed: admin },
      { label: 'Import spreadsheets and platform exports', allowed: admin },
      { label: 'Export funder packets', allowed: admin },
      { label: 'Create and revoke Read API keys', allowed: admin },
    ];
  });

  protected async signOut() {
    await this.store.signOut();
    this.router.navigateByUrl('/sign-in?signedOut=1');
  }
}
