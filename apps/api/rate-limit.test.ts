import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimiter } from './rate-limit.ts';

test('a key over its per-window limit is refused with a retry delay', () => {
  let now = 1_000_000;
  const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, maxEntries: 100, now: () => now });
  assert.deepEqual(limiter.hit('a'), { ok: true });
  assert.deepEqual(limiter.hit('a'), { ok: true });
  assert.deepEqual(limiter.hit('a'), { ok: false, retryAfterSeconds: 60 });
  now += 59_500;
  assert.deepEqual(limiter.hit('a'), { ok: false, retryAfterSeconds: 1 });
  now += 500;
  assert.deepEqual(limiter.hit('a'), { ok: true });   // new window
});

test('expired windows are evicted, not kept forever', () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, maxEntries: 100, now: () => now });
  for (let i = 0; i < 10; i++) limiter.hit(`k${i}`);
  assert.equal(limiter.size, 10);
  now += 60_000;
  limiter.hit('fresh');
  assert.equal(limiter.size, 1);
});

test('state never exceeds the cap; the oldest windows go first', () => {
  const now = 0;
  const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, maxEntries: 3, now: () => now });
  for (const key of ['a', 'b', 'c', 'd', 'e']) limiter.hit(key);
  assert.equal(limiter.size, 3);
  assert.deepEqual(limiter.keys(), ['c', 'd', 'e']);
});

test('forget drops a key that turned out to be invalid', () => {
  const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, maxEntries: 10, now: () => 0 });
  limiter.hit('unknown');
  limiter.forget('unknown');
  assert.equal(limiter.size, 0);
});
