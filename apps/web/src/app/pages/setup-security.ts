import { Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';

@Component({
  selector: 'app-setup-security', imports: [RouterLink],
  template: `<main class="page stack setup" aria-labelledby="security-title">
    <header><a routerLink="/sign-in">Coding in Color</a><h1 id="security-title">Set up two-step verification</h1>
      <p>Admin accounts use an authenticator to protect the workspace. Board accounts do not need this setup.</p></header>
    @if (hasSession()) {
      <ol class="panel steps">
        <li>In Security below, find <strong>Two-step verification</strong> and add an authenticator app.</li>
        <li>Scan the QR code with your authenticator and enter its code to verify. Keep any recovery codes somewhere private.</li>
        <li>Choose <strong>Finish setup and sign in</strong>, then sign in again and enter your authenticator code.</li>
      </ol>
      <p>Already have an authenticator? Use Finish setup and sign in to start a fresh sign-in.</p>
      <p>Keep the QR code and recovery codes in the secure account form. Do not send them in chat or email.</p>
      <div #security class="security-profile" aria-label="Account security settings"></div>
      @if (error()) { <p role="alert">{{ error() }}</p> }
      <button class="btn primary" type="button" (click)="finish()" [disabled]="busy()">{{ busy() ? 'Checking setup...' : 'Finish setup and sign in' }}</button>
    } @else if (api.status() === 'loading') { <p role="status">Loading your account...</p> }
    @else { <p>Sign in with your invited account first. If an admin account needs this setup, we will guide you here.</p><a class="btn primary" routerLink="/sign-in">Go to sign in</a> }
  </main>`,
  styles: `.setup { max-width:900px; margin:0 auto; padding:32px 20px } .steps { padding:20px 20px 20px 40px } li { margin:10px 0 } .security-profile { min-width:0; max-width:100%; overflow-x:auto } h1 { margin:16px 0 }`,
})
export class SetupSecurityPage {
  protected readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly next = input<string>();
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly hasSession = computed(() => { this.api.status(); return this.api.canRetry(); });
  private readonly security = viewChild<ElementRef<HTMLDivElement>>('security');
  constructor() {
    effect(onCleanup => { const el = this.security()?.nativeElement; if (!el || !this.hasSession()) return;
      this.api.mountSecurity(el); onCleanup(() => this.api.unmountSecurity(el)); });
  }
  protected async finish() {
    if (this.busy() || !this.hasSession()) return;
    this.busy.set(true); this.error.set(null);
    try {
      if (!await this.api.securityEnrolled()) {
        this.error.set('Add and verify an authenticator first. If that option is missing, ask the account administrator to enable authenticator enrollment.'); return;
      }
      await this.api.signOut();
      const next = this.next();
      const safe = next?.startsWith('/') && !next.startsWith('//') && !/^\/(?:sign-in|setup-security)(?:[/?#]|$)/.test(next) ? next : '/';
      await this.router.navigate(['/sign-in'], { queryParams: { next: safe, securitySetup: 'complete' } });
    } catch { this.error.set('Setup could not be confirmed. Check your connection and try again.'); }
    finally { this.busy.set(false); }
  }
}
