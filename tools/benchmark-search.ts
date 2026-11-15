// Opt-in provider benchmark: synthetic database and identity; never deployed/Clerk acceptance.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import express, { type ErrorRequestHandler } from 'express';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { askData } from '../apps/api/ask-data.ts';
import { proposeJson } from '../apps/api/ai.ts';
import { EnvSchema, HttpError } from '../apps/api/env.ts';
import type { Database } from '../apps/api/db.ts';
import { migrate } from '../db/migrate.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Filters = z.strictObject({ scope: z.enum(['visible', 'mine']), currency: z.string().regex(/^[A-Z]{3}$/),
  period: z.enum(['this_year', 'last_year']), segment: z.enum(['new', 'reactivated', 'increased', 'flat', 'decreased', 'lapsed', 'retained']).nullable(),
  minimum_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(), status: z.enum(['settled', 'pending', 'void']).nullable() });
type Filter = z.infer<typeof Filters>;
type Case = { name: string; question: string; who: 'admin' | 'board'; filters: Filter | null; donors: number[] };
const visible: Filter = { scope: 'visible', currency: 'USD', period: 'this_year', segment: null, minimum_cents: null, status: null };
const cases: Case[] = [
  { name: 'own-portfolio', question: 'show my donors', who: 'board', filters: { ...visible, scope: 'mine' }, donors: [20, 22, 23, 24] },
  { name: 'strict-refund-threshold', question: 'donors over $100 in USD', who: 'board', filters: { ...visible, minimum_cents: 10000 }, donors: [] },
  { name: 'fractional-threshold', question: 'donors over $99.99 in USD', who: 'board', filters: { ...visible, minimum_cents: 9999 }, donors: [20] },
  { name: 'currency-isolation', question: 'donors over $100 in EUR', who: 'board', filters: { ...visible, currency: 'EUR', minimum_cents: 10000 }, donors: [20] },
  { name: 'admin-portfolio', question: 'all donors', who: 'admin', filters: visible, donors: [20, 21, 22, 23, 24] },
  { name: 'lapsed-portfolio', question: 'show my lapsed donors', who: 'board', filters: { ...visible, scope: 'mine', segment: 'lapsed' }, donors: [23] },
  { name: 'pending-status', question: 'donors with pending gifts', who: 'board', filters: { ...visible, status: 'pending' }, donors: [24] },
  { name: 'admin-threshold', question: 'donors over $100 in USD', who: 'admin', filters: { ...visible, minimum_cents: 10000 }, donors: [21] },
  { name: 'personal-name-clarification', question: 'show donors named Avery', who: 'admin', filters: null, donors: [] },
  { name: 'currency-only-clarification', question: 'donors in EUR', who: 'admin', filters: null, donors: [] },
  { name: 'sql-injection-clarification', question: 'donors; SELECT * FROM memberships', who: 'admin', filters: null, donors: [] },
  { name: 'ambiguous-status-threshold', question: 'pending donors over $100', who: 'admin', filters: null, donors: [] },
];
type Measurement = { case: string; repeat: number; http_ms: number; provider_ms: number | null;
  provider: 'not-called' | 'unavailable' | 'invalid-schema' | 'changed-filters' | 'ordering-mismatch' | 'accepted'; semantic_echo: boolean; serialized_echo: boolean };
const rounded = (n: number) => Math.round(n * 100) / 100;
function timing(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  assert.ok(sorted.length);
  return { min_ms: rounded(sorted[0]), p50_ms: rounded(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95_ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]), max_ms: rounded(sorted.at(-1)!) };
}

let phase = 'configuration', activeCase = 'none';
async function benchmark() {
  const config = { baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    key: process.env.OPENAI_API_KEY ?? '', model: process.env.OPENAI_MODEL ?? '' };
  const origin = new URL(config.baseUrl);
  assert.ok(config.key && config.model && origin.protocol === 'https:' && !origin.username && !origin.password && !origin.search && !origin.hash);
  const sql = new PGlite();
  let server: ReturnType<express.Express['listen']> | undefined;
  const measurements: Measurement[] = [];
  let current: Case | undefined, measurement: Measurement | undefined;
  try {
    phase = 'synthetic-fixture';
    await migrate({ query: async (q, v) => v ? sql.query(q, v) : (await sql.exec(q)).at(-1)! },
      fileURLToPath(new URL('../db/migrations/', import.meta.url)));
    const year = new Date(Date.now() - 7 * 3600_000).getUTCFullYear();
    await sql.exec(`INSERT INTO organizations(id,name) VALUES('${id(1)}','Synthetic CIC');
      INSERT INTO memberships(id,org_id,clerk_subject,role) VALUES
      ('${id(10)}','${id(1)}','admin','admin'),('${id(11)}','${id(1)}','board','board'),('${id(12)}','${id(1)}','other-board','board');
      INSERT INTO donors(id,org_id,owner_id,name,consent,metadata) VALUES
      ('${id(20)}','${id(1)}','${id(11)}','Alpha','unknown','{}'),
      ('${id(21)}','${id(1)}','${id(12)}','Beta','unknown','{}'),
      ('${id(22)}','${id(1)}','${id(11)}','No history','unknown','{}'),
      ('${id(23)}','${id(1)}','${id(11)}','Dormant','unknown','{}'),
      ('${id(24)}','${id(1)}','${id(11)}','Pending','unknown','{}');
      INSERT INTO gifts(org_id,donor_id,amount_cents,refund_cents,currency,status,occurred_at,source) VALUES
      ('${id(1)}','${id(20)}',10029,29,'USD','settled','${year}-01-01T07:00:00Z','manual'),
      ('${id(1)}','${id(20)}',20000,0,'EUR','settled','${year}-01-01T07:00:00Z','manual'),
      ('${id(1)}','${id(21)}',30000,0,'USD','settled','${year}-01-01T07:00:00Z','manual'),
      ('${id(1)}','${id(23)}',5000,0,'USD','settled','${year - 1}-01-01T07:00:00Z','manual'),
      ('${id(1)}','${id(24)}',1000,0,'USD','pending','${year}-01-01T07:00:00Z','manual');
      CREATE ROLE benchmark_login NOLOGIN NOINHERIT; GRANT cic_runtime TO benchmark_login; SET SESSION AUTHORIZATION benchmark_login;`);
    const db: Database = { connect: async () => ({ query: (q, v) => sql.query<Record<string, unknown>>(q, v), release() {} }) };
    const env = EnvSchema.parse({ DATABASE_URL: 'postgresql://localhost/synthetic', CIC_ORG_ID: id(1),
      CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev', APP_ORIGIN: 'http://localhost:4200' });
    const app = express();
    app.use(askData(env, db, async h => {
      assert.ok(h === 'Bearer admin' || h === 'Bearer board');
      return { subject: h.slice(7), mfa: h === 'Bearer admin' };
    }, async request => {
      assert.ok(current?.filters && measurement);
      assert.deepEqual(request.data, current.filters, 'provider input must contain only expected nonpersonal filters');
      const start = performance.now();
      const advice = await proposeJson(request, { config });
      measurement.provider_ms = rounded(performance.now() - start);
      const parsed = Filters.safeParse(advice);
      measurement.semantic_echo = parsed.success && isDeepStrictEqual(parsed.data, current.filters);
      measurement.serialized_echo = parsed.success && JSON.stringify(parsed.data) === JSON.stringify(request.data);
      measurement.provider = advice === null ? 'unavailable' : !parsed.success ? 'invalid-schema'
        : !measurement.semantic_echo ? 'changed-filters' : measurement.serialized_echo ? 'accepted' : 'ordering-mismatch';
      return advice;
    }));
    const errors: ErrorRequestHandler = (_error, _req, res, _next) => res.status(503).json({ error: 'benchmark request failed' });
    app.use(errors);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    phase = 'http-correctness';
    for (let repeat = 1; repeat <= 2; repeat++) for (const scenario of cases) {
      current = scenario; activeCase = scenario.name;
      measurement = { case: scenario.name, repeat, http_ms: 0, provider_ms: null, provider: 'not-called', semantic_echo: false, serialized_echo: false };
      const start = performance.now();
      const response: Response = await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scenario.who}` },
        body: JSON.stringify({ question: scenario.question }) });
      const answer = await response.json() as { needs_clarification: boolean; filters?: Filter; donors: { id: string }[]; total?: number };
      measurement.http_ms = rounded(performance.now() - start);
      assert.equal(response.status, 200);
      assert.equal(answer.needs_clarification, scenario.filters === null);
      assert.deepEqual(answer.donors.map(d => d.id).sort(), scenario.donors.map(id).sort());
      if (scenario.filters) { assert.deepEqual(answer.filters, scenario.filters); assert.equal(answer.total, scenario.donors.length); assert.notEqual(measurement.provider, 'not-called'); }
      else { assert.equal(measurement.provider, 'not-called'); assert.equal(answer.filters, undefined); }
      measurements.push(measurement);
    }
    phase = 'read-only-check';
    await sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
    assert.equal((await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events')).rows[0].n, 0);
    assert.equal((await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM donors')).rows[0].n, 5);
    assert.equal((await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM gifts')).rows[0].n, 5);
    const provider = measurements.filter(m => m.provider_ms !== null);
    assert.equal(provider.length, 16); assert.equal(measurements.length, 24);
    console.log(JSON.stringify({ mode: 'synthetic PGlite, loopback HTTP, synthetic identity; not deployed or Clerk acceptance',
      measured_at: new Date().toISOString(), model: config.model, provider_origin: origin.origin,
      correctness: { passed: measurements.length, total: 24, filter_and_result_cases: 16, clarification_cases: 8 },
      http: timing(measurements.map(m => m.http_ms)), recognized_http: timing(provider.map(m => m.http_ms)),
      provider: { calls: provider.length, semantic_echoes: provider.filter(m => m.semantic_echo).length,
        accepted: provider.filter(m => m.provider === 'accepted').length, fallback: provider.filter(m => m.provider !== 'accepted').length,
        unavailable: provider.filter(m => m.provider === 'unavailable').length, invalid_schema: provider.filter(m => m.provider === 'invalid-schema').length,
        changed_filters: provider.filter(m => m.provider === 'changed-filters').length,
        ordering_mismatch: provider.filter(m => m.provider === 'ordering-mismatch').length, ...timing(provider.map(m => m.provider_ms!)) },
      measurements }, null, 2));
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
    await sql.close();
  }
}

if (import.meta.main) benchmark().catch(() => {
  console.error(JSON.stringify({ error: 'Search benchmark failed; no acceptance claimed.', phase, case: activeCase }));
  process.exitCode = 1;
});
