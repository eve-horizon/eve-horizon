import { CgroupMetricsReader, CgroupMetrics } from './cgroup-metrics';
import { ConcurrencyLimiter } from './concurrency-limiter';

export interface TunerConfig {
  enabled: boolean;
  min: number;
  max: number;
  intervalMs: number;
  cpuThreshold: number;
  memoryThreshold: number;
}

export interface TunerStatus {
  enabled: boolean;
  running: boolean;
  currentLimit: number;
  min: number;
  max: number;
  lastMetrics: CgroupMetrics | null;
  lastAdjustment: Date | null;
  adjustmentCount: number;
}

export class ConcurrencyTuner {
  private metricsReader = new CgroupMetricsReader();
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private _running = false;
  private _lastMetrics: CgroupMetrics | null = null;
  private _lastAdjustment: Date | null = null;
  private _adjustmentCount = 0;

  constructor(
    private readonly limiter: ConcurrencyLimiter,
    private config: TunerConfig,
  ) {}

  /** Start the tuning loop. No-op if disabled or already running. */
  start(): void {
    if (!this.config.enabled || this._running) return;

    // Check cgroup availability on first tick, then run periodic
    this._running = true;
    this.intervalId = setInterval(() => this.tick(), this.config.intervalMs);
    // Immediate first tick
    this.tick();
  }

  /** Stop the tuning loop. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this._running = false;
  }

  /** Single tuning iteration */
  async tick(): Promise<void> {
    const metrics = await this.metricsReader.read();
    this._lastMetrics = metrics;

    if (!metrics.available) return; // Not in a cgroup environment

    const currentLimit = this.limiter.limit;
    let newLimit = currentLimit;

    // DECREASE if CPU or memory above threshold
    const cpuHigh = metrics.cpuUsage !== null && metrics.cpuUsage >= this.config.cpuThreshold;
    const memHigh = metrics.memoryUsage !== null && metrics.memoryUsage >= this.config.memoryThreshold;

    if (cpuHigh || memHigh) {
      newLimit = Math.max(this.config.min, currentLimit - 1);
    }
    // INCREASE if both CPU and memory well below thresholds AND there's backlog potential
    else if (this.limiter.hasCapacity === false || this.limiter.inFlight >= currentLimit) {
      // There's demand (limiter at capacity) — try to give more room
      const cpuOk = metrics.cpuUsage === null || metrics.cpuUsage < this.config.cpuThreshold * 0.7;
      const memOk = metrics.memoryUsage === null || metrics.memoryUsage < this.config.memoryThreshold * 0.7;
      if (cpuOk && memOk) {
        newLimit = Math.min(this.config.max, currentLimit + 1);
      }
    }

    if (newLimit !== currentLimit) {
      this.limiter.setLimit(newLimit);
      this._lastAdjustment = new Date();
      this._adjustmentCount++;
      console.log(
        JSON.stringify({
          event: 'orchestrator.tuner.adjust',
          from: currentLimit,
          to: newLimit,
          reason: (cpuHigh || memHigh) ? 'resource_pressure' : 'demand_headroom',
          cpu: metrics.cpuUsage,
          memory: metrics.memoryUsage,
        }),
      );
    }
  }

  /** Get current tuner status for admin API */
  getStatus(): TunerStatus {
    return {
      enabled: this.config.enabled,
      running: this._running,
      currentLimit: this.limiter.limit,
      min: this.config.min,
      max: this.config.max,
      lastMetrics: this._lastMetrics,
      lastAdjustment: this._lastAdjustment,
      adjustmentCount: this._adjustmentCount,
    };
  }

  /** Update config at runtime */
  updateConfig(partial: Partial<TunerConfig>): void {
    const wasEnabled = this.config.enabled;
    Object.assign(this.config, partial);

    if (this.config.enabled && !wasEnabled) {
      this.start();
    } else if (!this.config.enabled && wasEnabled) {
      this.stop();
    }

    // If interval changed, restart
    if (partial.intervalMs && this._running) {
      this.stop();
      this.start();
    }
  }
}
