import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type CanMatchFn, type UrlTree } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { APP_ICONS } from './core/icons';
import { Store } from './core/store';
import { routes } from './app.routes';
import { Shell } from './shell/shell';
import { AccountPage } from './pages/account';
import { AskDataPage } from './pages/ask-data';

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  // JSDOM has no scrolling implementation; these checks inspect navigation and guards.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { delete (Element.prototype as Partial<Element>).scrollIntoView; });

it('hides admin navigation and rejects actual admin route guards for a demo board member', () => {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideIcons(APP_ICONS)] });
  const store = TestBed.inject(Store); store.enableDemo(true);
  const router = TestBed.inject(Router);
  let fixture = TestBed.createComponent(Shell);
  const protectedRoutes = routes.find(r => r.path === '' && r.children)!.children!
    .filter(r => ['import', 'funders', 'api', 'settings'].includes(r.path!));
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('a[href="/prospects"]')?.textContent).toContain('Potential donors');
  expect(routes.find(r => r.children)?.children?.find(r => r.path === 'prospects')?.canMatch).toBeUndefined();
  for (const route of protectedRoutes) expect(fixture.nativeElement.querySelector(`a[href="/${route.path}"]`)).not.toBeNull();
  store.setSession('m-bell'); fixture.destroy();
  fixture = TestBed.createComponent(Shell); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Board member');
  expect(fixture.nativeElement.querySelector('a[href="/prospects"]')).not.toBeNull();
  expect(fixture.nativeElement.querySelector('select[aria-label="Switch person"]').value).toBe('m-bell');
  for (const route of protectedRoutes) {
    expect(fixture.nativeElement.querySelector(`a[href="/${route.path}"]`)).toBeNull();
    const result = TestBed.runInInjectionContext(() => (route.canMatch![0] as CanMatchFn)(route, [], router.routerState.snapshot.root));
    expect(router.serializeUrl(result as UrlTree)).toBe('/');
  }
  store.setSession('m-ceo'); fixture.detectChanges();
  for (const route of protectedRoutes) {
    expect(fixture.nativeElement.querySelector(`a[href="/${route.path}"]`)).not.toBeNull();
    expect(TestBed.runInInjectionContext(() => (route.canMatch![0] as CanMatchFn)(route, [], router.routerState.snapshot.root))).toBe(true);
  }
  fixture.destroy();
});

it('clears a previous persona question and answer on the real session epoch change', async () => {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const store = TestBed.inject(Store); store.enableDemo(true);
  const fixture = TestBed.createComponent(AskDataPage); fixture.detectChanges();
  const input = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
  input.value = 'all donors'; input.dispatchEvent(new Event('input'));
  fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await fixture.whenStable(); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('matching donors');
  store.setSession('m-bell'); fixture.detectChanges();
  expect(input.value).toBe(''); expect(fixture.nativeElement.textContent).not.toContain('matching donors');
});

it('shows role permissions without unusable live-account controls or presentation notes', () => {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideIcons(APP_ICONS)] });
  const store = TestBed.inject(Store); store.enableDemo(true);
  const fixture = TestBed.createComponent(AccountPage); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('whole organization');
  expect(fixture.nativeElement.textContent).not.toMatch(/Clerk|two-step|synthetic|fictional|demo|Manage sign-in security/i);
  store.setSession('m-bell'); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('only donors you own');
  expect(fixture.nativeElement.textContent).toContain('Board member');
});

it.each([
  ['/donors/d-1', 'm-ceo', 'm-bell'], ['/outreach', 'm-bell', 'm-ortiz'],
  ['/settings', 'm-ceo', 'm-ortiz'], ['/prospects', 'm-bell', 'm-ceo'],
])('returns to overview from %s after changing from %s to %s', (path, from, to) => {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideIcons(APP_ICONS)] });
  const store = TestBed.inject(Store); store.enableDemo(true); store.setSession(from);
  const router = TestBed.inject(Router); vi.spyOn(router, 'url', 'get').mockReturnValue(path);
  const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(Shell); fixture.detectChanges();
  const before = store.sessionEpoch();
  const select = fixture.nativeElement.querySelector('select[aria-label="Switch person"]') as HTMLSelectElement;
  select.value = to; select.dispatchEvent(new Event('change')); fixture.detectChanges();
  expect(store.me().id).toBe(to); expect(store.sessionEpoch()).toBe(before + 1);
  expect(store.isAdmin()).toBe(store.me().role === 'admin');
  expect(store.donors().every(d => store.isAdmin() || d.owner_id === to)).toBe(true);
  expect(navigate).toHaveBeenCalledWith('/');
  fixture.destroy();
});
