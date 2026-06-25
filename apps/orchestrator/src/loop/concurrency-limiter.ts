/**
 * Semaphore-style limiter for capping concurrent orchestrator dispatches.
 *
 * Usage:
 *   const limiter = new ConcurrencyLimiter(3);
 *   if (!limiter.tryAcquire()) return; // no capacity
 *   try { await doWork(); } finally { limiter.release(); }
 */
export class ConcurrencyLimiter {
  private _inFlight = 0;

  constructor(private _limit: number) {
    if (_limit < 1) throw new Error('Concurrency limit must be >= 1');
  }

  /** Current number of in-flight tasks. */
  get inFlight(): number { return this._inFlight; }

  /** Current concurrency limit. */
  get limit(): number { return this._limit; }

  /** True when in-flight < limit. */
  get hasCapacity(): boolean { return this._inFlight < this._limit; }

  /**
   * Try to acquire a slot. Returns true if acquired, false if at capacity.
   * Non-blocking — never waits.
   */
  tryAcquire(): boolean {
    if (this._inFlight >= this._limit) return false;
    this._inFlight++;
    return true;
  }

  /** Release a slot. Throws if in-flight is already 0 (double-release bug). */
  release(): void {
    if (this._inFlight <= 0) throw new Error('ConcurrencyLimiter: release called with no in-flight tasks');
    this._inFlight--;
  }

  /**
   * Update the concurrency limit at runtime.
   * Does not affect already in-flight work — just prevents new acquisitions
   * until in-flight drops below the new limit.
   */
  setLimit(newLimit: number): void {
    if (newLimit < 1) throw new Error('Concurrency limit must be >= 1');
    this._limit = newLimit;
  }

  /**
   * Wait until all in-flight tasks complete, with a timeout.
   * Returns true if drained successfully, false if timed out.
   * Poll interval is 100ms.
   */
  async drain(timeoutMs: number = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this._inFlight > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise(r => setTimeout(r, 100));
    }
    return true;
  }
}
