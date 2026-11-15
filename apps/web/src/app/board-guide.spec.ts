import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { expect, it } from 'vitest';
import { BoardGuide } from './shell/board-guide';

it('walks through essential actions and can be dismissed and reopened without saving data', async () => {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(BoardGuide);
  await fixture.whenStable(); fixture.detectChanges();
  const button = (name: string) => [...fixture.nativeElement.querySelectorAll('button')]
    .find((node: any) => node.textContent.trim() === name) as HTMLButtonElement;
  const click = (name: string) => { button(name).click(); fixture.detectChanges(); };
  expect(button('Back').disabled).toBe(true);
  expect(fixture.nativeElement.querySelector('a').getAttribute('href')).toBe('/donors');
  click('Next'); expect(fixture.nativeElement.textContent).toContain('Log call');
  click('Dismiss guide'); expect(fixture.nativeElement.querySelector('#board-guide-content')).toBeNull();
  expect(button('Open guide').getAttribute('aria-expanded')).toBe('false');
  click('Open guide'); expect(fixture.nativeElement.textContent).toContain('Step 2 of 3');
  click('Next'); expect(fixture.nativeElement.querySelector('a').getAttribute('href')).toBe('/outreach');
  click('Finish guide'); click('Open guide');
  expect(fixture.nativeElement.textContent).toContain('Step 1 of 3');
});
