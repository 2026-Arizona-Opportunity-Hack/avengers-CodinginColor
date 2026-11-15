import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import test from 'node:test';
import { smoke } from '../deploy/smoke.ts';

async function serve(t: test.TestContext, handler: RequestListener) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const json = (res: Parameters<RequestListener>[1], status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
};
const html = (res: Parameters<RequestListener>[1]) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<app-root>');

test('a correct full-stack deploy passes every check', async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.headers.origin === 'https://evil.example') return json(res, 403, { error: 'Request rejected' });
    if (req.url === '/healthz') return json(res, 200, { status: 'ok' });
    if (req.url === '/config.json') return json(res, 200, { apiBase: '', clerkPublishableKey: 'pk_test_abc' });
    if (req.url === '/api/v1/me') return json(res, 401, { error: 'Request rejected' });
    if (req.url?.startsWith('/api/')) return json(res, 404, { error: 'Request rejected' });
    html(res);
  });
  const results = await smoke(base);
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.ok(results.length >= 7);
});

test('a static-only deploy (SPA fallback everywhere) fails the API and config checks', async (t) => {
  const base = await serve(t, (_req, res) => html(res));
  const failed = (await smoke(base)).filter((r) => !r.ok).map((r) => r.name);
  for (const name of ['healthz', 'config.json', 'api auth', 'api origin', 'api 404']) assert.ok(failed.includes(name), name);
});

test('a config.json carrying a secret key fails without echoing it', async (t) => {
  const base = await serve(t, (req, res) => req.url === '/config.json'
    ? json(res, 200, { apiBase: '', clerkPublishableKey: 'sk_test_SECRET' }) : html(res));
  const config = (await smoke(base)).find((r) => r.name === 'config.json')!;
  assert.equal(config.ok, false);
  assert.ok(!config.detail.includes('SECRET'), config.detail);
});
