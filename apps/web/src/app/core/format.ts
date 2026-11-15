const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdExact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' });
const dayShort = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Phoenix' });

export const money = (cents: number) => usd.format(cents / 100);
export const moneyExact = (cents: number) => usdExact.format(cents / 100);
export const date = (value: string) => day.format(new Date(value.length === 10 ? `${value}T12:00:00-07:00` : value));
export const dateShort = (value: string) => dayShort.format(new Date(value.length === 10 ? `${value}T12:00:00-07:00` : value));

/** Today in Phoenix (no DST) as YYYY-MM-DD. */
export function today(): string {
  return new Date(Date.now() - 7 * 3600_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export function relativeDue(due: string, now = today()): string {
  const d = daysBetween(now, due);
  if (d === 0) return 'Due today';
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} overdue`;
  return `Due in ${d} day${d === 1 ? '' : 's'}`;
}

export function quarterOf(value: string): string {
  const d = new Date(`${value}T12:00:00Z`);
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

export const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);
