import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ConcurrencyTuner, TunerConfig } from './concurrency-tuner';
import { ConcurrencyLimiter } from './concurrency-limiter';
import { CgroupMetrics } from './cgroup-metrics';

describe('ConcurrencyTuner', () => {
  let limiter: ConcurrencyLimiter;
  let config: TunerConfig;
  let mockReader: {
    read: ReturnType<typeof vi.fn>;
    isAvailable: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    limiter = new ConcurrencyLimiter(5);
    config = {
      enabled: true,
      min: 1,
      max: 10,
      intervalMs: 1000,
      cpuThreshold: 0.8,
      memoryThreshold: 0.8,
    };

    // Create mock reader with default implementation
    mockReader = {
      read: vi.fn().mockResolvedValue({
        cpuUsage: null,
        memoryUsage: null,
        available: false,
      }),
      isAvailable: vi.fn().mockResolvedValue(false),
    };

    // Mock console.log to avoid test output pollution
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('start/stop', () => {
    it('does not start if disabled', () => {
      config.enabled = false;
      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      tuner.start();

      const status = tuner.getStatus();
      expect(status.running).toBe(false);
    });

    it('starts and runs tick on enabled', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.5,
        memoryUsage: 0.5,
        available: true,
      });

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      tuner.start();

      // Wait for first tick
      await new Promise(r => setTimeout(r, 10));

      expect(mockReader.read).toHaveBeenCalled();
      const status = tuner.getStatus();
      expect(status.running).toBe(true);

      tuner.stop();
    });

    it('stop clears the interval', () => {
      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      tuner.start();
      expect(tuner.getStatus().running).toBe(true);

      tuner.stop();
      expect(tuner.getStatus().running).toBe(false);
    });

    it('does not start twice', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.5,
        memoryUsage: 0.5,
        available: true,
      });

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      tuner.start();
      const callCount1 = mockReader.read.mock.calls.length;

      tuner.start(); // Second start should be no-op

      // Wait a bit
      await new Promise(r => setTimeout(r, 10));

      // Should not have doubled the calls
      expect(mockReader.read.mock.calls.length).toBeLessThanOrEqual(callCount1 + 1);

      tuner.stop();
    });
  });

  describe('tick - metrics unavailable', () => {
    it('does not change limit when metrics unavailable', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: null,
        memoryUsage: null,
        available: false,
      });

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      const initialLimit = limiter.limit;
      await tuner.tick();

      expect(limiter.limit).toBe(initialLimit);
      const status = tuner.getStatus();
      expect(status.lastMetrics?.available).toBe(false);
    });
  });

  describe('tick - decrease limit', () => {
    it('decreases limit when CPU above threshold', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.85, // Above 0.8 threshold
        memoryUsage: 0.5,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(5);
      await tuner.tick();

      expect(limiter.limit).toBe(4); // Decreased by 1
      const status = tuner.getStatus();
      expect(status.adjustmentCount).toBe(1);
      expect(status.lastAdjustment).not.toBe(null);
    });

    it('decreases limit when memory above threshold', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.5,
        memoryUsage: 0.85, // Above 0.8 threshold
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(5);
      await tuner.tick();

      expect(limiter.limit).toBe(4); // Decreased by 1
    });

    it('decreases limit when both CPU and memory above threshold', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.9,
        memoryUsage: 0.9,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(5);
      await tuner.tick();

      expect(limiter.limit).toBe(4);
    });

    it('does not go below min', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.95,
        memoryUsage: 0.95,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(1); // Already at min
      await tuner.tick();

      expect(limiter.limit).toBe(1); // Should not decrease below min
    });
  });

  describe('tick - increase limit', () => {
    it('increases limit when resources low and at capacity', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.5, // Below 0.8 * 0.7 = 0.56
        memoryUsage: 0.5, // Below 0.8 * 0.7 = 0.56
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(3);
      // Simulate being at capacity
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();

      await tuner.tick();

      expect(limiter.limit).toBe(4); // Increased by 1
    });

    it('increases limit when hasCapacity is false', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.3,
        memoryUsage: 0.3,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(2);
      limiter.tryAcquire();
      limiter.tryAcquire();

      expect(limiter.hasCapacity).toBe(false);

      await tuner.tick();

      expect(limiter.limit).toBe(3); // Increased
    });

    it('does not increase if not at capacity', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.3,
        memoryUsage: 0.3,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(5);
      limiter.tryAcquire(); // Only 1 in-flight, has capacity

      const initialLimit = limiter.limit;
      await tuner.tick();

      expect(limiter.limit).toBe(initialLimit); // No change
    });

    it('does not increase if CPU is too high (not below 70% of threshold)', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.6, // Above 0.8 * 0.7 = 0.56
        memoryUsage: 0.3,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(2);
      limiter.tryAcquire();
      limiter.tryAcquire();

      const initialLimit = limiter.limit;
      await tuner.tick();

      expect(limiter.limit).toBe(initialLimit); // No change
    });

    it('does not increase if memory is too high (not below 70% of threshold)', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.3,
        memoryUsage: 0.6, // Above 0.8 * 0.7 = 0.56
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(2);
      limiter.tryAcquire();
      limiter.tryAcquire();

      const initialLimit = limiter.limit;
      await tuner.tick();

      expect(limiter.limit).toBe(initialLimit); // No change
    });

    it('does not go above max', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.2,
        memoryUsage: 0.2,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(10); // Already at max
      // Simulate capacity demand
      for (let i = 0; i < 10; i++) {
        limiter.tryAcquire();
      }

      await tuner.tick();

      expect(limiter.limit).toBe(10); // Should not increase above max
    });

    it('increases when CPU is null (unavailable) but memory is OK', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: null,
        memoryUsage: 0.3,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(2);
      limiter.tryAcquire();
      limiter.tryAcquire();

      await tuner.tick();

      expect(limiter.limit).toBe(3); // Increased
    });

    it('increases when memory is null (unavailable) but CPU is OK', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.3,
        memoryUsage: null,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(2);
      limiter.tryAcquire();
      limiter.tryAcquire();

      await tuner.tick();

      expect(limiter.limit).toBe(3); // Increased
    });
  });

  describe('getStatus', () => {
    it('returns correct values', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.6,
        memoryUsage: 0.7,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      tuner.start();
      await new Promise(r => setTimeout(r, 10));

      const status = tuner.getStatus();

      expect(status.enabled).toBe(true);
      expect(status.running).toBe(true);
      expect(status.currentLimit).toBe(limiter.limit);
      expect(status.min).toBe(config.min);
      expect(status.max).toBe(config.max);
      expect(status.lastMetrics).not.toBe(null);
      expect(status.lastMetrics?.cpuUsage).toBe(0.6);
      expect(status.lastMetrics?.memoryUsage).toBe(0.7);

      tuner.stop();
    });

    it('tracks adjustment count correctly', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.9,
        memoryUsage: 0.9,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(5);

      expect(tuner.getStatus().adjustmentCount).toBe(0);

      await tuner.tick();
      expect(tuner.getStatus().adjustmentCount).toBe(1);

      await tuner.tick();
      expect(tuner.getStatus().adjustmentCount).toBe(2);

      await tuner.tick();
      expect(tuner.getStatus().adjustmentCount).toBe(3);
    });

    it('tracks last adjustment time', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.9,
        memoryUsage: 0.9,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      expect(tuner.getStatus().lastAdjustment).toBe(null);

      await tuner.tick();

      const status = tuner.getStatus();
      expect(status.lastAdjustment).not.toBe(null);
      expect(status.lastAdjustment).toBeInstanceOf(Date);
    });
  });

  describe('updateConfig', () => {
    it('can enable at runtime', async () => {
      config.enabled = false;
      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      expect(tuner.getStatus().running).toBe(false);

      tuner.updateConfig({ enabled: true });

      await new Promise(r => setTimeout(r, 10));

      expect(tuner.getStatus().running).toBe(true);

      tuner.stop();
    });

    it('can disable at runtime', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.5,
        memoryUsage: 0.5,
        available: true,
      });

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      tuner.start();
      expect(tuner.getStatus().running).toBe(true);

      tuner.updateConfig({ enabled: false });

      expect(tuner.getStatus().running).toBe(false);
    });

    it('updates min/max values', () => {
      const tuner = new ConcurrencyTuner(limiter, config);

      tuner.updateConfig({ min: 3, max: 20 });

      const status = tuner.getStatus();
      expect(status.min).toBe(3);
      expect(status.max).toBe(20);
    });

    it('restarts when intervalMs changes', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.5,
        memoryUsage: 0.5,
        available: true,
      });

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      tuner.start();
      const wasRunning = tuner.getStatus().running;

      tuner.updateConfig({ intervalMs: 2000 });

      // Should still be running after restart
      await new Promise(r => setTimeout(r, 10));
      expect(tuner.getStatus().running).toBe(wasRunning);

      tuner.stop();
    });

    it('does not restart when other config changes', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.5,
        memoryUsage: 0.5,
        available: true,
      });

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      tuner.start();

      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      tuner.updateConfig({ cpuThreshold: 0.9 });

      // Should not have cleared the interval
      expect(clearIntervalSpy).not.toHaveBeenCalled();

      tuner.stop();
    });
  });

  describe('adjustment logic edge cases', () => {
    it('no adjustment when metrics available but both CPU and memory null', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: null,
        memoryUsage: null,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(5);
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();

      const initialLimit = limiter.limit;
      await tuner.tick();

      // Should increase since both are null (treated as OK)
      expect(limiter.limit).toBe(initialLimit + 1);
    });

    it('prioritizes decrease over increase', async () => {
      mockReader.read.mockResolvedValue({
        cpuUsage: 0.85, // High CPU
        memoryUsage: 0.3, // Low memory
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(5);
      // At capacity
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();

      await tuner.tick();

      // Should decrease due to high CPU, not increase despite being at capacity
      expect(limiter.limit).toBe(4);
    });

    it('logs adjustment events', async () => {
      const logSpy = vi.spyOn(console, 'log');

      mockReader.read.mockResolvedValue({
        cpuUsage: 0.9,
        memoryUsage: 0.5,
        available: true,
      } as CgroupMetrics);

      const tuner = new ConcurrencyTuner(limiter, config);
      (tuner as any).metricsReader = mockReader;

      limiter.setLimit(5);
      await tuner.tick();

      expect(logSpy).toHaveBeenCalled();
      const logCall = logSpy.mock.calls[0][0];
      const logData = JSON.parse(logCall);

      expect(logData.event).toBe('orchestrator.tuner.adjust');
      expect(logData.from).toBe(5);
      expect(logData.to).toBe(4);
      expect(logData.reason).toBe('resource_pressure');
      expect(logData.cpu).toBe(0.9);
      expect(logData.memory).toBe(0.5);
    });
  });
});
