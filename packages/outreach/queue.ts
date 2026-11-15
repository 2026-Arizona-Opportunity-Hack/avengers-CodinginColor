import { instant } from '../reporting/retention.ts';

/** Fields of a donor that decide outreach eligibility; rows come from an authorized query. */
export type OutreachDonor = { id: string; owner_id: string | null; consent: 'unknown' | 'granted' | 'denied'; archived_at: string | null };
export type OutreachTask = {
  id: string; donor_id: string; owner_id: string; kind: 'quarterly' | 'next_action';
  /** `YYYY-Qn` for quarterly touches, null for one-off next actions. */
  quarter: string | null; due_at: string; status: 'open' | 'done' | 'cancelled';
};
export type NewTask = Omit<OutreachTask, 'id' | 'status'>;

const QUARTER = /^(\d{4})-Q([1-4])$/;
const pad = (n: number) => String(n).padStart(2, '0');
const offsetMs = (offset: string) => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new RangeError('Expected ±HH:MM offset');
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
};

/** Calendar quarter (`YYYY-Qn`) of an instant in the given local offset (CIC: Phoenix, -07:00). */
export function quarterOf(timestamp: string, offset: string): string {
  const local = new Date(Number(instant(timestamp) / 1000n) + offsetMs(offset));
  return `${local.getUTCFullYear()}-Q${Math.floor(local.getUTCMonth() / 3) + 1}`;
}

/** Half-open local window [first day of the quarter, first day of the next quarter). */
export function quarterWindow(quarter: string, offset: string): { from: string; to: string } {
  const m = QUARTER.exec(quarter);
  if (!m) throw new RangeError('Expected YYYY-Qn');
  const year = Number(m[1]), start = (Number(m[2]) - 1) * 3 + 1;
  const window = {
    from: `${m[1]}-${pad(start)}-01T00:00:00${offset}`,
    to: start === 10 ? `${year + 1}-01-01T00:00:00${offset}` : `${m[1]}-${pad(start + 3)}-01T00:00:00${offset}`,
  };
  instant(window.from); instant(window.to); // validates the offset
  return window;
}

/**
 * One quarterly touch per eligible donor per quarter (plan p. 07): active, owned, consent not denied,
 * and no quarterly task of any status already exists for that donor and quarter. Due at quarter end.
 */
export function planQuarterlyTouches(donors: readonly OutreachDonor[], existing: readonly OutreachTask[],
  options: { quarter: string; offset: string }) {
  const { to } = quarterWindow(options.quarter, options.offset);
  const planned = new Set(existing.filter((t) => t.kind === 'quarterly' && t.quarter === options.quarter).map((t) => t.donor_id));
  const create: NewTask[] = [];
  const skipped = { archived: [] as string[], no_owner: [] as string[], consent_denied: [] as string[], already_planned: [] as string[] };
  for (const d of [...donors].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (d.archived_at !== null) skipped.archived.push(d.id);
    else if (d.owner_id === null) skipped.no_owner.push(d.id);
    else if (d.consent === 'denied') skipped.consent_denied.push(d.id);
    else if (planned.has(d.id)) skipped.already_planned.push(d.id);
    else create.push({ donor_id: d.id, owner_id: d.owner_id, kind: 'quarterly', quarter: options.quarter, due_at: to });
  }
  return { create, skipped };
}

const WEEK_US = 7n * 86_400n * 1_000_000n;

/** Open tasks split by urgency relative to `now`; optionally only one owner's. Sorted by due date. */
export function buildQueue(tasks: readonly OutreachTask[], options: { now: string; ownerId?: string }) {
  const now = instant(options.now);
  const open = tasks
    .filter((t) => t.status === 'open' && (options.ownerId === undefined || t.owner_id === options.ownerId))
    .map((t) => ({ t, due: instant(t.due_at) }))
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.t.id < b.t.id ? -1 : 1));
  return {
    overdue: open.filter(({ due }) => due < now).map(({ t }) => t),
    due_this_week: open.filter(({ due }) => due >= now && due < now + WEEK_US).map(({ t }) => t),
    upcoming: open.filter(({ due }) => due >= now + WEEK_US).map(({ t }) => t),
  };
}

/** IDs of open quarterly touches a logged contact completes: same donor, same local quarter, qualifying only. */
export function tasksClosedBy(tasks: readonly OutreachTask[],
  contact: { donor_id: string; occurred_at: string; qualifying: boolean }, offset: string): string[] {
  if (!contact.qualifying) return [];
  const quarter = quarterOf(contact.occurred_at, offset);
  return tasks.filter((t) => t.status === 'open' && t.kind === 'quarterly' && t.donor_id === contact.donor_id &&
    t.quarter === quarter).map((t) => t.id);
}

/** When a donor's owner changes, their open tasks follow; completed history keeps its original owner. */
export function reassignOpenTasks(tasks: readonly OutreachTask[], donorId: string, newOwnerId: string) {
  return tasks.filter((t) => t.status === 'open' && t.donor_id === donorId && t.owner_id !== newOwnerId)
    .map((t) => ({ id: t.id, owner_id: newOwnerId }));
}
