import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createApp } from './app.ts';
import { EnvSchema } from './env.ts';

const fixture = { DATABASE_URL: 'postgresql://127.0.0.1:1/unavailable',
  CIC_ORG_ID: '00000000-0000-4000-8000-000000000001', CLERK_SECRET_KEY: 'sk_test_fixture',
  CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev', APP_ORIGIN: 'http://localhost:4200' };

test('healthz is public liveness only and never invokes auth or database', async () => {
  const server = createApp(EnvSchema.parse(fixture),
    { connect: async () => assert.fail('health must not use database') },
    async () => assert.fail('health must not authenticate')).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('published start command boots with injected configuration and no .env; API stays protected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cic-api-deployment-'));
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const [node, ...args] = manifest.scripts['start:api'].split(' ');
  assert.equal(node, 'node');
  assert.equal(args.pop(), 'apps/api/server.ts');
  args.push(fileURLToPath(new URL('./server.ts', import.meta.url)));
  const child = spawn(process.execPath, args, { cwd: directory, windowsHide: true,
    env: { ...fixture, PORT: String(port), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 10000;
    let response: Response | undefined;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(300) });
        break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    assert.ok(response, `Server did not listen: ${stderr}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/me`)).status, 401);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    const within = relative(await realpath(tmpdir()), await realpath(directory));
    assert.ok(within && within !== '..' && !within.startsWith(`..${sep}`));
    await rm(directory, { recursive: true, force: true });
  }
});
