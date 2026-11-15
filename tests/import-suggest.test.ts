import assert from 'node:assert/strict';
import test from 'node:test';
import { readSuggestion, suggestionRequest, suggestColumn } from '../tools/import-suggest.ts';

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
  assert.match(question.instructions, /Contribution Value/);
});

test('a low-confidence or unknown answer is a proposal, never an applied mapping', () => {
  const low = readSuggestion({ answers: { column: { type: 'choice', choice: 'amount_decimal',
    probabilities: { amount_decimal: 0.51, unknown: 0.49 }, confidence: 0.51 } } });
  assert.equal(low.accepted, false);
  assert.equal(low.target, 'amount_decimal');
  const unknown = readSuggestion({ answers: { column: { type: 'choice', choice: 'unknown',
    probabilities: { unknown: 0.9 }, confidence: 0.9 } } });
  assert.equal(unknown.accepted, false);
  const sure = readSuggestion({ answers: { column: { type: 'choice', choice: 'amount_decimal',
    probabilities: { amount_decimal: 0.93, unknown: 0.07 }, confidence: 0.86 } } });
  assert.deepEqual(sure, { accepted: true, target: 'amount_decimal', confidence: 0.86 });
});

test('a response outside the allowlist or without a confidence is rejected', () => {
  assert.throws(() => readSuggestion({ answers: { column: { type: 'choice', choice: 'owner_id',
    probabilities: { owner_id: 1 }, confidence: 0.99 } } }), /Invalid column suggestion/);
  assert.throws(() => readSuggestion({ answers: { column: { type: 'choice', choice: 'email',
    probabilities: { email: 1 } } } }), /Invalid column suggestion/);
  assert.throws(() => readSuggestion({ answers: {} }), /Invalid column suggestion/);
});

test('a missing API key fails before any request', async () => {
  const previous = process.env.JEV_API_KEY;
  delete process.env.JEV_API_KEY;
  try {
    await assert.rejects(suggestColumn({ header: 'Gift Amt', samples: ['10.00'] }, () => {
      throw new Error('network');
    }), /JEV_API_KEY/);
  } finally {
    if (previous === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = previous;
  }
});
