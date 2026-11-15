import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Tiny trend line for a KPI tile. Decorative: the tile's text states the number and the change. */
@Component({
  selector: 'app-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.viewBox]="'0 0 ' + w + ' ' + h" preserveAspectRatio="none" aria-hidden="true" class="block h-9 w-full overflow-visible">
      <defs>
        <linearGradient [attr.id]="gid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#007a3d" stop-opacity="0.22" /><stop offset="1" stop-color="#007a3d" stop-opacity="0" />
        </linearGradient>
      </defs>
      @if (path(); as p) {
        <path [attr.d]="p.area" [attr.fill]="'url(#' + gid + ')'" />
        <path [attr.d]="p.line" fill="none" stroke="#007a3d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      }
    </svg>
  `,
})
export class Sparkline {
  readonly values = input.required<number[]>();
  protected readonly w = 120;
  protected readonly h = 36;
  protected readonly gid = `spark-${Math.random().toString(36).slice(2, 8)}`;

  protected readonly path = computed(() => {
    const v = this.values();
    if (v.length < 2) return null;
    const max = Math.max(...v), min = Math.min(...v, 0);
    const span = max - min || 1;
    const pts = v.map((y, i) => [(i / (v.length - 1)) * this.w, this.h - 3 - ((y - min) / span) * (this.h - 6)] as const);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const [lastX, lastY] = pts[pts.length - 1];
    return { line, area: `${line} L${this.w},${this.h} L0,${this.h} Z`, lastX, lastY };
  });
}
