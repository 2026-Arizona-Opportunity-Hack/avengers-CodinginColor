import { Api } from './core/api';

const mock = vi.hoisted(() => ({ load: vi.fn(async (_options: unknown) => {}), ui: { ClerkUI: {} }, listener: null as null | ((event:{session:{id:string}|null})=>void) }));
vi.mock('@clerk/ui', () => ({ ui: mock.ui }));
vi.mock('@clerk/clerk-js', () => ({ Clerk: class {
  session = null;
  load = mock.load;
  addListener(listener:(event:{session:{id:string}|null})=>void) { mock.listener=listener; }
} }));

it('loads the actual Clerk component configuration before exposing sign-in', async () => {
  const api = new Api();
  await api.start({ apiBase: '', clerkPublishableKey: 'pk_test_synthetic' }, vi.fn(), vi.fn());
  expect(mock.load).toHaveBeenCalledWith({ ui: mock.ui,
    localization: { signIn: { start: { title: 'Sign in to Coding in Color' } } } });
  expect(api.status()).toBe('signed-out');
});

it('shows a recoverable error when the auth components cannot load', async () => {
  mock.load.mockRejectedValueOnce(new Error('Private provider details'));
  const api = new Api();
  await api.start({ apiBase: '', clerkPublishableKey: 'pk_test_synthetic' }, vi.fn(), vi.fn());
  expect(api.status()).toBe('error');
  expect(api.error()).not.toContain('Private provider details');
});


it('versions active identities and clears the old session before loading a switched account',async()=>{
  const api=new Api(),inside=vi.fn(),outside=vi.fn();
  await api.start({apiBase:'',clerkPublishableKey:'pk_test_synthetic'},inside,outside);
  const first=api.identityVersion();mock.listener!({session:{id:'one'}});
  expect(api.authenticated()).toBe(true);expect(inside).toHaveBeenCalledTimes(1);
  mock.listener!({session:{id:'two'}});expect(outside).toHaveBeenCalledTimes(1);expect(inside).toHaveBeenCalledTimes(2);
  expect(api.identityVersion()).toBe(first+2);
  mock.listener!({session:null});expect(api.authenticated()).toBe(false);expect(outside).toHaveBeenCalledTimes(2);
});
