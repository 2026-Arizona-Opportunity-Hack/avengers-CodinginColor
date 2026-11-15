import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildForVercel, webConfig } from '../deploy/vercel-build.ts';

test('web config is same-origin and only accepts a Clerk publishable key', () => {
  assert.deepEqual(webConfig({ CLERK_PUBLISHABLE_KEY: 'pk_test_abc123' }), { apiBase: '', clerkPublishableKey: 'pk_test_abc123' });
  for (const bad of [undefined, '', 'sk_test_SECRET', 'pk_live_ has space', 'abc']) {
    assert.throws(() => webConfig({ CLERK_PUBLISHABLE_KEY: bad }), (e: Error) => {
      assert.match(e.message, /CLERK_PUBLISHABLE_KEY/);
      assert.ok(!e.message.includes('SECRET'), e.message);   // never echo a pasted secret key
      return true;
    }, String(bad));
  }
});

test('the build copies the web app into public/ and writes config.json; demo mode must be explicit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cic-vercel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist'), out = join(root, 'public');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<app-root></app-root>');
  await writeFile(join(dist, 'assets', 'main.js'), 'console.log(1)');
  await buildForVercel({ dist, out, env: { CLERK_PUBLISHABLE_KEY: 'pk_live_xyz' } });
  assert.equal(await readFile(join(out, 'index.html'), 'utf8'), '<app-root></app-root>');
  assert.equal(await readFile(join(out, 'assets', 'main.js'), 'utf8'), 'console.log(1)');
  assert.deepEqual(JSON.parse(await readFile(join(out, 'config.json'), 'utf8')), { apiBase: '', clerkPublishableKey: 'pk_live_xyz' });

  const demo = join(root, 'demo');
  await assert.rejects(buildForVercel({ dist, out: demo, env: {} }), /CLERK_PUBLISHABLE_KEY/);
  await buildForVercel({ dist, out: demo, env: { CIC_WEB_DEMO_MODE: '1' } });
  await assert.rejects(readFile(join(demo, 'config.json')), /ENOENT/);   // no config = the app's demo mode
});

test('a demo build after a live build leaves no stale config.json or old assets behind', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cic-vercel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist'), out = join(root, 'public');
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'index.html'), '<app-root></app-root>');
  await buildForVercel({ dist, out, env: { CLERK_PUBLISHABLE_KEY: 'pk_test_abc123' } });
  await writeFile(join(out, 'old-chunk.js'), 'stale');
  await buildForVercel({ dist, out, env: { CIC_WEB_DEMO_MODE: '1', CLERK_PUBLISHABLE_KEY: 'pk_test_abc123' } });
  await assert.rejects(readFile(join(out, 'config.json')), /ENOENT/);
  await assert.rejects(readFile(join(out, 'old-chunk.js')), /ENOENT/);
  assert.equal(await readFile(join(out, 'index.html'), 'utf8'), '<app-root></app-root>');
});
