/** Fixed-window per-key limiter with bounded memory: expired windows are evicted and size is capped. */
export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: { limit: number; windowMs: number; maxEntries: number; now?: () => number }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? Date.now;
  }

  get size(): number { return this.#windows.size; }
  keys(): string[] { return [...this.#windows.keys()]; }

  hit(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.#now();
    for (const [k, w] of this.#windows) if (now - w.start >= this.#windowMs) this.#windows.delete(k);
    const w = this.#windows.get(key);
    if (!w) {
      this.#windows.set(key, { start: now, count: 1 });
      // Map keeps insertion order, so the first keys are the oldest windows.
      while (this.#windows.size > this.#maxEntries) this.#windows.delete(this.#windows.keys().next().value!);
      return { ok: true };
    }
    if (++w.count <= this.#limit) return { ok: true };
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((w.start + this.#windowMs - now) / 1000)) };
  }

  /** Drop state for a key that turned out to be invalid, so arbitrary keys never accumulate. */
  forget(key: string): void { this.#windows.delete(key); }
}
