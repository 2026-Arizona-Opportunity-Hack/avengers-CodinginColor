import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildQueue, planQuarterlyTouches, quarterOf, quarterWindow, reassignOpenTasks, tasksClosedBy,
  type OutreachDonor, type OutreachTask,
} from './queue.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const OWNER_A = id(100), OWNER_B = id(101);
const PHX = '-07:00';
const donor = (n: number, extra: Partial<OutreachDonor> = {}): OutreachDonor =>
  ({ id: id(n), owner_id: OWNER_A, consent: 'granted', archived_at: null, ...extra });
const task = (n: number, extra: Partial<OutreachTask> = {}): OutreachTask => ({
  id: id(500 + n), donor_id: id(n), owner_id: OWNER_A, kind: 'quarterly', quarter: '2026-Q4',
  due_at: '2027-01-01T00:00:00-07:00', status: 'open', ...extra,
});

test('quarters follow CIC local time and windows are half-open', () => {
  assert.equal(quarterOf('2026-03-31T23:30:00-07:00', PHX), '2026-Q1');
  assert.equal(quarterOf('2026-04-01T06:30:00Z', PHX), '2026-Q1');   // still Mar 31 in Phoenix
  assert.equal(quarterOf('2026-04-01T07:00:00Z', PHX), '2026-Q2');
  assert.deepEqual(quarterWindow('2026-Q2', PHX), { from: '2026-04-01T00:00:00-07:00', to: '2026-07-01T00:00:00-07:00' });
  assert.deepEqual(quarterWindow('2026-Q4', PHX), { from: '2026-10-01T00:00:00-07:00', to: '2027-01-01T00:00:00-07:00' });
  for (const bad of ['2026-Q5', '2026-Q0', '26-Q1', '2026Q1']) assert.throws(() => quarterWindow(bad, PHX), bad);
  for (const bad of ['2026-02-30T00:00:00Z', '2026-03-01']) assert.throws(() => quarterOf(bad, PHX), bad);
});

test('quarterly touches: one per eligible donor per quarter, with skipped donors explained', () => {
  const donors = [
    donor(1), donor(2, { consent: 'unknown' }), donor(3, { consent: 'denied' }),
    donor(4, { archived_at: '2026-06-01T00:00:00Z' }), donor(5, { owner_id: null }),
    donor(6), donor(7, { owner_id: OWNER_B }),
  ];
  const existing = [
    task(6, { status: 'done' }),                                          // already touched this quarter
    task(7, { quarter: '2026-Q3', due_at: '2026-10-01T00:00:00-07:00' }), // last quarter doesn't count
  ];
  const plan = planQuarterlyTouches(donors, existing, { quarter: '2026-Q4', offset: PHX });
  assert.deepEqual(plan.create, [
    { donor_id: id(1), owner_id: OWNER_A, kind: 'quarterly', quarter: '2026-Q4', due_at: '2027-01-01T00:00:00-07:00' },
    { donor_id: id(2), owner_id: OWNER_A, kind: 'quarterly', quarter: '2026-Q4', due_at: '2027-01-01T00:00:00-07:00' },
    { donor_id: id(7), owner_id: OWNER_B, kind: 'quarterly', quarter: '2026-Q4', due_at: '2027-01-01T00:00:00-07:00' },
  ]);
  assert.deepEqual(plan.skipped, { consent_denied: [id(3)], archived: [id(4)], no_owner: [id(5)], already_planned: [id(6)] });
  // Re-running after the tasks exist creates nothing.
  const after = [...existing, ...plan.create.map((c, i) => ({ ...c, id: id(900 + i), status: 'open' as const }))];
  assert.deepEqual(planQuarterlyTouches(donors, after, { quarter: '2026-Q4', offset: PHX }).create, []);
});

test('the queue splits open tasks into overdue, due this week and upcoming, by owner', () => {
  const now = '2026-11-14T12:00:00-07:00';
  const tasks = [
    task(1, { kind: 'next_action', quarter: null, due_at: '2026-11-13T09:00:00-07:00' }),          // overdue
    task(2, { kind: 'next_action', quarter: null, due_at: '2026-11-19T09:00:00-07:00' }),          // this week
    task(3, { kind: 'next_action', quarter: null, due_at: '2026-11-21T12:00:00-07:00' }),          // exactly +7d: upcoming
    task(4),                                                                                        // quarterly, upcoming
    task(5, { kind: 'next_action', quarter: null, due_at: '2026-11-10T09:00:00-07:00', status: 'done' }),
    task(6, { kind: 'next_action', quarter: null, due_at: '2026-11-12T09:00:00-07:00', owner_id: OWNER_B }),
  ];
  const mine = buildQueue(tasks, { now, ownerId: OWNER_A });
  assert.deepEqual({ overdue: mine.overdue.map((t) => t.id), due_this_week: mine.due_this_week.map((t) => t.id),
    upcoming: mine.upcoming.map((t) => t.id) },
  { overdue: [id(501)], due_this_week: [id(502)], upcoming: [id(503), id(504)] });
  const everyone = buildQueue(tasks, { now });
  assert.deepEqual(everyone.overdue.map((t) => t.id), [id(506), id(501)]);
  assert.throws(() => buildQueue(tasks, { now: 'yesterday' }));
});

test('only a qualifying logged contact closes that quarter\'s open touch for that donor', () => {
  const tasks = [
    task(1), task(1, { id: id(601), quarter: '2026-Q3', due_at: '2026-10-01T00:00:00-07:00' }),
    task(1, { id: id(602), kind: 'next_action', quarter: null, due_at: '2026-11-20T00:00:00-07:00' }),
    task(2), task(3, { status: 'done' }),
  ];
  const contact = { donor_id: id(1), occurred_at: '2026-11-14T10:00:00-07:00', qualifying: true };
  assert.deepEqual(tasksClosedBy(tasks, contact, PHX), [id(501)]);
  assert.deepEqual(tasksClosedBy(tasks, { ...contact, qualifying: false }, PHX), []);
  assert.deepEqual(tasksClosedBy(tasks, { ...contact, donor_id: id(3) }, PHX), []);
});

test('changing a donor\'s owner moves only that donor\'s open tasks', () => {
  const tasks = [task(1), task(1, { id: id(700), kind: 'next_action', quarter: null }),
    task(1, { id: id(701), status: 'done' }), task(2)];
  assert.deepEqual(reassignOpenTasks(tasks, id(1), OWNER_B),
    [{ id: id(501), owner_id: OWNER_B }, { id: id(700), owner_id: OWNER_B }]);
  assert.deepEqual(reassignOpenTasks(tasks, id(1), OWNER_A), []);
});
