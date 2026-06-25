import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CgroupMetricsReader } from './cgroup-metrics';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('CgroupMetricsReader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isAvailable', () => {
    it('returns false on non-Linux (file read fails)', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT: no such file'));

      const reader = new CgroupMetricsReader();
      const available = await reader.isAvailable();

      expect(available).toBe(false);
      expect(fs.readFile).toHaveBeenCalledWith('/sys/fs/cgroup/cpu.stat', 'utf8');
    });

    it('returns true when cpu.stat is readable', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('usage_usec 1000000\n');

      const reader = new CgroupMetricsReader();
      const available = await reader.isAvailable();

      expect(available).toBe(true);
    });
  });

  describe('read', () => {
    it('returns unavailable on non-Linux', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

      const reader = new CgroupMetricsReader();
      const metrics = await reader.read();

      expect(metrics).toEqual({
        cpuUsage: null,
        memoryUsage: null,
        available: false,
      });
    });

    it('gracefully handles unexpected errors in read outer try-catch', async () => {
      // Make isAvailable throw to trigger the outer catch
      vi.mocked(fs.readFile).mockRejectedValue(new Error('File system error'));

      const reader = new CgroupMetricsReader();
      const metrics = await reader.read();

      expect(metrics).toEqual({
        cpuUsage: null,
        memoryUsage: null,
        available: false,
      });
    });
  });

  describe('CPU usage parsing', () => {
    it('returns null on first read (needs two samples)', async () => {
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') return 'usage_usec 1000000\n';
        if (path === '/sys/fs/cgroup/memory.current') return '1073741824\n';
        if (path === '/sys/fs/cgroup/memory.max') return '2147483648\n';
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();
      const metrics = await reader.read();

      expect(metrics.available).toBe(true);
      expect(metrics.cpuUsage).toBe(null); // First sample
      expect(metrics.memoryUsage).toBeCloseTo(0.5, 2);
    });

    it('calculates CPU delta correctly on second read', async () => {
      let cpuReadCount = 0;
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') {
          cpuReadCount++;
          // Each read() calls cpu.stat twice (isAvailable + _readCpuUsage)
          // We want the _readCpuUsage calls to increment: 1,000,000 then 1,100,000
          const actualCpuRead = Math.floor((cpuReadCount - 1) / 2);
          return `usage_usec ${1000000 + (actualCpuRead * 100000)}\n`;
        }
        if (path === '/sys/fs/cgroup/memory.current') return '1073741824\n';
        if (path === '/sys/fs/cgroup/memory.max') return '2147483648\n';
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();

      // First read
      const metrics1 = await reader.read();
      expect(metrics1.cpuUsage).toBe(null);

      // Wait 100ms
      await new Promise(r => setTimeout(r, 100));

      // Second read
      const metrics2 = await reader.read();
      expect(metrics2.available).toBe(true);
      expect(metrics2.cpuUsage).not.toBe(null);
      // Delta: 100,000 usec over ~100ms (100,000 usec) = ~1.0 (capped at 1.0)
      expect(metrics2.cpuUsage).toBeLessThanOrEqual(1.0);
      expect(metrics2.cpuUsage).toBeGreaterThan(0);
    });

    it('caps CPU usage at 1.0 even on multi-core', async () => {
      let cpuReadCount = 0;
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') {
          cpuReadCount++;
          // Each read() calls cpu.stat twice (isAvailable + _readCpuUsage)
          // Simulate multi-core: CPU delta > wall delta
          const actualCpuRead = Math.floor((cpuReadCount - 1) / 2);
          return `usage_usec ${actualCpuRead === 0 ? 0 : 500000}\n`;
        }
        if (path === '/sys/fs/cgroup/memory.current') return '1073741824\n';
        if (path === '/sys/fs/cgroup/memory.max') return '2147483648\n';
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();

      // First read
      await reader.read();

      // Wait 100ms
      await new Promise(r => setTimeout(r, 100));

      // Second read
      const metrics2 = await reader.read();
      expect(metrics2.cpuUsage).toBe(1.0); // Capped at 1.0
    });

    it('handles missing usage_usec field gracefully', async () => {
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') return 'some_other_field 12345\n';
        if (path === '/sys/fs/cgroup/memory.current') return '1073741824\n';
        if (path === '/sys/fs/cgroup/memory.max') return '2147483648\n';
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();
      const metrics = await reader.read();

      expect(metrics.available).toBe(true);
      expect(metrics.cpuUsage).toBe(null);
    });

    it('handles malformed usage_usec value', async () => {
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') return 'usage_usec not_a_number\n';
        if (path === '/sys/fs/cgroup/memory.current') return '1073741824\n';
        if (path === '/sys/fs/cgroup/memory.max') return '2147483648\n';
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();
      const metrics = await reader.read();

      expect(metrics.available).toBe(true);
      expect(metrics.cpuUsage).toBe(null);
    });
  });

  describe('Memory usage parsing', () => {
    it('parses memory.current and memory.max correctly', async () => {
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') return 'usage_usec 1000000\n';
        if (path === '/sys/fs/cgroup/memory.current') return '536870912\n'; // 512 MB
        if (path === '/sys/fs/cgroup/memory.max') return '1073741824\n'; // 1 GB
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();
      const metrics = await reader.read();

      expect(metrics.available).toBe(true);
      expect(metrics.memoryUsage).toBeCloseTo(0.5, 2);
    });

    it('returns null when memory.max is "max" (unlimited)', async () => {
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') return 'usage_usec 1000000\n';
        if (path === '/sys/fs/cgroup/memory.current') return '536870912\n';
        if (path === '/sys/fs/cgroup/memory.max') return 'max\n';
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();
      const metrics = await reader.read();

      expect(metrics.available).toBe(true);
      expect(metrics.memoryUsage).toBe(null); // Unlimited memory
    });

    it('returns null when memory.max is 0 or invalid', async () => {
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') return 'usage_usec 1000000\n';
        if (path === '/sys/fs/cgroup/memory.current') return '536870912\n';
        if (path === '/sys/fs/cgroup/memory.max') return '0\n';
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();
      const metrics = await reader.read();

      expect(metrics.available).toBe(true);
      expect(metrics.memoryUsage).toBe(null);
    });

    it('returns null when memory.current is malformed', async () => {
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') return 'usage_usec 1000000\n';
        if (path === '/sys/fs/cgroup/memory.current') return 'not_a_number\n';
        if (path === '/sys/fs/cgroup/memory.max') return '1073741824\n';
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();
      const metrics = await reader.read();

      expect(metrics.available).toBe(true);
      expect(metrics.memoryUsage).toBe(null);
    });

    it('handles memory file read errors gracefully', async () => {
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') return 'usage_usec 1000000\n';
        if (path === '/sys/fs/cgroup/memory.current') throw new Error('Permission denied');
        if (path === '/sys/fs/cgroup/memory.max') return '1073741824\n';
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();
      const metrics = await reader.read();

      expect(metrics.available).toBe(true);
      expect(metrics.memoryUsage).toBe(null);
    });
  });

  describe('Full integration', () => {
    it('returns both CPU and memory metrics when available', async () => {
      let cpuReadCount = 0;
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') {
          cpuReadCount++;
          // Each read() calls cpu.stat twice (isAvailable + _readCpuUsage)
          const actualCpuRead = Math.floor((cpuReadCount - 1) / 2);
          return `usage_usec ${1000000 + (actualCpuRead * 50000)}\n`;
        }
        if (path === '/sys/fs/cgroup/memory.current') return '805306368\n'; // 768 MB
        if (path === '/sys/fs/cgroup/memory.max') return '1073741824\n'; // 1 GB
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();

      // First read
      const metrics1 = await reader.read();
      expect(metrics1.available).toBe(true);
      expect(metrics1.cpuUsage).toBe(null);
      expect(metrics1.memoryUsage).toBeCloseTo(0.75, 2);

      // Wait 100ms
      await new Promise(r => setTimeout(r, 100));

      // Second read
      const metrics2 = await reader.read();
      expect(metrics2.available).toBe(true);
      expect(metrics2.cpuUsage).not.toBe(null);
      expect(metrics2.cpuUsage).toBeGreaterThan(0);
      expect(metrics2.memoryUsage).toBeCloseTo(0.75, 2);
    });

    it('handles partial availability (CPU available, memory unlimited)', async () => {
      let cpuReadCount = 0;
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path === '/sys/fs/cgroup/cpu.stat') {
          cpuReadCount++;
          const actualCpuRead = Math.floor((cpuReadCount - 1) / 2);
          return `usage_usec ${actualCpuRead * 100000}\n`;
        }
        if (path === '/sys/fs/cgroup/memory.current') return '536870912\n';
        if (path === '/sys/fs/cgroup/memory.max') return 'max\n';
        throw new Error('Unknown path');
      });

      const reader = new CgroupMetricsReader();

      // First read
      await reader.read();

      // Wait 100ms
      await new Promise(r => setTimeout(r, 100));

      // Second read
      const metrics = await reader.read();
      expect(metrics.available).toBe(true);
      expect(metrics.cpuUsage).not.toBe(null);
      expect(metrics.memoryUsage).toBe(null); // Unlimited
    });
  });
});
