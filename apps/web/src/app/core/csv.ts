/** RFC 4180 CSV parsing, formula-safe CSV output, and import column classification. */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Prefix cells that a spreadsheet would run as a formula (OWASP CSV injection guidance). */
const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const quote = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(rows: Array<Array<string | number>>): string {
  return rows.map((r) => r.map((c) => quote(safe(String(c)))).join(',')).join('\r\n');
}

export function downloadCsv(name: string, rows: Array<Array<string | number>>) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export const TARGETS = {
  first_name: 'First name', last_name: 'Last name', full_name: 'Full name', email: 'Email', phone: 'Phone',
  company: 'Company', amount: 'Donation amount', contact_person: 'Contact person', campaign: 'Campaign', date: 'Gift date',
  external_id: 'Transaction ID',
  ignore: 'Do not import',
} as const;
export type Target = keyof typeof TARGETS;

const SYNONYMS: Record<Exclude<Target, 'ignore'>, string[]> = {
  first_name: ['first name', 'first', 'firstname', 'given name', 'donor first name'],
  last_name: ['last name', 'last', 'lastname', 'surname', 'family name', 'donor last name'],
  full_name: ['name', 'full name', 'donor name', 'donor'],
  email: ['email', 'email address', 'e mail', 'donor email'],
  phone: ['phone', 'phone number', 'mobile', 'cell', 'telephone'],
  company: ['company', 'employer', 'organization', 'organisation', 'company name'],
  amount: ['donation amount', 'amount', 'gift amount', 'total', 'donation'],
  contact_person: ['contact person', 'board contact', 'owner', 'relationship manager', 'solicitor'],
  campaign: ['campaign', 'campaign name', 'fund', 'appeal', 'designation'],
  date: ['date', 'donation date', 'gift date', 'payment date', 'transaction date'],
  external_id: ['transaction id', 'external id', 'payment id', 'donation id'],
};

export interface ColumnGuess {
  header: string;
  target: Target;
  method: 'exact' | 'suggested' | 'none';
  confidence: number;
  reason: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Words that appear in many export headers and say nothing about the field. */
const FILLER = new Set(['donor', 'gift', 'donation', 'name', 'address', 'number', 'no', 'of', 'the']);

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = new Set(a.split(' ').filter((t) => !FILLER.has(t)));
  const tb = new Set(b.split(' ').filter((t) => !FILLER.has(t)));
  const overlap = ta.size && tb.size ? [...ta].filter((t) => tb.has(t)).length / Math.max(ta.size, tb.size) : 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const edit = 1 - dp[m][n] / Math.max(m, n);
  return Math.max(overlap, edit);
}

const SNIFF: Array<[Target, RegExp, string]> = [
  ['email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'values look like email addresses'],
  ['amount', /^\$?\s?\d{1,3}(,?\d{3})*(\.\d{1,2})?$/, 'values look like money amounts'],
  ['date', /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/, 'values look like dates'],
  ['phone', /^\+?1?[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{4}$/, 'values look like phone numbers'],
];

/**
 * Deterministic first: a header that exactly matches a known synonym is mapped.
 * Otherwise a suggestion is proposed from header similarity or the column's values.
 * Suggestions are never applied until a person accepts them.
 */
export function classifyColumns(headers: string[], rows: string[][]): ColumnGuess[] {
  const taken = new Set<Target>();
  const guesses = headers.map((header): ColumnGuess => {
    const h = norm(header);
    for (const [target, words] of Object.entries(SYNONYMS) as Array<[Target, string[]]>) {
      if (words.includes(h) && !taken.has(target)) {
        taken.add(target);
        return { header, target, method: 'exact', confidence: 1, reason: `Header matches “${TARGETS[target]}”` };
      }
    }
    return { header, target: 'ignore', method: 'none', confidence: 0, reason: '' };
  });
  return guesses.map((g, col) => {
    if (g.method === 'exact') return g;
    const h = norm(g.header);
    let best: { target: Target; score: number; reason: string } = { target: 'ignore', score: 0, reason: '' };
    for (const [target, words] of Object.entries(SYNONYMS) as Array<[Target, string[]]>) {
      if (taken.has(target)) continue;
      const score = Math.max(...words.map((w) => similarity(h, w)));
      if (score > best.score) best = { target, score, reason: `Header resembles “${TARGETS[target]}”` };
    }
    const values = rows.map((r) => (r[col] ?? '').trim()).filter(Boolean).slice(0, 25);
    for (const [target, re, why] of SNIFF) {
      if (taken.has(target) || values.length === 0) continue;
      const share = values.filter((v) => re.test(v)).length / values.length;
      if (share >= 0.8 && share > best.score) best = { target, score: share, reason: `${Math.round(share * 100)}% of ${why}` };
    }
    if (best.score < 0.6) return { ...g, reason: 'No confident match. Choose a field or leave it out.' };
    taken.add(best.target);
    return { header: g.header, target: best.target, method: 'suggested', confidence: best.score, reason: best.reason };
  });
}
