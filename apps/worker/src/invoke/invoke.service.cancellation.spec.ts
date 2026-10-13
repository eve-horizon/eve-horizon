import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessInvocation } from '@eve/shared';
import { InvokeService } from './invoke.service.js';

afterEach(() => vi.restoreAllMocks());
const invocation = { jobId: 'job_1', attemptId: 'att_1', projectId: 'proj_1', text: '', workspacePath: '/tmp/eve-cancellation-test' } as unknown as HarnessInvocation;

describe('agent cancellation', () => {
  it('rejects a cancelled job before starting execution', async () => {
    const service = new InvokeService(null as never);
    (service as any).jobs = { findById: vi.fn().mockResolvedValue({ phase: 'cancelled' }) };
    const execute = vi.spyOn(service as any, 'executeCancellable');
    expect(await service.execute(invocation)).toMatchObject({ success: false, exitCode: 130, error: expect.stringContaining('job_cancelled') });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not publish a successful result when cancellation wins the completion race', async () => {
    const service = new InvokeService(null as never);
    let phase = 'active';
    (service as any).jobs = { findById: vi.fn(async () => ({ phase })) };
    vi.spyOn(service as any, 'executeCancellable').mockImplementation(async () => {
      phase = 'cancelled';
      return { attemptId: invocation.attemptId, success: true, exitCode: 0 };
    });
    expect(await service.execute(invocation)).toMatchObject({ success: false, exitCode: 130, error: expect.stringContaining('job_cancelled') });
  });
});
