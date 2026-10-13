import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchJobCancellation } from '../job-cancellation.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('job cancellation monitor', () => {
  it('detects cancellation before execution and at the final check', async () => {
    let phase = 'active';
    const monitor = await watchJobCancellation(async () => phase);
    expect(monitor.signal.aborted).toBe(false);
    phase = 'cancelled';
    await monitor.check();
    expect(monitor.signal.aborted).toBe(true);
    expect(monitor.signal.reason.message).toContain('job_cancelled');
    monitor.stop();
    const alreadyCancelled = await watchJobCancellation(async () => 'cancelled');
    expect(alreadyCancelled.signal.aborted).toBe(true);
    alreadyCancelled.stop();
  });

  it('polls idle jobs and stops polling after cleanup', async () => {
    vi.useFakeTimers();
    let phase = 'active';
    const read = vi.fn(async () => phase);
    const monitor = await watchJobCancellation(read);
    phase = 'cancelled';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(monitor.signal.aborted).toBe(true);
    monitor.stop();
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overlap reads or act on a stale response after cleanup', async () => {
    vi.useFakeTimers();
    let complete: (phase: string) => void = () => {};
    const read = vi.fn().mockResolvedValueOnce('active').mockImplementation(() => new Promise<string>((resolve) => { complete = resolve; }));
    const monitor = await watchJobCancellation(read);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(read).toHaveBeenCalledTimes(2);
    monitor.stop();
    complete('cancelled');
    await Promise.resolve();
    expect(monitor.signal.aborted).toBe(false);
  });

  it('recovers from a transient read error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = vi.fn().mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValue('cancelled');
    const monitor = await watchJobCancellation(read);
    expect(monitor.signal.aborted).toBe(false);
    await monitor.check();
    expect(monitor.signal.aborted).toBe(true);
    monitor.stop();
  });
});
