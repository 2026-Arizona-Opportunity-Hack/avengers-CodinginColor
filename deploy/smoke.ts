// Post-deploy smoke check (#30): `node deploy/smoke.ts https://<deployment>`. Read-only, unauthenticated
// requests only; it never needs or prints a key. A static-only deploy fails the API and config checks.
export type Check = { name: string; ok: boolean; detail: string };

type Probe = { status: number; type: string; body: string };

async function get(base: string, path: string, headers: Record<string, string> = {}): Promise<Probe> {
  const res = await fetch(new URL(path, base), { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
}
function parse(body: string): unknown {
  try { return JSON.parse(body); } catch { return undefined; }
}
const isJson = (p: Probe) => p.type.includes('application/json');
const seen = (p: Probe) => `${p.status} ${p.type.split(';')[0] || 'no content-type'}`;

export async function smoke(base: string): Promise<Check[]> {
  const checks: Array<[string, () => Promise<[boolean, string]>]> = [
    ['healthz', async () => {
      const p = await get(base, '/healthz');
      return [p.status === 200 && isJson(p) && (parse(p.body) as { status?: string })?.status === 'ok', seen(p)];
    }],
    ['config.json', async () => {
      const p = await get(base, '/config.json');
      const config = isJson(p) ? parse(p.body) as { apiBase?: unknown; clerkPublishableKey?: unknown } : undefined;
      const key = typeof config?.clerkPublishableKey === 'string' ? config.clerkPublishableKey : '';
      const ok = p.status === 200 && config?.apiBase === '' && /^pk_(test|live)_\S+$/.test(key);
      // Report only the key's kind, never its value.
      return [ok, `${seen(p)}, key ${/^pk_/.test(key) ? 'publishable' : key ? 'NOT publishable' : 'missing'}`];
    }],
    ['home page', async () => { const p = await get(base, '/'); return [p.status === 200 && p.type.includes('text/html'), seen(p)]; }],
    ['deep link', async () => { const p = await get(base, '/donors'); return [p.status === 200 && p.type.includes('text/html'), seen(p)]; }],
    ['api auth', async () => { const p = await get(base, '/api/v1/me'); return [p.status === 401 && isJson(p), seen(p)]; }],
    ['api origin', async () => {
      const p = await get(base, '/api/v1/me', { Origin: 'https://evil.example' });
      return [p.status === 403 && isJson(p), seen(p)];
    }],
    ['api 404', async () => { const p = await get(base, '/api/v1/no-such-route'); return [p.status === 404 && isJson(p), seen(p)]; }],
  ];
  const results: Check[] = [];
  for (const [name, run] of checks) {
    try {
      const [ok, detail] = await run();
      results.push({ name, ok, detail });
    } catch (error) {
      results.push({ name, ok: false, detail: (error as Error).name });
    }
  }
  return results;
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base || !/^https?:\/\//.test(base)) {
    console.error('Usage: node deploy/smoke.ts https://<deployment-url>');
    process.exitCode = 2;
  } else {
    const results = await smoke(base);
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(12)} ${r.detail}`);
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  }
}
