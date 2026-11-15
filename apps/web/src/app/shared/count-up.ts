import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';

/**
 * A number that counts up once when it first appears: the dashboard's single orchestrated
 * moment. Screen readers get the final value immediately; reduced motion skips the animation.
 */
@Component({
  selector: 'app-count-up',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span aria-hidden="true">{{ shown() }}</span><span class="sr-only">{{ format()(value()) }}</span>`,
})
export class CountUp {
  readonly value = input.required<number>();
  readonly format = input<(n: number) => string>((n) => Math.round(n).toLocaleString('en-US'));
  protected readonly shown = signal('');
  private started = false;

  constructor() {
    effect(() => {
      const target = this.value();
      const fmt = this.format();
      const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (this.started || reduce) { this.shown.set(fmt(target)); return; }
      this.started = true;
      const t0 = performance.now();
      const step = (t: number) => {
        const p = Math.min(1, (t - t0) / 900);
        const eased = 1 - Math.pow(1 - p, 3);
        this.shown.set(fmt(target * eased));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
}
