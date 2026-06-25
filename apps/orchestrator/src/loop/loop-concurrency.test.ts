import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter } from './concurrency-limiter';

/**
 * Integration-style tests for ConcurrencyLimiter dispatch patterns.
 *
 * These tests validate that the limiter integrates correctly with the
 * orchestrator's fire-and-forget dispatch pattern:
 * 1. Check limiter.hasCapacity before claiming
 * 2. Call limiter.tryAcquire() before dispatch
 * 3. Dispatch as background promise
 * 4. Release in finally block
 */
describe('ConcurrencyLimiter dispatch integration', () => {
  it('dispatches up to concurrency limit in parallel', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const started: string[] = [];
    const completed: string[] = [];

    // Helper to simulate a dispatch
    const dispatch = async (id: string, delayMs: number) => {
      try {
        started.push(id);
        await new Promise(r => setTimeout(r, delayMs));
        completed.push(id);
      } finally {
        limiter.release();
      }
    };

    // Try to dispatch 3 jobs
    const jobs = ['job1', 'job2', 'job3'];
    const dispatches: Promise<void>[] = [];

    for (const job of jobs) {
      if (!limiter.tryAcquire()) {
        break; // no capacity
      }
      dispatches.push(dispatch(job, 50));
    }

    // Should have dispatched exactly 2 (at limit)
    expect(started).toHaveLength(2);
    expect(started).toEqual(['job1', 'job2']);
    expect(limiter.inFlight).toBe(2);

    // Wait for first batch to complete
    await Promise.all(dispatches);
    expect(completed).toHaveLength(2);
    expect(limiter.inFlight).toBe(0);

    // Now we have capacity for the third job
    expect(limiter.hasCapacity).toBe(true);
    if (limiter.tryAcquire()) {
      await dispatch('job3', 50);
    }

    expect(completed).toEqual(['job1', 'job2', 'job3']);
    expect(limiter.inFlight).toBe(0);
  });

  it('drain waits for all in-flight dispatches to complete', async () => {
    const limiter = new ConcurrencyLimiter(3);
    const results: string[] = [];

    // Helper to simulate delayed work
    const doWork = async (id: string, delayMs: number) => {
      try {
        await new Promise(r => setTimeout(r, delayMs));
        results.push(id);
      } finally {
        limiter.release();
      }
    };

    // Acquire 3 slots, each with different delays
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.inFlight).toBe(3);

    // Dispatch all three with staggered completion times
    const dispatches = [
      doWork('fast', 30),
      doWork('medium', 60),
      doWork('slow', 90),
    ];

    // Drain should wait for all to complete
    const drainPromise = limiter.drain(5000);
    const drained = await drainPromise;

    // All should have completed
    expect(drained).toBe(true);
    expect(limiter.inFlight).toBe(0);
    expect(results).toHaveLength(3);
    expect(results).toEqual(expect.arrayContaining(['fast', 'medium', 'slow']));

    // Wait for promises to ensure cleanup
    await Promise.all(dispatches);
  });

  it('concurrent dispatch pattern maintains correct in-flight count', async () => {
    // Simulate the tick loop pattern:
    // while (limiter.hasCapacity) { tryAcquire(); dispatch(); }
    // Each dispatch is a promise that does work then releases
    const limiter = new ConcurrencyLimiter(2);
    const results: string[] = [];
    const dispatches: Promise<void>[] = [];

    // Simulate 4 items to process with concurrency 2
    const items = ['a', 'b', 'c', 'd'];
    let idx = 0;

    // First tick — claim as many as capacity allows
    while (limiter.hasCapacity && idx < items.length) {
      if (!limiter.tryAcquire()) break;
      const item = items[idx++];
      dispatches.push(
        (async () => {
          try {
            await new Promise(r => setTimeout(r, 50)); // simulate work
            results.push(item);
          } finally {
            limiter.release();
          }
        })(),
      );
    }

    // Should have dispatched 2 (a, b)
    expect(limiter.inFlight).toBe(2);
    expect(idx).toBe(2);

    // Wait for first batch
    await Promise.all(dispatches);
    expect(limiter.inFlight).toBe(0);
    expect(results).toHaveLength(2);

    // Second tick — claim remaining
    dispatches.length = 0;
    while (limiter.hasCapacity && idx < items.length) {
      if (!limiter.tryAcquire()) break;
      const item = items[idx++];
      dispatches.push(
        (async () => {
          try {
            await new Promise(r => setTimeout(r, 50));
            results.push(item);
          } finally {
            limiter.release();
          }
        })(),
      );
    }

    expect(limiter.inFlight).toBe(2);
    await Promise.all(dispatches);
    expect(results).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));
    expect(results).toHaveLength(4);
    expect(limiter.inFlight).toBe(0);
  });

  it('stopClaiming pattern prevents new acquisitions during drain', async () => {
    // Simulate the shutdown flow:
    // 1. Acquire 2 slots (jobs in flight)
    // 2. Set a "stopping" flag (like stopClaiming)
    // 3. Start drain
    // 4. Release slots after a delay
    // 5. Drain should complete
    const limiter = new ConcurrencyLimiter(3);
    let stopping = false;

    // Acquire 2 slots
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.inFlight).toBe(2);

    // "Stop claiming" — don't acquire more
    stopping = true;

    // Simulate delayed releases (like in-flight jobs completing)
    setTimeout(() => limiter.release(), 50);
    setTimeout(() => limiter.release(), 100);

    // Drain should wait for both
    const drained = await limiter.drain(5000);
    expect(drained).toBe(true);
    expect(limiter.inFlight).toBe(0);

    // After stopping, we shouldn't acquire more (business logic, not limiter)
    expect(stopping).toBe(true);
    if (!stopping && limiter.hasCapacity) {
      limiter.tryAcquire(); // this path shouldn't execute
    }
    expect(limiter.inFlight).toBe(0);
  });

  it('gate-like pattern: concurrent jobs with sequential gate acquisition', async () => {
    // Simulate 2 jobs both needing a "gate" (shared resource)
    // With concurrency=2, both dispatch in parallel
    // But gate acquisition serializes the critical section
    const limiter = new ConcurrencyLimiter(2);
    const gateLog: string[] = [];
    let gateLocked = false;

    async function simulateJobWithGate(id: string): Promise<void> {
      try {
        // Wait for gate (simulated spin wait)
        while (gateLocked) {
          await new Promise(r => setTimeout(r, 5));
        }
        gateLocked = true;
        gateLog.push(`${id}:acquired`);
        await new Promise(r => setTimeout(r, 20)); // simulate work
        gateLog.push(`${id}:released`);
        gateLocked = false;
      } finally {
        limiter.release();
      }
    }

    // Both acquire limiter slots
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);

    // Dispatch both in parallel
    await Promise.all([
      simulateJobWithGate('job1'),
      simulateJobWithGate('job2'),
    ]);

    // Both should have completed
    expect(gateLog).toHaveLength(4);
    // Gate should have serialized: no overlapping acquires
    expect(gateLog[0]).toMatch(/acquired$/);
    expect(gateLog[1]).toMatch(/released$/);
    expect(gateLog[2]).toMatch(/acquired$/);
    expect(gateLog[3]).toMatch(/released$/);
    expect(limiter.inFlight).toBe(0);
  });

  it('handles dispatch failures with proper cleanup', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const results: string[] = [];

    // Helper that sometimes throws
    const dispatch = async (id: string, shouldFail: boolean) => {
      try {
        await new Promise(r => setTimeout(r, 30));
        if (shouldFail) {
          throw new Error(`${id} failed`);
        }
        results.push(`${id}:success`);
      } catch (err) {
        results.push(`${id}:error`);
        throw err; // re-throw to test error handling
      } finally {
        limiter.release();
      }
    };

    // Dispatch 2 jobs: one success, one failure
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);

    const dispatches = [
      dispatch('job1', false).catch(() => {}), // swallow error
      dispatch('job2', true).catch(() => {}),  // swallow error
    ];

    await Promise.all(dispatches);

    // Both should have completed (one success, one error)
    expect(results).toHaveLength(2);
    expect(results).toContain('job1:success');
    expect(results).toContain('job2:error');

    // Limiter should have been released for both
    expect(limiter.inFlight).toBe(0);
    expect(limiter.hasCapacity).toBe(true);
  });

  it('multi-tick backlog processing pattern', async () => {
    // Simulate processing a backlog over multiple ticks
    const limiter = new ConcurrencyLimiter(3);
    const backlog = Array.from({ length: 10 }, (_, i) => `item-${i}`);
    const processed: string[] = [];

    const processItem = async (item: string) => {
      try {
        await new Promise(r => setTimeout(r, 20));
        processed.push(item);
      } finally {
        limiter.release();
      }
    };

    // Process in batches (ticks)
    while (backlog.length > 0) {
      const batch: Promise<void>[] = [];

      // Claim up to capacity
      while (limiter.hasCapacity && backlog.length > 0) {
        if (!limiter.tryAcquire()) break;
        const item = backlog.shift()!;
        batch.push(processItem(item));
      }

      // Wait for this batch to complete before next tick
      await Promise.all(batch);
      expect(limiter.inFlight).toBe(0);
    }

    // All items should be processed
    expect(processed).toHaveLength(10);
    expect(processed).toEqual(
      expect.arrayContaining([
        'item-0', 'item-1', 'item-2', 'item-3', 'item-4',
        'item-5', 'item-6', 'item-7', 'item-8', 'item-9',
      ]),
    );
    expect(limiter.inFlight).toBe(0);
  });

  it('fire-and-forget pattern with background tracking', async () => {
    // Simulate fire-and-forget dispatches with a tracking array
    const limiter = new ConcurrencyLimiter(2);
    const inFlight: Promise<void>[] = [];
    const completed: string[] = [];

    const fireAndForget = (id: string, delayMs: number) => {
      if (!limiter.tryAcquire()) {
        return false; // no capacity
      }

      const promise = (async () => {
        try {
          await new Promise(r => setTimeout(r, delayMs));
          completed.push(id);
        } finally {
          limiter.release();
        }
      })();

      inFlight.push(promise);
      return true;
    };

    // Fire off 2 jobs (at capacity)
    expect(fireAndForget('bg1', 50)).toBe(true);
    expect(fireAndForget('bg2', 50)).toBe(true);
    expect(fireAndForget('bg3', 50)).toBe(false); // rejected, no capacity

    expect(limiter.inFlight).toBe(2);
    expect(inFlight).toHaveLength(2);

    // Wait for background jobs
    await Promise.all(inFlight);

    expect(completed).toHaveLength(2);
    expect(completed).toEqual(expect.arrayContaining(['bg1', 'bg2']));
    expect(limiter.inFlight).toBe(0);

    // Now we can fire the third
    inFlight.length = 0;
    expect(fireAndForget('bg3', 50)).toBe(true);
    await Promise.all(inFlight);

    expect(completed).toHaveLength(3);
    expect(completed).toContain('bg3');
  });

  it('dynamic limit adjustment during dispatch', async () => {
    // Test setLimit during active dispatches
    const limiter = new ConcurrencyLimiter(3);
    const results: string[] = [];

    const dispatch = async (id: string, delayMs: number) => {
      try {
        await new Promise(r => setTimeout(r, delayMs));
        results.push(id);
      } finally {
        limiter.release();
      }
    };

    // Acquire 3 slots
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);

    const batch1 = [
      dispatch('a', 50),
      dispatch('b', 50),
      dispatch('c', 50),
    ];

    // Reduce limit while jobs in flight
    limiter.setLimit(1);
    expect(limiter.limit).toBe(1);
    expect(limiter.inFlight).toBe(3); // still 3 in flight
    expect(limiter.hasCapacity).toBe(false); // no capacity for new

    // Wait for first batch
    await Promise.all(batch1);
    expect(limiter.inFlight).toBe(0);

    // Now with limit=1, can only dispatch 1 at a time
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false); // at new limit

    await dispatch('d', 50);
    expect(results).toHaveLength(4);
    expect(limiter.inFlight).toBe(0);
  });
});

describe('force-recovery pattern (dispatch stuck, recovery releases)', () => {
  // Scenario: A dispatch acquires a slot but gets stuck.
  // Recovery logic deletes from the tracking map and releases the slot.
  // If the dispatch eventually completes, it should NOT double-release.

  it('recovery releases slot when dispatch is stuck', () => {
    const limiter = new ConcurrencyLimiter(1);
    const inFlight = new Map<string, number>();

    // Dispatch acquires slot
    expect(limiter.tryAcquire()).toBe(true);
    inFlight.set('job-1', Date.now());
    expect(limiter.inFlight).toBe(1);
    expect(limiter.hasCapacity).toBe(false);

    // Recovery force-recovers: delete from map + release
    inFlight.delete('job-1');
    limiter.release();
    expect(limiter.inFlight).toBe(0);
    expect(limiter.hasCapacity).toBe(true);
  });

  it('dispatch skips release when force-recovered', () => {
    const limiter = new ConcurrencyLimiter(1);
    const inFlight = new Map<string, number>();

    // Dispatch acquires slot
    expect(limiter.tryAcquire()).toBe(true);
    inFlight.set('job-1', Date.now());

    // Recovery force-recovers
    inFlight.delete('job-1');
    limiter.release();
    expect(limiter.inFlight).toBe(0);

    // Dispatch's finally block runs later — uses Map.delete return value as guard
    const wasTracked = inFlight.delete('job-1');
    expect(wasTracked).toBe(false);
    // Guard: only release if wasTracked is true
    if (wasTracked) {
      limiter.release();
    }
    // Counter should still be 0, NOT negative
    expect(limiter.inFlight).toBe(0);
  });

  it('new jobs can be dispatched after recovery releases slot', () => {
    const limiter = new ConcurrencyLimiter(1);
    const inFlight = new Map<string, number>();

    // First dispatch acquires slot and gets stuck
    expect(limiter.tryAcquire()).toBe(true);
    inFlight.set('job-1', Date.now());
    expect(limiter.hasCapacity).toBe(false);

    // Can't dispatch another job — at capacity
    expect(limiter.tryAcquire()).toBe(false);

    // Recovery force-recovers
    inFlight.delete('job-1');
    limiter.release();

    // Now a new job CAN be dispatched
    expect(limiter.hasCapacity).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    inFlight.set('job-2', Date.now());
    expect(limiter.inFlight).toBe(1);

    // Clean up
    inFlight.delete('job-2');
    limiter.release();
  });

  it('double-release throws without guard', () => {
    const limiter = new ConcurrencyLimiter(1);

    limiter.tryAcquire();
    limiter.release();

    // Second release should throw
    expect(() => limiter.release()).toThrow('no in-flight tasks');
  });
});
