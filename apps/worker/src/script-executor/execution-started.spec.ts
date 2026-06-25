import { describe, expect, it, vi } from 'vitest';
import { ScriptExecutorService } from './script-executor.service.js';
import { ActionExecutorService } from '../action-executor/action-executor.service.js';

describe('worker execution start markers', () => {
  it('marks script attempts as execution-started before workspace setup', async () => {
    const markExecutionStarted = vi.fn().mockResolvedValue(undefined);
    const service = new ScriptExecutorService(null as any);
    (service as any).jobs = {
      findById: vi.fn().mockResolvedValue({
        id: 'job_1',
        project_id: 'proj_1',
        execution_type: 'script',
        script_command: 'echo ok',
      }),
      markExecutionStarted,
    };
    (service as any).appendLog = vi.fn().mockResolvedValue(undefined);

    const result = await service.execute('job_1', 'att_1');

    expect(markExecutionStarted).toHaveBeenCalledWith('att_1');
    expect(result.success).toBe(false);
  });

  it('marks action attempts as execution-started before action setup', async () => {
    const markExecutionStarted = vi.fn().mockResolvedValue(undefined);
    const service = new ActionExecutorService(null as any, {} as any, {} as any);
    (service as any).jobs = {
      findById: vi.fn().mockResolvedValue({
        id: 'job_1',
        project_id: 'proj_1',
        execution_type: 'action',
        action_type: 'notify',
        action_input: {},
      }),
      markExecutionStarted,
    };
    (service as any).appendLog = vi.fn().mockResolvedValue(undefined);
    (service as any).resolveActionInput = vi.fn().mockResolvedValue({});
    (service as any).jobs.findById.mockResolvedValue({
      id: 'job_1',
      project_id: 'proj_1',
      execution_type: 'action',
      action_type: 'unsupported',
      action_input: {},
    });

    const result = await service.execute('job_1', 'att_1');

    expect(markExecutionStarted).toHaveBeenCalledWith('att_1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unsupported action type: unsupported');
  });
});
