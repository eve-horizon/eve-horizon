import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptExecutorService } from './script-executor.service.js';

afterEach(() => vi.restoreAllMocks());
describe('script cancellation', () => {
  it('rejects a cancelled job before preparing its workspace or starting a runner', async () => {
    const service = new ScriptExecutorService(null as never);
    (service as any).jobs = { findById: vi.fn().mockResolvedValue({ phase: 'cancelled' }) };
    const execute = vi.spyOn(service as any, 'executeCancellable');
    expect(await service.execute('job_1', 'att_1')).toMatchObject({ success: false, exitCode: 130, errorCode: 'job_cancelled' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not publish a successful result when cancellation wins the completion race', async () => {
    const service = new ScriptExecutorService(null as never);
    let phase = 'active';
    (service as any).jobs = { findById: vi.fn(async () => ({ phase })) };
    vi.spyOn(service as any, 'executeCancellable').mockImplementation(async () => {
      phase = 'cancelled';
      return { success: true, exitCode: 0, durationMs: 1 };
    });
    expect(await service.execute('job_1', 'att_1')).toMatchObject({ success: false, exitCode: 130, errorCode: 'job_cancelled' });
  });
});
