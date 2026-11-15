import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('../apps/web/src/index.html', import.meta.url), 'utf8');
assert.match(html, /<script id="chunk-recovery" src="chunk-recovery\.js"><\/script>/,
  'recovery must load from self before module bundles, without inline script or async/defer');
const script = await readFile(new URL('../apps/web/public/chunk-recovery.js', import.meta.url), 'utf8');

class Element {
  id = ''; type = ''; textContent = ''; style = { cssText: '' };
  children: Element[] = [];
  handlers = new Map<string, () => void>();
  attributes = new Map<string, string>();
  append(child: Element) { this.children.push(child); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, callback: () => void) { this.handlers.set(name, callback); }
}

function browser(href = 'https://cic.example/donors?next=%2Fdonations#history') {
  const navigations: string[] = [], body = new Element();
  const listeners = new Map<string, (event: object) => void>();
  const context = {
    URL, location: { href, origin: new URL(href).origin, replace: (url: string) => navigations.push(url) },
    window: { addEventListener: (name: string, fn: (event: object) => void) => listeners.set(name, fn) },
    document: { body, createElement: () => new Element(),
      getElementById: (id: string) => body.children.find(child => child.id === id) },
  };
  // Recovery must work even when storage is unavailable, and must never clear records or auth.
  for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(context, key, { get() { throw Error('storage touched'); } });
  runInNewContext(script!, context);
  return { navigations, body, fire: (name: string, event: object) => listeners.get(name)?.(event) };
}

test('a missing entry bundle refreshes once with existing route, query and hash intact', () => {
  const b = browser();
  const event = { target: { tagName: 'SCRIPT', type: 'module', src: 'https://cic.example/main-old.js' } };
  b.fire('error', event); b.fire('error', event);
  assert.equal(b.navigations.length, 1);
  const url = new URL(b.navigations[0]);
  assert.equal(url.pathname, '/donors'); assert.equal(url.searchParams.get('next'), '/donations');
  assert.equal(url.hash, '#history'); assert.equal(url.searchParams.get('cic-retry'), '1');
});

test('a second failure offers an accessible manual retry instead of an automatic loop', () => {
  const b = browser('https://cic.example/donors?cic-retry=1');
  const error = { detail: { message: 'Failed to fetch dynamically imported module: https://cic.example/chunk-old.js' } };
  b.fire('cic:module-error', error); b.fire('cic:module-error', error);
  assert.deepEqual(b.navigations, []); assert.equal(b.body.children.length, 1);
  const alert = b.body.children[0];
  assert.equal(alert.attributes.get('role'), 'alert'); assert.match(alert.textContent, /saved records have been kept/);
  const button = alert.children[0]; assert.equal(button.type, 'button');
  button.handlers.get('click')!(); assert.equal(b.navigations.length, 1);
});

test('lazy import rejection, router/bootstrap relay and module preload failures recover', () => {
  for (const name of ['unhandledrejection', 'cic:module-error']) {
    const b = browser(), error = { message: 'Importing a module script failed.' };
    b.fire(name, { reason: error, detail: error }); assert.equal(b.navigations.length, 1);
  }
  const b = browser();
  b.fire('error', { target: { tagName: 'LINK', rel: 'modulepreload', href: '/chunk-old.js' } });
  assert.equal(b.navigations.length, 1);
});

test('ordinary application errors, images and foreign scripts never trigger recovery', () => {
  const b = browser();
  b.fire('unhandledrejection', { reason: { message: 'Request rejected' } });
  b.fire('cic:module-error', { detail: { message: 'Permission denied' } });
  b.fire('error', { target: { tagName: 'IMG', src: '/chunk-old.js' } });
  b.fire('error', { target: { tagName: 'SCRIPT', type: 'module', src: 'https://foreign.example/main-old.js' } });
  assert.deepEqual(b.navigations, []); assert.equal(b.body.children.length, 0);
});
