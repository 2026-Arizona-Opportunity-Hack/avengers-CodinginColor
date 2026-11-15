import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

// A file:// URL, so import() works on Windows too.
const entry = new URL('../src/index.ts', import.meta.url).href;
const fixture = { DATABASE_URL: 'postgresql://cic_app:SECRET_PASSWORD@127.0.0.1:1/unavailable',
  CIC_ORG_ID: '00000000-0000-4000-8000-000000000001', CLERK_SECRET_KEY: 'sk_test_SECRETVALUE',
  CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev', APP_ORIGIN: 'https://cic-demo.vercel.app' };

/** Import the Vercel entry in a child process with only the given environment. */
async function load(env: Record<string, string>, script: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ENTRY: entry, ...env },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const [code] = await once(child, 'exit');
  return { code, out };
}

test('the Vercel entry default-exports a ready Express app without listening', async () => {
  const { code, out } = await load(fixture, `
    const { default: app } = await import(process.env.ENTRY);
    if (typeof app !== 'function' || typeof app.listen !== 'function') throw new Error('not an express app');
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const health = await fetch('http://127.0.0.1:' + port + '/healthz');
    const me = await fetch('http://127.0.0.1:' + port + '/api/v1/me');
    console.log(JSON.stringify({ health: health.status, me: me.status }));
    // Close every socket and let the process end on its own (process.exit with open handles crashes on Windows).
    server.closeAllConnections(); server.close();`);
  assert.equal(code, 0, out);
  assert.match(out, /\{"health":200,"me":401\}/);
});

test('bad configuration fails loudly with variable names only, never values', async () => {
  const { code, out } = await load({ ...fixture, CIC_ORG_ID: 'not-a-uuid', APP_ORIGIN: 'http://evil.example' },
    `await import(process.env.ENTRY);`);
  assert.notEqual(code, 0);
  assert.match(out, /Invalid API configuration: .*CIC_ORG_ID/);
  assert.match(out, /APP_ORIGIN/);
  for (const secret of ['SECRET_PASSWORD', 'SECRETVALUE', 'not-a-uuid', 'evil.example']) assert.ok(!out.includes(secret), out);
});
