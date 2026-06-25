import { describe, expect, it, vi } from 'vitest';
import { WorkflowsController } from './workflows.controller.js';

describe('WorkflowsController', () => {
  it('gates request-supplied secret env_overrides like direct job creation', async () => {
    const workflowsService = {
      invoke: vi.fn().mockResolvedValue({ job_id: 'job_1', status: 'active' }),
    };
    const rbac = {
      requirePermissions: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new WorkflowsController(workflowsService as never, rbac as never);
    const user = { user_id: 'user_1' };

    await controller.invoke(
      'proj_123',
      'research',
      { env_overrides: { WEB_SEARCH_API_KEY: '${secret.WEB_SEARCH_API_KEY}' } },
      { user } as never,
      'false',
    );

    expect(rbac.requirePermissions).toHaveBeenCalledWith(
      user,
      'proj_123',
      ['jobs:harness_override', 'secrets:read'],
    );
    expect(workflowsService.invoke).toHaveBeenCalledWith(
      'proj_123',
      'research',
      { env_overrides: { WEB_SEARCH_API_KEY: '${secret.WEB_SEARCH_API_KEY}' } },
      false,
      'user_1',
    );
  });

  it('requires harness override permission for literal request env_overrides', async () => {
    const workflowsService = {
      invoke: vi.fn().mockResolvedValue({ job_id: 'job_1', status: 'active' }),
    };
    const rbac = {
      requirePermissions: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new WorkflowsController(workflowsService as never, rbac as never);
    const user = { user_id: 'user_1' };

    await controller.invoke(
      'proj_123',
      'research',
      { env_overrides: { MODE: 'test' } },
      { user } as never,
      undefined,
    );

    expect(rbac.requirePermissions).toHaveBeenCalledWith(
      user,
      'proj_123',
      ['jobs:harness_override'],
    );
  });

  it('requires harness override permission for request-supplied token scope', async () => {
    const workflowsService = {
      invoke: vi.fn().mockResolvedValue({ job_id: 'job_1', status: 'active' }),
    };
    const rbac = {
      requirePermissions: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new WorkflowsController(workflowsService as never, rbac as never);
    const user = { user_id: 'user_1' };
    const body = {
      scope: {
        orgfs: { allow_prefixes: ['/groups/projects/project-a/**'] },
      },
    };

    await controller.invoke(
      'proj_123',
      'research',
      body,
      { user } as never,
      undefined,
    );

    expect(rbac.requirePermissions).toHaveBeenCalledWith(
      user,
      'proj_123',
      ['jobs:harness_override'],
    );
    expect(workflowsService.invoke).toHaveBeenCalledWith(
      'proj_123',
      'research',
      body,
      false,
      'user_1',
    );
  });
});
