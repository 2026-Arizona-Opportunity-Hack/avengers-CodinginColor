import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSkeletonImports } from '@spartan-ng/helm/skeleton';
import { Api } from '../core/api';
import { Store } from '../core/store';

/**
 * Public sign-in mounts Clerk for real accounts; Try Now enters the synthetic admin demo.
 */
@Component({
  selector: 'app-sign-in',
  imports: [RouterLink, NgIcon, HlmButtonImports, HlmSkeletonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <section class="story" aria-labelledby="story-h">
        <div class="flex items-center gap-3">
          <span class="logo-crop" aria-hidden="true"><img src="branding/coding-in-color-logo.jpg" alt="" width="512" height="512" /></span>
          <span class="text-lg font-semibold tracking-tight">Coding in Color</span>
        </div>
        <h1 id="story-h" class="story-title">Know every donor. Keep every promise to follow up.</h1>
        <ul class="points">
          <li><ng-icon name="lucideRepeat" size="18" aria-hidden="true" /><span>See who gave, who grew and who lapsed, year over year.</span></li>
          <li><ng-icon name="lucideListChecks" size="18" aria-hidden="true" /><span>Every thank-you and nudge is drafted for you and sent by a person.</span></li>
          <li><ng-icon name="lucideShieldCheck" size="18" aria-hidden="true" /><span>Board members see only the donors they own.</span></li>
        </ul>
      </section>

      <main id="main" class="card glass" aria-labelledby="signin-h">
        <h2 id="signin-h" class="text-xl font-semibold tracking-tight">{{ store.demoAdmin() ? 'Demo workspace' : 'Sign in to Coding in Color' }}</h2>
        <section class="status flex-col items-start gap-3" aria-label="Presentation demo">
          <p>Present with synthetic data. Everyone has demo admin access; no account or two-step setup needed.</p>
          <a hlmBtn href="/sign-in?demo=1">Try Now</a>
        </section>
        @if (store.demoAdmin()) {
          <a class="mt-3 inline-block text-sm underline" href="/sign-in?demo=0">Use live workspace sign-in</a>
        }
        @if (securitySetup() === 'complete' && !store.signedIn()) {
          <p class="status" role="status">Sign in again and enter your authenticator code to finish.</p>
        }

        @if (signedOut() && !store.signedIn()) {
          <p class="status" role="status"><ng-icon name="lucideCircleCheck" size="16" aria-hidden="true" /> You're signed out.</p>
        }

        @if (store.live()) {
          @switch (api.status()) {
            @case ('signed-out') {
              <p class="text-muted-foreground mt-1 text-sm">Use the account Coding in Color invited you with. Admins confirm a second factor.</p>
              <div #clerk class="auth-component mt-6"></div>
              <div class="signin-placeholder" role="status">
                <p>Preparing secure sign-in…</p>
                <span></span><span></span><span></span>
              </div>
            }
            @case ('error') {
              @if (api.errorCode() === 'admin_mfa_required' && api.canRetry()) {
                <section class="mt-5 space-y-4" aria-labelledby="setup-security-title">
                  <h3 id="setup-security-title" class="text-lg font-semibold">Set up two-step verification</h3>
                  <p>Your admin account needs one more step before you can open the workspace. Add an authenticator, verify its code, then sign in again.</p>
                  <a hlmBtn routerLink="/setup-security" [queryParams]="{ next: safeNext() }">Set up two-step verification</a>
                  <p class="text-sm">This extra step is required for admins. Board accounts can sign in without it.</p>
                  <button hlmBtn variant="ghost" type="button" (click)="store.signOut()">Use another account</button>
                </section>
              } @else {
                <p class="mt-3 text-sm" role="alert">{{ api.error() }}</p>
                <button hlmBtn class="mt-5" (click)="retry()"><ng-icon name="lucideRefreshCw" size="16" /> Try again</button>
                @if (api.canRetry()) {
                  <button hlmBtn variant="outline" class="mt-3" type="button" (click)="api.manageSecurity()">Manage sign-in security</button>
                  <button hlmBtn variant="ghost" class="mt-3" type="button" (click)="store.signOut()">Sign out</button>
                }
              }
            }
            @default {
              <p class="text-muted-foreground mt-1 text-sm" role="status">Connecting to your workspace…</p>
              <div class="mt-6 flex flex-col gap-3" aria-hidden="true">
                <hlm-skeleton class="h-11 w-full rounded-xl" /><hlm-skeleton class="h-11 w-full rounded-xl" /><hlm-skeleton class="h-11 w-2/3 rounded-xl" />
              </div>
            }
          }
        }
      </main>
    </div>
  `,
  styles: `
    :host { display: block; min-height: 100dvh; }
    .wrap { min-height: 100dvh; display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 48px; align-items: center;
      max-width: 1180px; margin: 0 auto; padding: 48px 32px; }
    .story { display: flex; flex-direction: column; gap: 28px; }
    .story-title { font-size: clamp(30px, 4vw, 46px); line-height: 1.08; letter-spacing: -0.035em; font-weight: 600; max-width: 15ch; }
    .points { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; max-width: 44ch; }
    .points li { display: flex; gap: 12px; align-items: flex-start; font-size: 15px; color: var(--ink-600); }
    .points ng-icon { color: var(--primary); margin-top: 2px; flex: none; }
    .card { border-radius: 28px; padding: 32px; width: 100%; max-width: 460px; min-height: 350px; justify-self: end; outline: none; }
    .signin-placeholder { margin-top: 12px; color: var(--ink-600); font-size: 13px; }
    .signin-placeholder span { display: block; height: 28px; margin-top: 10px; border-radius: 8px; background: rgb(15 26 21 / 0.06); }
    .signin-placeholder span:last-child { width: 66%; }
    .auth-component:not(:empty) + .signin-placeholder { display: none; }
    .status { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 8px 12px; border-radius: 12px;
      background: var(--green-50); color: var(--green-700); font-size: 13.5px; font-weight: 500; }
    @media (max-width: 900px) {
      .wrap { grid-template-columns: minmax(0, 1fr); gap: 28px; padding: 24px 16px; align-items: start; }
      .card { justify-self: stretch; max-width: none; padding: 22px; }
      .points { display: none; }
      .story { gap: 16px; }
    }
  `,
})
export class SignInPage {
  protected readonly store = inject(Store);
  protected readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly next = input<string>();
  readonly signedOut = input<string>();
  readonly securitySetup = input<string>();
  private readonly clerk = viewChild<ElementRef<HTMLDivElement>>('clerk');

  constructor() {
    effect(() => { if (this.store.signedIn()) this.router.navigateByUrl(this.safeNext()); });
    effect((onCleanup) => {
      const el = this.clerk()?.nativeElement;
      if (!el) return;
      this.api.mountSignIn(el);
      onCleanup(() => this.api.unmountSignIn(el));
    });
  }

  /** Only same-app paths, so a crafted link can't bounce someone off-site after sign-in. */
  protected safeNext() {
    const n = this.next();
    return n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/sign-in') ? n : '/';
  }

  protected retry() {
    if (this.api.canRetry()) void this.store.refreshLive(); else location.reload();
  }
}
