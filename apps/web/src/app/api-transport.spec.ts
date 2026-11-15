import { Api } from './core/api';

it('opens Clerk account security without changing the API access state', () => {
  const api = new Api(), openUserProfile = vi.fn();
  Object.assign(api, { clerk: { openUserProfile } });
  api.status.set('error'); api.manageSecurity();
  expect(openUserProfile).toHaveBeenCalledOnce();
  expect(openUserProfile).toHaveBeenCalledWith({ __experimental_startPath: '/security' });
  expect(api.status()).toBe('error');
});

it('explains the specific admin MFA failure without exposing arbitrary server error details', async () => {
  const api = new Api();
  Object.assign(api, { config: { apiBase: '' }, clerk: { session: { getToken: async () => 'fixture' } } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'admin_mfa_required', error: 'PRIVATE' }), { status: 403 })));
  try {
    await expect(api.me()).rejects.toThrow('Your admin account needs two-step verification');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'PRIVATE', error: 'PRIVATE' }), { status: 403 })));
    await expect(api.me()).rejects.toThrow('You do not have access to that.');
  } finally { vi.unstubAllGlobals(); }
});

it('preserves upload headers and bytes while enforcing the current session bearer', async () => {
  const api = new Api();
  Object.assign(api, { config: { apiBase: 'https://api.example.org' },
    clerk: { session: { getToken: async () => 'session-token' } } });
  const fetch = vi.fn(async () => new Response('{"batch_id":"batch"}', { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  try {
    const file = new Blob(['original bytes']);
    await api.request('/api/v1/imports', { method: 'POST', body: file,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'X-Import-Source': 'zeffy', Authorization: 'untrusted' } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.org/api/v1/imports');
    expect(init.body).toBe(file);
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(headers.get('X-Import-Source')).toBe('zeffy');
    expect(headers.get('Authorization')).toBe('Bearer session-token');
    expect(init.credentials).toBe('omit');
  } finally { vi.unstubAllGlobals(); }
});
