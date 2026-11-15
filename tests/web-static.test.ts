import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { webApp } from '../src/web.ts';

async function serve(t: test.TestContext, dir: string) {
  const app = express().use(webApp(dir));
  app.use((_req, res) => { res.status(404).json({ error: 'Request rejected' }); }); // stands in for the API
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

test('the built web app, its config and deep links are served; API paths fall through', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cic-web-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<app-root></app-root>');
  await writeFile(join(dir, 'config.json'), '{"apiBase":"","clerkPublishableKey":"pk_test_x"}');
  await writeFile(join(dir, 'assets', 'main.js'), 'console.log(1)');
  await writeFile(join(dir, '.env'), 'SECRET=1');
  const get = await serve(t, dir);

  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(await home.text(), '<app-root></app-root>');
  const config = await get('/config.json');
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), { apiBase: '', clerkPublishableKey: 'pk_test_x' });
  assert.match(config.headers.get('cache-control') ?? '', /no-cache|no-store/);
  assert.equal(await (await get('/assets/main.js')).text(), 'console.log(1)');
  for (const deep of ['/donors', '/donors/123', '/index.html']) {
    const page = await get(deep, { headers: { Accept: 'text/html' } });
    assert.equal(page.status, 200, deep);
    assert.equal(await page.text(), '<app-root></app-root>', deep);
  }
  // API, health and unknown files never get the web app; dotfiles are never served.
  for (const path of ['/api/v1/me', '/api/v1/nope', '/healthz', '/missing.js', '/.env']) {
    const res = await get(path, { headers: { Accept: 'text/html' } });
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: 'Request rejected' }, path);
  }
  assert.equal((await get('/donors', { method: 'POST', headers: { Accept: 'text/html' } })).status, 404);
});

test('without a built web app every request falls through to the API', async (t) => {
  const get = await serve(t, join(tmpdir(), 'cic-web-does-not-exist'));
  assert.equal((await get('/')).status, 404);
  assert.equal((await get('/donors', { headers: { Accept: 'text/html' } })).status, 404);
});
