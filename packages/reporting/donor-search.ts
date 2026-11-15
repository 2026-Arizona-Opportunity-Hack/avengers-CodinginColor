import { formatCents } from './funder-packet.ts';
import { instant, retentionReport, ytdWindows, type RetentionGift } from './retention.ts';

export type SearchFilter = { scope: 'visible' | 'mine'; currency: string; period: 'this_year' | 'last_year';
  segment: 'new' | 'reactivated' | 'increased' | 'flat' | 'decreased' | 'lapsed' | 'retained' | null;
  minimum_cents: number | null; status: 'settled' | 'pending' | 'void' | null };
export type SearchDonor = { id: string; name: string; owner_id: string | null; archived_at?: string | null };

export const clarify = { needs_clarification: true, explanation: 'Choose a retention segment, gift status, or giving threshold. You can add a currency and this year or last year. Try “show my lapsed donors” or “donors giving over $100 this year in USD”.', donors: [] };
const segments = ['new', 'reactivated', 'increased', 'flat', 'decreased', 'lapsed', 'retained'] as const;

/** An intentionally small grammar. Unrecognized or personal text never becomes a broad query. */
export function interpretQuestion(question: string): SearchFilter | null {
  if (!/\b(?:donors?|supporters?)\b/i.test(question)) return null;
  let text = question.toLowerCase().replace(/[?!.,](?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  const currencies = [...new Set(text.match(/\b(?:usd|eur|gbp|cad|aud|jpy)\b/g) ?? [])];
  const selected = segments.filter(s => new RegExp(`\\b${s}\\b`).test(text));
  const statuses = (['settled', 'pending', 'void'] as const).filter(s => new RegExp(`\\b${s}\\b`).test(text));
  if (currencies.length > 1 || selected.length > 1 || statuses.length > 1 || (/\bthis year\b/.test(text) && /\blast year\b/.test(text))) return null;
  const amounts = [...text.matchAll(/\b(?:over|above|more than)\s*\$?(\d+(?:\.\d{1,2})?)(?![\d.])/g)];
  if (amounts.length > 1) return null;
  let minimum: number | null = null;
  if (amounts[0]) {
    const [whole, fraction = ''] = amounts[0][1].split('.');
    const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    minimum = Number(value); text = text.replace(amounts[0][0], ' ');
  }
  const result: SearchFilter = { scope: /\bmy\b/.test(text) ? 'mine' : 'visible', currency: (currencies[0] ?? 'usd').toUpperCase(),
    period: /\blast year\b/.test(text) ? 'last_year' : 'this_year', segment: selected[0] ?? null,
    status: statuses[0] ?? null, minimum_cents: minimum };
  text = text.replace(/\b(?:this year|last year)\b/g, ' ').replace(/\b(?:show|find|list|me|my|all|visible|authorized|donors|donor|supporters|supporter|who|with|gifts|gift|giving|gave|have|has|are|the|in|and|please|usd|eur|gbp|cad|aud|jpy|new|reactivated|increased|flat|decreased|lapsed|retained|settled|pending|void)\b/g, ' ').trim();
  if (text || (minimum !== null && result.status && result.status !== 'settled')) return null;
  // Currency and period alone do not say which gift activity should qualify a donor.
  if (!result.segment && !result.status && minimum === null &&
    (currencies.length || /\b(?:this year|last year|gifts?|giving|gave)\b/i.test(question))) return null;
  return result;
}


export function donorSearchWindows(filters: SearchFilter, today: string) {
  const asOf = filters.period === 'last_year' ? `${Number(today.slice(0, 4)) - 1}-12-31` : today;
  return ytdWindows(asOf, '-07:00');
}

/** Inputs must already be authorized; the live API remains responsible for RLS. */
export function searchDonors(filters: SearchFilter, visibleDonors: readonly SearchDonor[], visibleGifts: readonly RetentionGift[], memberId: string, today: string) {
  const donors = visibleDonors.filter(d => !d.archived_at && (filters.scope !== 'mine' || d.owner_id === memberId))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (donors.length > 2000) return { ...clarify, explanation: 'That search is too large. Ask for your own donors or use the donor list filters.' };
  const ids = new Set(donors.map(d => d.id)), windows = donorSearchWindows(filters, today);
  const end = instant(windows.current.to), start = instant(windows.current.from);
  const gifts = visibleGifts.filter(g => ids.has(g.donor_id) && g.currency === filters.currency
    && instant(g.occurred_at) < end);
  if (gifts.length > 50000) return { ...clarify, explanation: 'That history is too large for this search. Use the retention report filters.' };
  const report = retentionReport(gifts, windows).byCurrency[filters.currency];
  const facts = new Map((report?.donors ?? []).map(d => [d.donor_id, d]));
  const matches = donors.filter(d => {
    const fact = facts.get(d.id);
    if (filters.segment === 'retained' ? !fact || !['increased', 'flat', 'decreased'].includes(fact.segment)
      : filters.segment && fact?.segment !== filters.segment) return false;
    if (filters.minimum_cents !== null && (fact?.current_cents ?? 0) <= filters.minimum_cents) return false;
    return !filters.status || gifts.some(g => g.donor_id === d.id && g.status === filters.status
      && instant(g.occurred_at) >= start);
  });
  return { needs_clarification: false, filters, donors: matches.slice(0, 50).map(({ id, name, owner_id }) => ({ id, name, owner_id })), total: matches.length,
    explanation: `Active donors ${filters.scope === 'mine' ? 'assigned to you' : 'visible to your account'}${filters.segment ? `, ${filters.segment} giving` : ''}${filters.minimum_cents !== null ? `, net settled giving over ${formatCents(filters.minimum_cents)}` : ''}${filters.status ? `, with ${filters.status} gifts` : ''}. Gift filters use ${filters.currency} for ${filters.period === 'last_year' ? 'last calendar year' : 'this year through today'}. Showing up to 50 matches.` };
}
