import assert from 'node:assert/strict';
import test from 'node:test';
import { readSuggestion, suggestionRequest, suggestColumn, suggestAmbiguous } from '../tools/import-suggest.ts';
import { previewCsv } from '../tools/import-preview.ts';

const targets = ['first_name', 'last_name', 'email', 'phone', 'company', 'amount_cents', 'amount_decimal',
  'contact_person', 'campaign', 'occurred_at', 'currency', 'external_id', 'ignore', 'unknown'];

test('a suggestion request asks one choice question and sends no donor rows', () => {
  const body = suggestionRequest([{ header: 'Contribution Value', samples: ['12.34', '40.00'] }]);
  assert.equal(body.model, 'jev-latest');
  assert.equal(typeof body.state, 'string');
  assert.doesNotMatch(body.state, /@|12\.34/);
  const question = body.questions.column;
  assert.equal(question.type, 'choice');
  assert.deepEqual(Object.keys(question.criteria).sort(), [...targets].sort());
  assert.doesNotMatch(question.instructions, /Contribution Value/);
  assert.equal(body.state, JSON.stringify(['Contribution Value']));
});

test('a suggestion request requires exactly one bounded nonempty header', () => {
  for (const columns of [[], [
    { header: 'A', samples: [] }, { header: 'B', samples: [] },
  ], [{ header: 'x'.repeat(301), samples: [] }], [{ header: '  ', samples: [] }]]) {
    assert.throws(() => suggestionRequest(columns), /Invalid column suggestion request/);
  }
});

test('a low-confidence or unknown answer is a proposal, never an applied mapping', () => {
  const low = readSuggestion({ answers: { column: { type: 'choice', choice: 'amount_decimal',
    probabilities: { amount_decimal: 0.51, unknown: 0.49 }, confidence: 0.51 } } });
  assert.equal(low.approval_required, true);
  assert.equal(low.target, 'amount_decimal');
  const unknown = readSuggestion({ answers: { column: { type: 'choice', choice: 'unknown',
    probabilities: { unknown: 0.9 }, confidence: 0.9 } } });
  assert.equal(unknown.approval_required, true);
  const sure = readSuggestion({ answers: { column: { type: 'choice', choice: 'amount_decimal',
    probabilities: { amount_decimal: 0.93, unknown: 0.07 }, confidence: 0.86 } } });
  assert.deepEqual(sure, { approval_required: true, target: 'amount_decimal', confidence: 0.86 });
  assert.equal('accepted' in sure, false);
});

test('known columns use deterministic mappings before any external suggestion', async () => {
  const preview = { headers: ['first name', 'Gift Amt'], mapping: ['first_name', null],
    issues: [{ recordNumber: null, field: 'Gift Amt', code: 'unmapped_column' }] };
  let calls = 0;
  const results = await suggestAmbiguous(preview, async column => { calls++;
    assert.equal(column.header, 'Gift Amt');
    return { approval_required: true, target: 'amount_decimal', confidence: 0.9 };
  });
  assert.equal(calls, 1);
  assert.deepEqual(results, [{ header: 'Gift Amt', approval_required: true, target: 'amount_decimal', confidence: 0.9 }]);
});

test('explicitly ignored columns never leave the machine for suggestion', async () => {
  const preview = previewCsv('first name,Ignore Me,Contribution Value\nAvery,private,12.34',
    'spreadsheet', 'local.csv', { 'Ignore Me': null });
  const sent: string[] = [];
  await suggestAmbiguous(preview, async column => {
    sent.push(column.header);
    return { approval_required: true, target: 'amount_decimal', confidence: 0.9 };
  });
  assert.deepEqual(sent, ['Contribution Value']);
});

test('a response outside the allowlist or without a confidence is rejected', () => {
  assert.throws(() => readSuggestion({ answers: { column: { type: 'choice', choice: 'owner_id',
    probabilities: { owner_id: 1 }, confidence: 0.99 } } }), /Invalid column suggestion/);
  assert.throws(() => readSuggestion({ answers: { column: { type: 'choice', choice: 'email',
    probabilities: { email: 1 } } } }), /Invalid column suggestion/);
  assert.throws(() => readSuggestion({ answers: {} }), /Invalid column suggestion/);
  for (const bad of [NaN, Infinity, -0.01, 1.01]) {
    assert.throws(() => readSuggestion({ answers: { column: { type: 'choice', choice: 'email',
      probabilities: { email: bad }, confidence: 0.9 } } }), /Invalid column suggestion/);
    assert.throws(() => readSuggestion({ answers: { column: { type: 'choice', choice: 'email',
      probabilities: { email: 0.9 }, confidence: bad } } }), /Invalid column suggestion/);
  }
  assert.throws(() => readSuggestion({ answers: { column: { type: 'choice', choice: 'email',
    probabilities: { email: 0.9, owner_id: 0.1 }, confidence: 0.9 } } }), /Invalid column suggestion/);
  assert.throws(() => readSuggestion({ answers: { column: { type: 'choice', choice: 'email',
    probabilities: { email: 0.9, unknown: 0.9 }, confidence: 0.9 } } }), /Invalid column suggestion/);
});

test('malformed response fails closed', () => {
  assert.throws(() => readSuggestion(null), /Invalid column suggestion/);
});

test('official endpoint, canonical key, request safety and errors are enforced', async () => {
  const oldPrimary = process.env.TYPESAFE_API_KEY;
  const oldLegacy = process.env.JEV_API_KEY;
  process.env.TYPESAFE_API_KEY = 'synthetic-primary';
  process.env.JEV_API_KEY = 'synthetic-legacy';
  try {
    let init: RequestInit | undefined;
    let url = '';
    await suggestColumn({ header: 'Gift Amt', samples: ['10.00', 'PRIVATE'] }, (async (input, options) => {
      url = String(input);
      init = options;
      return Response.json({ answers: { column: { type: 'choice', choice: 'amount_decimal',
        probabilities: { amount_decimal: 0.9 }, confidence: 0.9 } } });
    }) as typeof fetch);
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-primary');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.match(JSON.stringify(init?.body), /Gift Amt/);
    assert.doesNotMatch(JSON.stringify(init?.body), /10\.00|PRIVATE/);

    for (const failure of [
      () => Promise.resolve(new Response('synthetic-primary', { status: 500 })),
      () => Promise.resolve(Response.redirect('https://example.org/', 302)),
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
      () => Promise.reject(new Error('synthetic-primary network failure')),
    ]) {
      await assert.rejects(suggestColumn({ header: 'Gift Amt', samples: [] }, failure as typeof fetch),
        (error: Error) => !error.message.includes('synthetic-primary'));
    }
  } finally {
    if (oldPrimary === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldPrimary;
    if (oldLegacy === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = oldLegacy;
  }
});

test('missing key fails before fetch; legacy key remains supported', async () => {
  const oldPrimary = process.env.TYPESAFE_API_KEY;
  const oldLegacy = process.env.JEV_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_API_KEY;
  try {
    let called = false;
    await assert.rejects(suggestColumn({ header: 'Gift Amt', samples: [] }, (async () => {
      called = true;
      return Response.json({});
    }) as typeof fetch), /TYPESAFE_API_KEY/);
    assert.equal(called, false);

    process.env.JEV_API_KEY = 'synthetic-legacy';
    let authorization = '';
    await suggestColumn({ header: 'Gift Amt', samples: [] }, (async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({ answers: { column: { type: 'choice', choice: 'amount_decimal',
        probabilities: { amount_decimal: 0.9 }, confidence: 0.9 } } });
    }) as typeof fetch);
    assert.equal(authorization, 'Bearer synthetic-legacy');
  } finally {
    if (oldPrimary === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldPrimary;
    if (oldLegacy === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = oldLegacy;
  }
});
