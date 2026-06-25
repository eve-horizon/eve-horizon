import { describe, expect, it, vi } from 'vitest';
import { ActionExecutorService } from './action-executor.service.js';
import { DeployFailureError } from '../deployer/deploy-failure.js';

describe('ActionExecutorService deploy readiness failure', () => {
  it('throws a classified DeployFailureError with cluster snapshot on readiness timeout', async () => {
    const deployer = {
      getDeploymentStatus: vi.fn().mockResolvedValue({
        envId: 'env_1',
        state: 'deploying',
        namespace: 'eve-proj-staging',
        k8sStatus: {
          ready: false,
          availableReplicas: 0,
          desiredReplicas: 1,
          conditions: [],
        },
      }),
      collectClusterSnapshot: vi.fn().mockResolvedValue({
        namespace: 'eve-proj-staging',
        capturedAt: '2026-04-21T12:00:00.000Z',
        pods: [
          {
            name: 'api-123',
            namespace: 'eve-proj-staging',
            phase: 'Running',
            ready: false,
            restartCount: 5,
            service: 'api',
            containers: [
              {
                name: 'api',
                ready: false,
                restartCount: 5,
                state: 'waiting',
                waitingReason: 'CrashLoopBackOff',
                lastTerminatedExitCode: 1,
                lastTerminatedReason: 'Error',
              },
            ],
          },
        ],
      }),
    };

    const service = new ActionExecutorService(null as any, deployer as any, {} as any);
    (service as any).envs = {
      findById: vi.fn().mockResolvedValue({
        id: 'env_1',
        project_id: 'proj_1',
        name: 'staging',
      }),
    };
    (service as any).logs = {
      appendLog: vi.fn().mockResolvedValue(undefined),
    };

    let thrown: unknown;
    try {
      await (service as any).waitForDeployReady('env_1', 0, 'att_1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DeployFailureError);
    expect(thrown).toMatchObject({
      name: 'DeployFailureError',
      manifestApplied: true,
      failure: {
        kind: 'app_crash_loop',
        service: 'api',
        pod: 'api-123',
      },
      snapshot: {
        namespace: 'eve-proj-staging',
      },
    });
  });

  it('does not advance last_applied_release_id for pre-apply deploy failures', async () => {
    const update = vi.fn().mockResolvedValue(null);
    const service = new ActionExecutorService(null as any, {} as any, {} as any);
    (service as any).envs = { update };

    await (service as any).recordDeployFailure(
      'env_1',
      'rel_1',
      new Error('namespace create failed'),
    );

    expect(update).toHaveBeenCalledWith(
      'env_1',
      expect.objectContaining({
        last_applied_release_id: undefined,
        last_failed_release_id: 'rel_1',
        deploy_status: 'failed',
      }),
    );
  });
});
