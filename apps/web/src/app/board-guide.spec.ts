import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from './core/store';
import { BoardGuide } from './shell/board-guide';

const targets: HTMLElement[] = [];
const wait = () => new Promise(resolve => setTimeout(resolve, 150));
afterEach(() => { targets.splice(0).forEach(el => el.remove()); vi.restoreAllMocks(); });
function target(name: string, left = 40) {
  const el = document.createElement('button'); el.dataset['tour'] = name;
  el.scrollIntoView = vi.fn(); el.getClientRects = () => ({ length: 1 } as DOMRectList);
  el.getBoundingClientRect = () => new DOMRect(left, 50, 120, 40);
  document.body.append(el); targets.push(el); return el;
}
async function setup(donors = [{ id: '123' }]) {
  const router = { url: '/', navigateByUrl: vi.fn().mockResolvedValue(true) };
  TestBed.configureTestingModule({ providers: [
    { provide: Store, useValue: { donors: () => donors } }, { provide: Router, useValue: router },
  ] });
  const fixture = TestBed.createComponent(BoardGuide); document.body.append(fixture.nativeElement);
  fixture.componentInstance.start(); await wait(); fixture.detectChanges(); await wait();
  const button = (text: string) => [...fixture.nativeElement.querySelectorAll('button')]
    .find((el: any) => el.textContent.trim() === text) as HTMLButtonElement;
  const click = async (text: string) => { button(text).click(); await wait(); fixture.detectChanges(); await wait(); };
  return { fixture, router, click };
}
it('tracks target geometry, navigates to a donor and restores focus on Escape', async () => {
  const origin = target('origin'); origin.focus();
  const donors = target('donors'); target('search', 200); target('followups'); target('log-call'); target('next-step');
  const { fixture, router, click } = await setup();
  expect(fixture.nativeElement.querySelector('.spotlight').style.left).toBe('40px');
  donors.getBoundingClientRect = () => new DOMRect(90, 50, 120, 40);
  window.dispatchEvent(new Event('resize')); fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('.spotlight').style.left).toBe('90px');
  const skip = fixture.nativeElement.querySelector('button') as HTMLButtonElement; skip.focus();
  skip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  expect((document.activeElement as HTMLElement).textContent?.trim()).toBe('Next');
  await click('Next'); expect(fixture.nativeElement.querySelector('.spotlight').style.left).toBe('200px');
  await click('Next'); await click('Next');
  expect(router.navigateByUrl).toHaveBeenCalledWith('/donors/123');
  expect(fixture.nativeElement.textContent).toContain('Log a call');
  await click('Next'); expect(fixture.nativeElement.textContent).toContain('Plan the next step');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('[role=dialog]')).toBeNull(); expect(document.activeElement).toBe(origin);
  fixture.destroy(); fixture.nativeElement.remove();
});
it('uses the visible mobile menu and ends safely when no donor is available', async () => {
  target('mobile-nav'); target('search');
  const { fixture, click } = await setup([]);
  expect(fixture.nativeElement.textContent).toContain('Open navigation to find Your donors');
  await click('Next'); await click('Next');
  expect(fixture.nativeElement.textContent).toContain('Open navigation to find Follow-ups');
  await click('Next'); expect(fixture.nativeElement.querySelector('[role=dialog]')).toBeNull();
  fixture.destroy(); fixture.nativeElement.remove();
});
