import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_VOICE, proposeJson } from './ai.ts';

const config = { baseUrl: 'https://provider.example/v1/', key: 'test-only', model: 'gpt-test' };
const request = { purpose: 'Classify allowed intent', schema: { type: 'object', additionalProperties: false }, data: { intent: 'lapsed' } };
const reply = (content: string, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content } }] }));
test('optional JSON advice is bounded, structured and separate from trusted instructions', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls++; assert.equal(String(url), 'https://provider.example/v1/chat/completions');
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /No em dashes/); assert.equal(body.messages[1].content, JSON.stringify(request.data));
    assert.equal(body.response_format.json_schema.strict, true); assert.equal(body.max_completion_tokens, 500);
    assert.equal(body.reasoning_effort, 'none'); return reply('{"segment":"lapsed"}');
  };
  assert.deepEqual(await proposeJson(request, { config, fetchImpl }), { segment: 'lapsed' });
  for (const bad of [{ ...config, key: '' }, { ...config, model: '' }, { ...config, baseUrl: 'http://example.org/v1' }])
    assert.equal(await proposeJson(request, { config: bad, fetchImpl }), null);
  assert.equal(await proposeJson({ ...request, data: 'x'.repeat(17000) }, { config, fetchImpl }), null);
  assert.equal(calls, 1); assert.ok(AI_VOICE.includes('Never invent'));
});
test('provider failures, truncated/invalid JSON and oversized responses fall back without leaking errors', async () => {
  for (const response of [new Response('private', { status: 500 }), reply('{}', 'length'), reply('not json'), new Response('x'.repeat(33000))])
    assert.equal(await proposeJson(request, { config, fetchImpl: async () => response }), null);
  assert.equal(await proposeJson(request, { config, fetchImpl: async () => { throw new Error('private credential'); } }), null);
});
