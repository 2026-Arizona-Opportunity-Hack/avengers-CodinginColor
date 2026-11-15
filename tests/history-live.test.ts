import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGifts, loadContacts, logContact } from '../apps/web/src/app/core/history-live.ts';
import type { Request } from '../apps/web/src/app/core/outreach-live.ts';

test('live history fetches every page and preserves exact cents and currency', async () => {
  const calls: string[] = [];
  const gift = { id: 'gift', amount_cents: 1234, currency: 'EUR', source: 'benevity' };
  const request = (async (path: string) => { calls.push(path); return { items: path.endsWith('offset=0')
    ? Array.from({ length: 100 }, () => gift) : [{ ...gift, id: 'last' }] }; }) as Request;
  const gifts = await loadGifts(request);
  assert.equal(gifts.length, 101);
  assert.equal(gifts[100].id, 'last'); assert.equal(gifts[0].amount_cents, 1234); assert.equal(gifts[0].currency, 'EUR');
  assert.deepEqual(calls, ['/api/v1/gifts?limit=100&offset=0', '/api/v1/gifts?limit=100&offset=100']);
});

test('live contacts retain failures, approval links and manual notes without inventing deliveries', async () => {
  const base = { id: 'contact', donor_id: 'donor', draft_id: null, actor_id: 'member', channel: 'sms', status: 'logged_contact',
    note: 'Called\nVisit soon', occurred_at: '2026-11-15T19:00:00Z', subject: null, body: null };
  const contacts = await loadContacts((async () => ({ items: [base, { ...base, id: 'failed', channel: 'email',
    status: 'failed', subject: 'Update', body: 'Message', draft_id: 'draft' }] })) as Request);
  assert.equal(contacts[0].kind, 'text'); assert.equal(contacts[0].summary, 'Called');
  assert.equal(contacts[0].body, 'Called\nVisit soon');
  assert.equal(contacts[1].status, 'failed'); assert.equal(contacts[1].summary, 'Failed: Update');
  assert.equal(contacts[1].draft_id, 'draft');
  let payload: unknown;
  await logContact((async (path: string, init: RequestInit) => {
    assert.equal(path, '/api/v1/donors/donor%2Fid/communications'); payload = JSON.parse(String(init.body)); return {};
  }) as Request, 'donor/id', 'text', base.occurred_at, base.note);
  assert.deepEqual(payload, { channel: 'sms', occurred_at: base.occurred_at, note: base.note });
});
