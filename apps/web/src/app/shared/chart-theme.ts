/** Shared ECharts styling: recessive axes and grid, Cadence ink for text, thin marks. */
export const INK = '#0f1a15';
export const INK_MUTED = '#475950';
export const HAIR = 'rgba(15, 26, 21, 0.08)';
export const GREEN = '#007a3d';
export const BLUE = '#2a78d6'; // validated against GREEN (dataviz validate_palette, light)

export const BASE = {
  backgroundColor: 'transparent',
  textStyle: { fontFamily: "'Instrument Sans Variable', ui-sans-serif, system-ui, sans-serif", color: INK_MUTED, fontSize: 12 },
  aria: { enabled: true },
  animationDuration: 700,
  animationEasing: 'cubicOut' as const,
  tooltip: {
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderColor: 'rgba(15,26,21,0.08)',
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: INK, fontSize: 12.5 },
    extraCssText: 'border-radius:12px;box-shadow:0 12px 32px -12px rgba(15,50,30,.3);backdrop-filter:blur(12px);',
  },
};

export const axisLine = { show: false };
export const axisTick = { show: false };
export const splitLine = { lineStyle: { color: HAIR } };

export function compactMoney(cents: number): string {
  const d = cents / 100;
  if (Math.abs(d) >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (Math.abs(d) >= 1_000) return `$${Math.round(d / 1_000)}k`;
  return `$${Math.round(d)}`;
}
