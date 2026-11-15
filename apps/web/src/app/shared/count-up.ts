import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** A formatted figure. Kept as a component so every KPI formats the same way. */
@Component({
  selector: 'app-count-up',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ text() }}`,
})
export class CountUp {
  readonly value = input.required<number>();
  readonly format = input<(n: number) => string>((n) => Math.round(n).toLocaleString('en-US'));
  protected readonly text = computed(() => this.format()(this.value()));
}
