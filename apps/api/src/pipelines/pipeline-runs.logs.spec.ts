import { describe, expect, it, vi } from 'vitest';
import { PipelineRunsService } from './pipeline-runs.service.js';

describe('PipelineRunsService getRunLogs', () => {
  it('includes attempt logs for job-mode pipeline runs', async () => {
    const service = new PipelineRunsService(null as any, {} as any);
    const createdAt = new Date('2026-04-21T12:00:00.000Z');

    (service as any).runs = {
      findRunById: vi.fn().mockResolvedValue({
        id: 'run_1',
        project_id: 'proj_1',
        run_mode: 'jobs',
      }),
    };
    (service as any).expander = {
      listJobsForRun: vi.fn().mockResolvedValue({
        jobs: [
          {
            id: 'job_1',
            step_name: 'deploy',
            title: 'Deploy',
            phase: 'cancelled',
            close_reason: 'Deploy failed',
            updated_at: '2026-04-21T12:01:00.000Z',
          },
        ],
      }),
    };
    (service as any).jobs = {
      listAttempts: vi.fn().mockResolvedValue([
        {
          id: 'att_1',
          attempt_number: 1,
        },
      ]),
    };
    (service as any).logs = {
      listLogs: vi.fn().mockResolvedValue([
        {
          seq: 1,
          type: 'error',
          content: {
            timestamp: '2026-04-21T12:00:01.000Z',
            message: '[app_crash_loop] container exited 1',
            error_context: {
              kind: 'app_crash_loop',
              service: 'api',
              pod: 'api-123',
            },
            cluster_snapshot: {
              namespace: 'eve-proj-staging',
              pods: [{ name: 'api-123', phase: 'Running', restartCount: 5 }],
            },
          },
          created_at: createdAt,
        },
      ]),
    };

    const result = await service.getRunLogs('run_1', {});

    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toMatchObject({
      step_name: 'deploy',
      seq: 1,
      type: 'error',
      timestamp: '2026-04-21T12:00:01.000Z',
    });
    expect(result.logs[0].content.error_context).toMatchObject({
      kind: 'app_crash_loop',
      service: 'api',
      pod: 'api-123',
    });
    expect(result.logs[0].content.cluster_snapshot).toMatchObject({
      namespace: 'eve-proj-staging',
    });
  });
});
