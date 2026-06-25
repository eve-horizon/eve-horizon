import { describe, expect, it, vi } from 'vitest';
import { ActionExecutorService } from './action-executor.service.js';

describe('ActionExecutorService.handleDeploy persists namespace', () => {
  it('writes namespace alongside release pointers on successful deploy', async () => {
    const update = vi.fn().mockResolvedValue(null);
    const deployer = {
      deploy: vi.fn().mockResolvedValue({
        envId: 'env_1',
        currentReleaseId: 'rel_1',
        state: 'ready',
        namespace: 'eve-acme-app-staging',
        k8sStatus: {
          ready: true,
          availableReplicas: 1,
          desiredReplicas: 1,
          conditions: [],
        },
      }),
      computePreviewUrl: vi.fn(),
    };

    const service = new ActionExecutorService(null as any, deployer as any, {} as any);
    (service as any).envs = {
      findByProjectAndName: vi.fn().mockResolvedValue({
        id: 'env_1',
        project_id: 'proj_1',
        name: 'staging',
      }),
      update,
    };
    (service as any).appendLog = vi.fn().mockResolvedValue(undefined);
    (service as any).computePreviewUrl = vi.fn().mockResolvedValue('https://app.example');

    await (service as any).handleDeploy('att_1', 'proj_1', {
      env_name: 'staging',
      release_id: 'rel_1',
    });

    expect(update).toHaveBeenCalledWith(
      'env_1',
      expect.objectContaining({
        current_release_id: 'rel_1',
        last_applied_release_id: 'rel_1',
        deploy_status: 'deployed',
        namespace: 'eve-acme-app-staging',
      }),
    );
  });

  it('omits namespace from update when deployer did not return one', async () => {
    const update = vi.fn().mockResolvedValue(null);
    const deployer = {
      deploy: vi.fn().mockResolvedValue({
        envId: 'env_1',
        currentReleaseId: 'rel_1',
        state: 'ready',
        k8sStatus: {
          ready: true,
          availableReplicas: 1,
          desiredReplicas: 1,
          conditions: [],
        },
      }),
    };

    const service = new ActionExecutorService(null as any, deployer as any, {} as any);
    (service as any).envs = {
      findByProjectAndName: vi.fn().mockResolvedValue({
        id: 'env_1',
        project_id: 'proj_1',
        name: 'staging',
      }),
      update,
    };
    (service as any).appendLog = vi.fn().mockResolvedValue(undefined);
    (service as any).computePreviewUrl = vi.fn().mockResolvedValue(null);

    await (service as any).handleDeploy('att_1', 'proj_1', {
      env_name: 'staging',
      release_id: 'rel_1',
    });

    const args = update.mock.calls[0][1];
    expect(args).not.toHaveProperty('namespace');
    expect(args).toMatchObject({ deploy_status: 'deployed' });
  });
});
