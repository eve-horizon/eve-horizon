import { readFile } from 'node:fs/promises';

/**
 * Reads CPU and memory metrics from cgroup v2 filesystem.
 * Used by the auto-tuner to make concurrency decisions.
 *
 * Cgroup v2 paths:
 *   CPU:    /sys/fs/cgroup/cpu.stat  (usage_usec field)
 *   Memory: /sys/fs/cgroup/memory.current (bytes used)
 *           /sys/fs/cgroup/memory.max (limit in bytes, or "max" for unlimited)
 */

export interface CgroupMetrics {
  /** CPU usage as a fraction 0..1 over the sample period. null if unavailable. */
  cpuUsage: number | null;
  /** Memory usage as a fraction 0..1 of the cgroup limit. null if unavailable. */
  memoryUsage: number | null;
  /** Whether cgroup v2 filesystem is available */
  available: boolean;
}

export class CgroupMetricsReader {
  // Internal state for CPU delta calculation
  private lastCpuUsec: number | null = null;
  private lastTimestamp: number | null = null;

  /**
   * Read current cgroup metrics.
   * Returns null values gracefully on non-Linux or when cgroup fs unavailable.
   * Never throws — returns { available: false } on error.
   */
  async read(): Promise<CgroupMetrics> {
    try {
      const available = await this.isAvailable();
      if (!available) {
        return { cpuUsage: null, memoryUsage: null, available: false };
      }

      const [cpuUsage, memoryUsage] = await Promise.all([
        this._readCpuUsage(),
        this._readMemoryUsage(),
      ]);

      return {
        cpuUsage,
        memoryUsage,
        available: true,
      };
    } catch (err) {
      // Gracefully handle any unexpected errors
      return { cpuUsage: null, memoryUsage: null, available: false };
    }
  }

  /**
   * Check if cgroup v2 filesystem is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Check for cpu.stat as a proxy for cgroup v2 availability
      await readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read CPU usage as a fraction 0..1.
   * Requires two samples to calculate delta — returns null on first call.
   */
  private async _readCpuUsage(): Promise<number | null> {
    try {
      const content = await readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
      const match = content.match(/usage_usec\s+(\d+)/);
      if (!match) return null;

      const currentUsec = parseInt(match[1], 10);
      const currentTimestamp = Date.now();

      // Need two samples for delta calculation
      if (this.lastCpuUsec === null || this.lastTimestamp === null) {
        this.lastCpuUsec = currentUsec;
        this.lastTimestamp = currentTimestamp;
        return null;
      }

      // Calculate delta: (CPU microseconds elapsed) / (wall-clock microseconds elapsed)
      const cpuDeltaUsec = currentUsec - this.lastCpuUsec;
      const wallDeltaUsec = (currentTimestamp - this.lastTimestamp) * 1000; // ms to μs

      // Update state for next read
      this.lastCpuUsec = currentUsec;
      this.lastTimestamp = currentTimestamp;

      if (wallDeltaUsec <= 0) return null; // Avoid division by zero

      // CPU fraction: can exceed 1.0 on multi-core, but we cap at 1.0
      const fraction = cpuDeltaUsec / wallDeltaUsec;
      return Math.min(fraction, 1.0);
    } catch {
      return null;
    }
  }

  /**
   * Read memory usage as a fraction 0..1 of the cgroup limit.
   * Returns null if limit is "max" (unlimited).
   */
  private async _readMemoryUsage(): Promise<number | null> {
    try {
      const [currentStr, maxStr] = await Promise.all([
        readFile('/sys/fs/cgroup/memory.current', 'utf8'),
        readFile('/sys/fs/cgroup/memory.max', 'utf8'),
      ]);

      const current = parseInt(currentStr.trim(), 10);
      const maxTrimmed = maxStr.trim();

      // If limit is "max", memory is unlimited
      if (maxTrimmed === 'max') return null;

      const max = parseInt(maxTrimmed, 10);
      if (max <= 0 || isNaN(current) || isNaN(max)) return null;

      return current / max;
    } catch {
      return null;
    }
  }
}
