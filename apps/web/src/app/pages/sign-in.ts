import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { Store } from '../core/store';

/**
 * Try Now opens a fictional workspace without an account.
 */
@Component({
  selector: 'app-sign-in',
  imports: [NgIcon, HlmButtonImports],
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
        <h2 id="signin-h" class="text-xl font-semibold tracking-tight">Explore Coding in Color</h2>
        <section class="demo-entry" aria-label="Try Now">
          <a hlmBtn class="try-now" href="/sign-in?demo=1">Try Now <ng-icon name="lucideArrowRight" size="22" aria-hidden="true" /></a>
        </section>
        @if (signedOut() && !store.signedIn()) {
          <p class="status" role="status"><ng-icon name="lucideCircleCheck" size="16" aria-hidden="true" /> You're signed out.</p>
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
    .demo-entry { margin-top: 20px; }
    .try-now { display: flex; width: 100%; min-height: 64px; justify-content: center; gap: 14px; border-radius: 16px;
      background: #007a3d; color: white; font-size: 20px; font-weight: 600; box-shadow: 0 6px 16px rgb(0 92 46 / .18); }
    .try-now:hover { background: #005c2e; }
    .try-now:focus-visible { outline: 3px solid #005c2e; outline-offset: 4px; }
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
  private readonly router = inject(Router);
  readonly next = input<string>();
  readonly signedOut = input<string>();

  constructor() {
    effect(() => { if (this.store.signedIn()) this.router.navigateByUrl(this.safeNext()); });
  }

  /** Only same-app paths, so a crafted link can't bounce someone off-site after sign-in. */
  protected safeNext() {
    const n = this.next();
    return n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/sign-in') ? n : '/';
  }
}
