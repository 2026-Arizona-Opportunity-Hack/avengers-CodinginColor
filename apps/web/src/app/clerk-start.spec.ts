import { Api } from './core/api';

const mock = vi.hoisted(() => ({ load: vi.fn(async (_options: unknown) => {}), ui: { ClerkUI: {} } }));
vi.mock('@clerk/ui', () => ({ ui: mock.ui }));
vi.mock('@clerk/clerk-js', () => ({ Clerk: class {
  session = null;
  load = mock.load;
  addListener() {}
} }));

it('loads the actual Clerk component configuration before exposing sign-in', async () => {
  const api = new Api();
  await api.start({ apiBase: '', clerkPublishableKey: 'pk_test_synthetic' }, vi.fn(), vi.fn());
  expect(mock.load).toHaveBeenCalledWith({ ui: mock.ui });
  expect(api.status()).toBe('signed-out');
});

it('shows a recoverable error when the auth components cannot load', async () => {
  mock.load.mockRejectedValueOnce(new Error('Private provider details'));
  const api = new Api();
  await api.start({ apiBase: '', clerkPublishableKey: 'pk_test_synthetic' }, vi.fn(), vi.fn());
  expect(api.status()).toBe('error');
  expect(api.error()).not.toContain('Private provider details');
});
