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

it('keeps the public sign-in placeholder until the Clerk widget has content', () => {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideIcons(APP_ICONS)] });
  const api = TestBed.inject(Api); vi.spyOn(api, 'start').mockResolvedValue();
  TestBed.inject(Store).connect({ apiBase: '', clerkPublishableKey: 'pk_test_synthetic' });
  api.status.set('signed-out');
  const fixture = TestBed.createComponent(SignInPage); fixture.detectChanges();
  const placeholder = fixture.nativeElement.querySelector('.signin-placeholder') as HTMLElement;
  expect(placeholder.textContent).toContain('Preparing secure sign-in');
  expect(getComputedStyle(placeholder).display).not.toBe('none');
  fixture.nativeElement.querySelector('.auth-component').append(document.createElement('form'));
  expect(getComputedStyle(placeholder).display).toBe('none');
});
