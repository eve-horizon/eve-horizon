import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { ScriptExecutorController } from './script-executor.controller.js';

const sharedMocks = vi.hoisted(() => ({
  emitRunnerEvent: vi.fn(),
  withCorrelationContext: vi.fn((_context, fn) => fn()),
}));

vi.mock('@eve/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/shared')>();
  return {
    ...actual,
    emitRunnerEvent: sharedMocks.emitRunnerEvent,
    withCorrelationContext: sharedMocks.withCorrelationContext,
  };
});

describe('ScriptExecutorController', () => {
  beforeEach(() => {
    sharedMocks.emitRunnerEvent.mockReset();
    sharedMocks.emitRunnerEvent.mockResolvedValue({ success: true });
    sharedMocks.withCorrelationContext.mockClear();
  });

  it('quick-acks valid requests and emits runner completion in the background', async () => {
    const service = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: 'done\n',
        stderr: '',
        durationMs: 42,
      }),
    };
    const controller = new ScriptExecutorController(service as any);

    await expect(controller.execute({
      jobId: 'job_1',
      attemptId: 'att_1',
      projectId: 'proj_1',
    })).resolves.toEqual({ accepted: true, attemptId: 'att_1' });

    await vi.waitFor(() => {
      expect(sharedMocks.emitRunnerEvent).toHaveBeenCalledWith('proj_1', 'runner.completed', {
        attemptId: 'att_1',
        jobId: 'job_1',
        result: expect.objectContaining({
          attemptId: 'att_1',
          success: true,
          exitCode: 0,
          resultText: 'done',
        }),
      });
    });
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.execute)).toBe(202);
  });

  it('rejects missing projectId without invoking the executor', async () => {
    const service = { execute: vi.fn() };
    const controller = new ScriptExecutorController(service as any);

    await expect(controller.execute({ jobId: 'job_1', attemptId: 'att_1' })).resolves.toEqual({
      accepted: false,
      error: 'Missing required fields: attemptId, jobId, or projectId',
    });

    expect(service.execute).not.toHaveBeenCalled();
    expect(sharedMocks.emitRunnerEvent).not.toHaveBeenCalled();
  });

  it('emits runner.failed when the executor throws', async () => {
    const service = {
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const controller = new ScriptExecutorController(service as any);

    await controller.execute({ jobId: 'job_1', attemptId: 'att_1', projectId: 'proj_1' });

    await vi.waitFor(() => {
      expect(sharedMocks.emitRunnerEvent).toHaveBeenCalledWith('proj_1', 'runner.failed', {
        attemptId: 'att_1',
        jobId: 'job_1',
        error: 'boom',
        exitCode: 1,
      });
    });
  });
});
