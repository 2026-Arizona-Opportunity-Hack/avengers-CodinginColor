import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type CanMatchFn, type UrlTree } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { APP_ICONS } from './core/icons';
import { Store } from './core/store';
import { routes } from './app.routes';
import { Shell } from './shell/shell';
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
  const router = TestBed.inject(Router), fixture = TestBed.createComponent(Shell);
  const protectedRoutes = routes.find(r => r.path === '' && r.children)!.children!
    .filter(r => ['import', 'funders', 'api', 'settings'].includes(r.path!));
  fixture.detectChanges();
  for (const route of protectedRoutes) expect(fixture.nativeElement.querySelector(`a[href="/${route.path}"]`)).not.toBeNull();
  store.setSession('m-bell'); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Demo board');
  expect(fixture.nativeElement.querySelector('select[aria-label="Switch demo person"]')).not.toBeNull();
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
