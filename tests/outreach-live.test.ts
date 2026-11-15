import assert from 'node:assert/strict';
import test from 'node:test';
import * as live from '../apps/web/src/app/core/outreach-live.ts';

/** Records each call and answers from a path → response table, like the app's authenticated request(). */
function fake(responses: Record<string, unknown>) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const request = (async (path: string, init: RequestInit = {}) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (!(path in responses)) throw new Error(`unexpected ${path}`);
    return responses[path];
  }) as live.Request;
  return { request, calls };
}
const A = '00000000-0000-4000-8000-000000000001', D = '00000000-0000-4000-8000-000000000040';

test('local dates use the Phoenix offset, so an evening task is not shown as tomorrow', () => {
  assert.equal(live.localDate('2026-11-16T03:00:00.000000Z'), '2026-11-15');
  assert.equal(live.localDate('2026-11-15T16:00:00.000000Z'), '2026-11-15');
  assert.throws(() => live.localDate('not a time'), /Invalid/);
});

test('follow-ups load most urgent first and map to the page model', async () => {
  const task = (n: string, kind: 'quarterly' | 'next_action', due: string) => ({ id: n, donor_id: D, owner_id: A, kind,
    quarter: kind === 'quarterly' ? '2026-Q4' : null, title: `t${n}`, status: 'open' as const, due_at: due, donor_name: 'Avery' });
  const { request, calls } = fake({ '/api/v1/follow-ups?scope=all': {
    overdue: [task('1', 'next_action', '2026-11-12T16:00:00.000000Z')],
    due_this_week: [task('2', 'next_action', '2026-11-17T16:00:00.000000Z')],
    upcoming: [task('3', 'quarterly', '2027-01-01T06:59:59.999999Z')] } });
  const items = await live.loadFollowUps(request, 'all');
  assert.deepEqual(calls.map((c) => c.path), ['/api/v1/follow-ups?scope=all']);
  assert.deepEqual(items.map((f) => [f.id, f.kind, f.due_on, f.action, f.status]), [
    ['1', 'next_step', '2026-11-12', 't1', 'open'], ['2', 'next_step', '2026-11-17', 't2', 'open'],
    ['3', 'quarterly', '2026-12-31', 't3', 'open']]);
  assert.equal(live.toFollowUp({ ...task('4', 'next_action', '2026-11-12T16:00:00Z'), status: 'cancelled' }).status, 'dismissed');
});

test('drafts map server states and channels onto the page model', async () => {
  const row = { id: 'd1', donor_id: D, author_id: A, channel: 'sms' as const, recipient: '+16025550100', subject: null,
    body: 'Hi', status: 'failed' as const, approved_by: null, approved_at: null, created_at: '2026-11-15T16:00:00.000000Z' };
  const { request } = fake({ '/api/v1/drafts': { items: [row, { ...row, id: 'd2', channel: 'email', subject: 'S', status: 'logged' }] } });
  const drafts = await live.loadDrafts(request);
  assert.deepEqual(drafts.map((d) => [d.id, d.channel, d.subject, d.status, d.to]), [
    ['d1', 'text', '', 'pending', '+16025550100'], ['d2', 'email', 'S', 'sent', '+16025550100']]);
});

test('draft writes call the reviewed routes; unsupported templates never draft', async () => {
  const { request, calls } = fake({
    '/api/v1/drafts': { id: 'd1', channel: 'email', recipient: 'a@example.org', subject: 'Thanks', body: 'Hi', status: 'draft' },
    '/api/v1/drafts/d1': { id: 'd1', status: 'draft' }, '/api/v1/drafts/d1/approve': { id: 'd1', status: 'approved' },
    '/api/v1/drafts/d1/compose': { href: 'mailto:a%40example.org?subject=Thanks&body=Hi' },
    '/api/v1/drafts/d1/manual-send': { status: 'logged', closed_follow_ups: 1, already_logged: false } });
  const fields = { first_name: 'Avery', amount: '$50.00', program: 'AI Academy' };
  const draft = await live.createLiveDraft(request, D, 't-thanks-email', fields);
  assert.deepEqual([draft?.id, draft?.status, draft?.template_id, draft?.donor_id], ['d1', 'pending', 't-thanks-email', D]);
  assert.equal(await live.createLiveDraft(request, D, 't-nudge', {}), null);
  await live.editLiveDraft(request, 'd1', { body: 'Hi again' });
  await live.approveLiveDraft(request, 'd1');
  assert.equal(await live.composeHref(request, 'd1'), 'mailto:a%40example.org?subject=Thanks&body=Hi');
  assert.equal((await live.logManualSend(request, 'd1')).closed_follow_ups, 1);
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ['POST', '/api/v1/drafts', { donor_id: D, template: 'thank_you', fields }],
    ['PATCH', '/api/v1/drafts/d1', { body: 'Hi again' }],
    ['POST', '/api/v1/drafts/d1/approve', undefined],
    ['GET', '/api/v1/drafts/d1/compose', undefined],
    ['POST', '/api/v1/drafts/d1/manual-send', { confirmed: true }]]);
});

test('follow-up writes and API keys use the server; the raw key is returned once, apart from the record', async () => {
  const { request, calls } = fake({
    '/api/v1/follow-ups': { id: 'f9', donor_id: D, owner_id: A, kind: 'next_action', title: 'Call', status: 'open',
      due_at: '2026-11-18T16:00:00.000000Z' },
    '/api/v1/follow-ups/f%2F9/complete': { id: 'f/9', status: 'done' },
    '/api/v1/follow-ups/quarterly': { created: 26, skipped: { declined: 1 } },
    '/api/v1/api-keys': { id: 'k1', name: 'Board dashboard', hint: 'cic_ab12', key: 'cic_FULLSECRET' },
    '/api/v1/api-keys/k1/revoke': { id: 'k1', revoked_at: '2026-11-15T16:00:00.000000Z' } });
  assert.equal((await live.addNextStep(request, D, 'Call', '2026-11-18T09:00:00-07:00')).due_on, '2026-11-18');
  await live.completeFollowUp(request, 'f/9');
  assert.equal((await live.planQuarter(request, '2026-Q4')).created, 26);
  const issued = await live.issueApiKey(request, 'Board dashboard', A);
  assert.equal(issued.secret, 'cic_FULLSECRET');
  assert.deepEqual([issued.key.label, issued.key.prefix, issued.key.revoked_at], ['Board dashboard', 'cic_ab12', null]);
  assert.ok(!JSON.stringify(issued.key).includes('FULLSECRET'));
  await live.revokeApiKey(request, 'k1');
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [['POST', '/api/v1/follow-ups'],
    ['POST', '/api/v1/follow-ups/f%2F9/complete'], ['POST', '/api/v1/follow-ups/quarterly'],
    ['POST', '/api/v1/api-keys'], ['POST', '/api/v1/api-keys/k1/revoke']]);
  assert.deepEqual(calls[0].body, { donor_id: D, title: 'Call', due_at: '2026-11-18T09:00:00-07:00' });
});
