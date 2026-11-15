import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from '../core/store';

const STEPS = [
  { target: 'donors', title: 'Your donors', text: 'Open your assigned donors to see their records and giving history.' },
  { target: 'search', title: 'Search', text: 'Find a donor, page or action from anywhere in your workspace.' },
  { target: 'followups', title: 'Follow-ups', text: 'See upcoming actions and review messages before sending. Next, we will open your first donor if one is available.' },
  { target: 'log-call', title: 'Log a call', text: 'Record a conversation in the donor’s history.' },
  { target: 'next-step', title: 'Plan the next step', text: 'Add an action and due date to keep the relationship moving.' },
];

@Component({
  selector: 'app-board-guide',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (active() && rect(); as box) {
      <div class="backdrop" aria-hidden="true"></div>
      <div class="spotlight" aria-hidden="true" [style.left.px]="box.left" [style.top.px]="box.top" [style.width.px]="box.width" [style.height.px]="box.height"></div>
      <section #card class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-description"
        [class.above]="above()" [style.left.px]="cardLeft()" [style.top.px]="cardTop()" (keydown)="trap($event)">
        <p class="count">{{ step() + 1 }} / {{ steps.length }}</p>
        <h2 id="tour-title">{{ steps[step()].title }}</h2>
        <p id="tour-description">{{ mobileHint() || steps[step()].text }}</p>
        <div class="actions">
          <button type="button" class="skip" (click)="close()">Skip tour</button>
          <button type="button" (click)="move(-1)" [disabled]="step() === 0">Back</button>
          <button type="button" class="primary" (click)="move(1)">{{ step() === steps.length - 1 ? 'Finish' : 'Next' }}</button>
        </div>
      </section>
    }
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; z-index: 999; }
    .spotlight { position: fixed; z-index: 1000; border-radius: 8px; box-shadow: 0 0 0 4px #fff, 0 0 0 9999px rgb(12 24 18 / .65); pointer-events: none; }
    .tour-card { position: fixed; z-index: 1001; width: min(320px, calc(100vw - 24px)); padding: 16px; border: 1px solid #d9e1db; border-radius: 12px; background: white; color: #17231c; box-shadow: 0 12px 32px rgb(0 0 0 / .2); }
    .tour-card::before { content: ''; position: absolute; top: -7px; left: 24px; width: 12px; height: 12px; background: white; border-top: 1px solid #d9e1db; border-left: 1px solid #d9e1db; transform: rotate(45deg); }
    .tour-card.above::before { top: auto; bottom: -7px; transform: rotate(225deg); }
    .tour-card h2 { margin: 4px 0; font-size: 16px; font-weight: 650; text-wrap: balance; }
    .tour-card p { margin: 0; font-size: 13px; line-height: 1.45; text-wrap: pretty; }
    .tour-card .count { color: #53675a; font-variant-numeric: tabular-nums; }
    .actions { display: flex; align-items: center; gap: 6px; margin-top: 14px; }
    button { min-height: 40px; padding: 0 10px; border: 1px solid #cbd5ce; border-radius: 7px; background: white; cursor: pointer; font-size: 13px; }
    button:focus-visible { outline: 3px solid #168950; outline-offset: 2px; }
    button:disabled { opacity: .45; cursor: default; }
    .skip { margin-right: auto; border-color: transparent; }
    .primary { color: white; background: #08783d; border-color: #08783d; }
  `,
})
export class BoardGuide implements OnDestroy {
  protected readonly steps = STEPS;
  protected readonly active = signal(false);
  protected readonly step = signal(0);
  protected readonly rect = signal<DOMRect | null>(null);
  protected readonly cardLeft = signal(12);
  protected readonly cardTop = signal(12);
  protected readonly above = signal(false);
  protected readonly mobileHint = signal('');
  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  private readonly router = inject(Router);
  private readonly store = inject(Store);
  private returnFocus: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() { this.timer = setTimeout(() => this.start(), 500); }

  start() {
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.active.set(true);
    this.step.set(0);
    this.show();
  }

  protected async move(direction: number) {
    const next = this.step() + direction;
    if (next >= STEPS.length) { this.close(); return; }
    if (next < 0) return;
    this.step.set(next);
    if (next >= 3) {
      const donor = this.store.donors()[0];
      if (!donor) { this.close(); return; }
      if (!this.router.url.startsWith('/donors/' + donor.id)) await this.router.navigateByUrl('/donors/' + donor.id);
    }
    this.show();
  }

  private show(attempt = 0) {
    clearTimeout(this.timer);
    this.rect.set(null);
    this.timer = setTimeout(() => {
      if (!this.active()) return;
      let target = this.findTarget(STEPS[this.step()].target);
      const mobile = !target && (this.step() === 0 || this.step() === 2);
      if (mobile) target = this.findTarget('mobile-nav');
      this.mobileHint.set(mobile ? 'Open navigation to find ' + (this.step() === 0 ? 'Your donors.' : 'Follow-ups.') : '');
      if (!target) {
        if (attempt < 30) { this.show(attempt + 1); return; }
        this.close(); return;
      }
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      this.position(target);
      setTimeout(() => { this.position(target!); this.card()?.nativeElement.querySelector<HTMLButtonElement>('button')?.focus(); }, 0);
    }, 100);
  }

  private findTarget(name: string): HTMLElement | undefined {
    return Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)).find(el => !!el.getClientRects().length);
  }

  private position(target: HTMLElement) {
    const box = target.getBoundingClientRect();
    this.rect.set(box);
    const width = this.card()?.nativeElement.offsetWidth ?? Math.min(320, window.innerWidth - 24);
    const height = this.card()?.nativeElement.offsetHeight ?? 185;
    this.cardLeft.set(Math.max(12, Math.min(box.left, window.innerWidth - width - 12)));
    const below = box.bottom + 14;
    this.above.set(below + height > window.innerHeight && box.top >= height + 14);
    this.cardTop.set(this.above() ? box.top - height - 14 : Math.max(12, Math.min(below, window.innerHeight - height - 12)));
  }

  @HostListener('window:resize') @HostListener('window:scroll')
  protected reposition() {
    if (!this.active() || !this.rect()) return;
    const target = this.findTarget(this.mobileHint() ? 'mobile-nav' : STEPS[this.step()].target);
    if (target) this.position(target); else this.show();
  }

  @HostListener('document:keydown.escape', ['$event'])
  protected escape(event: Event) { if (this.active()) { event.preventDefault(); this.close(); } }

  protected trap(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const buttons = Array.from(this.card()?.nativeElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if ((event.shiftKey && index === 0) || (!event.shiftKey && index === buttons.length - 1)) {
      event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
    }
  }

  protected close() {
    clearTimeout(this.timer);
    this.active.set(false); this.rect.set(null);
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
    else document.querySelector<HTMLElement>('.account-btn')?.focus();
  }
  ngOnDestroy() { clearTimeout(this.timer); }
}
