import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the initial document contains a styled public sign-in card and native demo entry before JavaScript', async () => {
  const html = await readFile(new URL('../apps/web/src/index.html', import.meta.url), 'utf8');
  const root = html.slice(html.indexOf('<body>'), html.indexOf('<app-root>'));
  assert.match(root, /<main id="startup-card" aria-labelledby="startup-signin">/);
  assert.match(root, /href="\/sign-in\?demo=1">Try Now<\/a>/);
  assert.match(root, /role="status">Opening your workspace/);
  assert.match(html, /<style>[\s\S]*?#startup-card\s*\{[^}]*background:/);
  assert.doesNotMatch(root, /<script|<input|password|token|donor_id/i);
});
