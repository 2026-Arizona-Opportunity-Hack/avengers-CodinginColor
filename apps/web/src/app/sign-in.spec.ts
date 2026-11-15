import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { APP_ICONS } from './core/icons';
import { Api } from './core/api';
import { Store } from './core/store';
import { SignInPage } from './pages/sign-in';

it('anonymous sign-in shows Try Now without exposing a demo member picker', () => {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideIcons(APP_ICONS)] });
  const store = TestBed.inject(Store);
  const fixture = TestBed.createComponent(SignInPage); fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('a[href="/sign-in?demo=1"]').textContent.trim()).toBe('Try Now');
  expect(fixture.nativeElement.querySelector('[aria-label="Demo accounts"]')).toBeNull();
  for (const member of store.members()) expect(fixture.nativeElement.textContent).not.toContain(member.name);
});

it('shows a large demo entry without provider widgets or live-login controls', () => {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideIcons(APP_ICONS)] });
  const api = TestBed.inject(Api), mount = vi.spyOn(api, 'mountSignIn');
  const fixture = TestBed.createComponent(SignInPage); fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  expect(el.querySelector('.try-now')).not.toBeNull();
  expect(el.querySelector('.auth-component, a[href*="demo=0"], a[href*="setup-security"]')).toBeNull();
  expect(el.textContent).not.toMatch(/Clerk|two-step|Everyone has demo admin|Start as demo admin|Present with synthetic|Fictional data/);
  expect(mount).not.toHaveBeenCalled();
});
