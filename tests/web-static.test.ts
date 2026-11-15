import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { webApp } from '../src/web.ts';

async function serve(t: test.TestContext, dir: string, assets?: express.RequestHandler) {
  const app = express().use((_req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; base-uri 'self'"); next();
  }).use(webApp(dir, assets));
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

test('equal-length deployments with fixed file times never validate stale HTML', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cic-html-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const index = join(dir, 'index.html'), fixed = new Date('2018-10-20T01:46:40Z');
  await writeFile(index, '<script src="main-old.js"></script>');
  await utimes(index, fixed, fixed);
  const get = await serve(t, dir, express.static(dir, { index: false }));
  const old = await get('/');
  const etag = old.headers.get('etag') ?? 'W/"22-1668f272800"';
  await writeFile(index, '<script src="main-new.js"></script>');
  await utimes(index, fixed, fixed);
  for (const path of ['/', '/donors', '/index.html']) {
    const response = await get(path, { headers: { 'If-None-Match': etag, 'If-Modified-Since': fixed.toUTCString(), 'Cache-Control': 'max-age=0' } });
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /main-new/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.notEqual(response.headers.get('etag'), etag);
    assert.equal(response.headers.get('last-modified'), null);
  }
});

test('CSP permits the self-hosted pre-bundle recovery file without unsafe-inline and stale validators', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cic-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const html = await readFile(new URL('../apps/web/src/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../apps/web/public/chunk-recovery.js', import.meta.url), 'utf8');
  await writeFile(join(dir, 'index.html'), html);
  await writeFile(join(dir, 'chunk-recovery.js'), script);
  const fixed = new Date('2018-10-20T01:46:40Z');
  await utimes(join(dir, 'chunk-recovery.js'), fixed, fixed);
  const get = await serve(t, dir, express.static(dir, { index: false }));
  const page = await get('/');
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /unsafe-inline/);
  assert.match(await page.text(), /<script id="chunk-recovery" src="chunk-recovery\.js"><\/script>/);
  const recovery = await get('/chunk-recovery.js');
  assert.equal(recovery.status, 200); assert.match(recovery.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await recovery.text(), script);
  assert.equal(recovery.headers.get('cache-control'), 'no-store');
  assert.equal(recovery.headers.get('last-modified'), null);
  const nextScript = script.replace('cic-retry', 'cic-fresh');
  await writeFile(join(dir, 'chunk-recovery.js'), nextScript);
  await utimes(join(dir, 'chunk-recovery.js'), fixed, fixed);
  const next = await get('/chunk-recovery.js', { headers: {
    'If-None-Match': recovery.headers.get('etag')!, 'Cache-Control': 'max-age=0',
  } });
  assert.equal(next.status, 200); assert.equal(await next.text(), nextScript);
});
