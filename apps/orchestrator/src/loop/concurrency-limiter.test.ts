import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter } from './concurrency-limiter';

describe('ConcurrencyLimiter', () => {
  describe('constructor validation', () => {
    it('throws on limit < 1 (zero)', () => {
      expect(() => new ConcurrencyLimiter(0)).toThrow('Concurrency limit must be >= 1');
    });

    it('throws on limit < 1 (negative)', () => {
      expect(() => new ConcurrencyLimiter(-1)).toThrow('Concurrency limit must be >= 1');
      expect(() => new ConcurrencyLimiter(-100)).toThrow('Concurrency limit must be >= 1');
    });

    it('accepts limit >= 1', () => {
      expect(() => new ConcurrencyLimiter(1)).not.toThrow();
      expect(() => new ConcurrencyLimiter(5)).not.toThrow();
      expect(() => new ConcurrencyLimiter(100)).not.toThrow();
    });

    it('initializes with correct limit', () => {
      const limiter = new ConcurrencyLimiter(5);
      expect(limiter.limit).toBe(5);
    });
  });

  describe('tryAcquire/release basics', () => {
    it('acquire succeeds when under limit', () => {
      const limiter = new ConcurrencyLimiter(2);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
    });

    it('acquire fails when at limit', () => {
      const limiter = new ConcurrencyLimiter(2);
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('release allows re-acquire', () => {
      const limiter = new ConcurrencyLimiter(1);
      limiter.tryAcquire();
      expect(limiter.tryAcquire()).toBe(false);
      limiter.release();
      expect(limiter.tryAcquire()).toBe(true);
    });

    it('inFlight tracks correctly through acquire/release cycles', () => {
      const limiter = new ConcurrencyLimiter(3);
      expect(limiter.inFlight).toBe(0);

      limiter.tryAcquire();
      expect(limiter.inFlight).toBe(1);

      limiter.tryAcquire();
      expect(limiter.inFlight).toBe(2);

      limiter.release();
      expect(limiter.inFlight).toBe(1);

      limiter.release();
      expect(limiter.inFlight).toBe(0);
    });
  });

  describe('capacity tracking', () => {
    it('hasCapacity is true initially', () => {
      const limiter = new ConcurrencyLimiter(3);
      expect(limiter.hasCapacity).toBe(true);
    });

    it('hasCapacity becomes false at limit', () => {
      const limiter = new ConcurrencyLimiter(2);
      limiter.tryAcquire();
      expect(limiter.hasCapacity).toBe(true);

      limiter.tryAcquire();
      expect(limiter.hasCapacity).toBe(false);
    });

    it('hasCapacity becomes true again after release', () => {
      const limiter = new ConcurrencyLimiter(2);
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.hasCapacity).toBe(false);

      limiter.release();
      expect(limiter.hasCapacity).toBe(true);
    });

    it('inFlight returns correct count', () => {
      const limiter = new ConcurrencyLimiter(5);
      expect(limiter.inFlight).toBe(0);

      for (let i = 0; i < 3; i++) {
        limiter.tryAcquire();
      }
      expect(limiter.inFlight).toBe(3);

      limiter.release();
      expect(limiter.inFlight).toBe(2);
    });
  });

  describe('release safety', () => {
    it('release throws when inFlight is 0 (double-release protection)', () => {
      const limiter = new ConcurrencyLimiter(3);
      expect(() => limiter.release()).toThrow('ConcurrencyLimiter: release called with no in-flight tasks');
    });

    it('release throws after all slots released', () => {
      const limiter = new ConcurrencyLimiter(2);
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.release();
      limiter.release();
      expect(() => limiter.release()).toThrow('ConcurrencyLimiter: release called with no in-flight tasks');
    });
  });

  describe('setLimit', () => {
    it('increasing limit allows more acquisitions', () => {
      const limiter = new ConcurrencyLimiter(2);
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.tryAcquire()).toBe(false);

      limiter.setLimit(3);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.inFlight).toBe(3);
    });

    it('decreasing limit prevents new acquisitions (but does not affect in-flight)', () => {
      const limiter = new ConcurrencyLimiter(5);
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.inFlight).toBe(3);

      limiter.setLimit(2);
      expect(limiter.inFlight).toBe(3); // still 3 in flight
      expect(limiter.tryAcquire()).toBe(false); // cannot acquire more
      expect(limiter.hasCapacity).toBe(false);

      limiter.release();
      expect(limiter.inFlight).toBe(2);
      expect(limiter.hasCapacity).toBe(false); // still at new limit

      limiter.release();
      expect(limiter.inFlight).toBe(1);
      expect(limiter.hasCapacity).toBe(true); // now below limit
    });

    it('setLimit throws on < 1', () => {
      const limiter = new ConcurrencyLimiter(5);
      expect(() => limiter.setLimit(0)).toThrow('Concurrency limit must be >= 1');
      expect(() => limiter.setLimit(-1)).toThrow('Concurrency limit must be >= 1');
      expect(() => limiter.setLimit(-100)).toThrow('Concurrency limit must be >= 1');
    });

    it('setLimit updates the limit property', () => {
      const limiter = new ConcurrencyLimiter(3);
      expect(limiter.limit).toBe(3);

      limiter.setLimit(10);
      expect(limiter.limit).toBe(10);

      limiter.setLimit(1);
      expect(limiter.limit).toBe(1);
    });
  });

  describe('drain', () => {
    it('resolves immediately when nothing in-flight', async () => {
      const limiter = new ConcurrencyLimiter(3);
      const result = await limiter.drain(200);
      expect(result).toBe(true);
    });

    it('resolves when all in-flight complete', async () => {
      const limiter = new ConcurrencyLimiter(3);
      limiter.tryAcquire();
      limiter.tryAcquire();

      setTimeout(() => {
        limiter.release();
        limiter.release();
      }, 50);

      const result = await limiter.drain(200);
      expect(result).toBe(true);
      expect(limiter.inFlight).toBe(0);
    });

    it('times out if tasks do not complete', async () => {
      const limiter = new ConcurrencyLimiter(2);
      limiter.tryAcquire();

      const result = await limiter.drain(200);
      expect(result).toBe(false);
      expect(limiter.inFlight).toBe(1); // still in-flight
    });

    it('handles multiple tasks completing at different times', async () => {
      const limiter = new ConcurrencyLimiter(5);
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();

      setTimeout(() => limiter.release(), 30);
      setTimeout(() => limiter.release(), 60);
      setTimeout(() => limiter.release(), 90);

      const result = await limiter.drain(200);
      expect(result).toBe(true);
      expect(limiter.inFlight).toBe(0);
    });
  });

  describe('concurrent behavior', () => {
    it('multiple acquire calls up to limit all succeed', () => {
      const limiter = new ConcurrencyLimiter(5);
      const results = [];

      for (let i = 0; i < 5; i++) {
        results.push(limiter.tryAcquire());
      }

      expect(results).toEqual([true, true, true, true, true]);
      expect(limiter.inFlight).toBe(5);
    });

    it('acquire at limit+1 fails', () => {
      const limiter = new ConcurrencyLimiter(3);

      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('mixed acquire/release sequences maintain correct count', () => {
      const limiter = new ConcurrencyLimiter(3);

      limiter.tryAcquire(); // 1
      expect(limiter.inFlight).toBe(1);

      limiter.tryAcquire(); // 2
      expect(limiter.inFlight).toBe(2);

      limiter.release(); // 1
      expect(limiter.inFlight).toBe(1);

      limiter.tryAcquire(); // 2
      limiter.tryAcquire(); // 3
      expect(limiter.inFlight).toBe(3);

      limiter.release(); // 2
      limiter.release(); // 1
      expect(limiter.inFlight).toBe(1);

      limiter.release(); // 0
      expect(limiter.inFlight).toBe(0);
    });

    it('limit of 1 works correctly (single slot)', () => {
      const limiter = new ConcurrencyLimiter(1);

      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);

      limiter.release();

      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });
  });
});
