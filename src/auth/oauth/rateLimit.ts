/** In-memory brute-force guard, keyed by e.g. `${email}|${ip}`. Per-instance by design. */
export class LoginRateLimiter {
  private fails = new Map<string, number[]>();

  constructor(
    private maxAttempts = 5,
    private windowMs = 15 * 60_000,
  ) {}

  private recent(key: string, now: number): number[] {
    const arr = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(key, arr);
    return arr;
  }

  isBlocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.maxAttempts;
  }

  recordFailure(key: string, now = Date.now()): void {
    this.recent(key, now).push(now);
  }

  reset(key: string): void {
    this.fails.delete(key);
  }
}
