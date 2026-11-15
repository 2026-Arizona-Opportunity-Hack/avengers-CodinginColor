import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { Api, ApiError } from './core/api';
import { Store } from './core/store';
import { APP_ICONS } from './core/icons';
import { SignInPage } from './pages/sign-in';
import { SetupSecurityPage } from './pages/setup-security';
import { routes } from './app.routes';

it('turns the server admin MFA requirement into an explicit first-login setup action', async () => {
  const api = new Api(); Object.assign(api, { clerk: { session: {} } });
  vi.spyOn(api, 'me').mockRejectedValue(new ApiError(403, 'admin_mfa_required'));
  vi.spyOn(api, 'allDonors').mockResolvedValue([]);
  TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: api }, provideRouter([]), provideIcons(APP_ICONS)] });
  const store = TestBed.inject(Store); store.live.set(true); await store.refreshLive();
  const fixture = TestBed.createComponent(SignInPage); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Set up two-step verification');
  expect(fixture.nativeElement.querySelector('a[href^="/setup-security"]')).not.toBeNull();
  expect(store.signedIn()).toBe(false);
  api.fail('You do not have access to that.'); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).not.toContain('Set up two-step verification');
});

function setup() {
  const api = { status: signal('error'), canRetry: () => true, mountSecurity: vi.fn(), unmountSecurity: vi.fn(),
    securityEnrolled: vi.fn(async () => false), signOut: vi.fn(async () => {}) };
  TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: api }, provideRouter([])] });
  const fixture = TestBed.createComponent(SetupSecurityPage); fixture.detectChanges();
  const page = fixture.componentInstance as unknown as { finish(): Promise<void> };
  return { api, fixture, page, navigate: vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true) };
}
it('mounts Clerk Security outside the staff guard and refuses to finish before verified enrollment', async () => {
  const f = setup(); expect(f.api.mountSecurity).toHaveBeenCalledOnce();
  expect(routes.find(r => r.path === 'setup-security')?.canMatch).toBeUndefined();
  await f.page.finish(); f.fixture.detectChanges();
  expect(f.fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Add and verify an authenticator first');
  expect(f.api.signOut).not.toHaveBeenCalled(); expect(f.navigate).not.toHaveBeenCalled();
  f.fixture.destroy(); expect(f.api.unmountSecurity).toHaveBeenCalledOnce();
});
it('signs out after enrollment and requires a new sign-in, preserving only a safe local return', async () => {
  const f = setup(); f.api.securityEnrolled.mockResolvedValue(true);
  f.fixture.componentRef.setInput('next', 'https://other.example');
  await f.page.finish();
  expect(f.api.signOut).toHaveBeenCalledOnce();
  expect(f.navigate).toHaveBeenCalledWith(['/sign-in'], { queryParams: { next: '/', securitySetup: 'complete' } });
  expect(f.api.status()).toBe('error'); // The setup screen never grants staff access.
});
it('retains a valid workspace return path after a fresh sign-in', async () => {
  const f = setup(); f.api.securityEnrolled.mockResolvedValue(true); f.fixture.componentRef.setInput('next', '/donors');
  await f.page.finish();
  expect(f.navigate).toHaveBeenCalledWith(['/sign-in'], { queryParams: { next: '/donors', securitySetup: 'complete' } });
});
it('embeds only Clerk account Security and checks enrollment without touching auth state', async () => {
  const api = new Api(), node = document.createElement('div');
  const clerk = { mountUserProfile: vi.fn(), unmountUserProfile: vi.fn(), user: { reload: vi.fn(async () => ({ twoFactorEnabled: true })) } };
  Object.assign(api, { clerk }); api.status.set('error');
  api.mountSecurity(node); expect(clerk.mountUserProfile).toHaveBeenCalledWith(node, expect.objectContaining({ routing: 'hash', __experimental_startPath: '/security' }));
  expect(await api.securityEnrolled()).toBe(true); api.unmountSecurity(node);
  expect(clerk.unmountUserProfile).toHaveBeenCalledWith(node); expect(api.status()).toBe('error');
});
