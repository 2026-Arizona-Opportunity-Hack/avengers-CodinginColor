import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { Api } from './core/api';
import { SetupSecurityPage } from './pages/setup-security';
import { routes } from './app.routes';

it('redirects retired public account and security entry routes to Try Now', () => {
  for (const path of ['setup-security', 'sign-up', 'impact']) {
    const route = routes.find(r => r.path === path)!;
    expect(route.redirectTo).toBe('sign-in');
    expect(route.loadComponent).toBeUndefined();
  }
});

function setup() {
  const api = { status: signal('error'), canRetry: () => true, mountSecurity: vi.fn(), unmountSecurity: vi.fn(),
    securityEnrolled: vi.fn(async () => false), signOut: vi.fn(async () => {}) };
  TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: api }, provideRouter([])] });
  const fixture = TestBed.createComponent(SetupSecurityPage); fixture.detectChanges();
  const page = fixture.componentInstance as unknown as { finish(): Promise<void> };
  return { api, fixture, page, navigate: vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true) };
}
it('retains the unexposed live security component and refuses to finish before verified enrollment', async () => {
  const f = setup(); expect(f.api.mountSecurity).toHaveBeenCalledOnce();
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
