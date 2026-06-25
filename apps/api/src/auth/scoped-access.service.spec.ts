import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { AuthUser } from './auth.service.js';
import { ScopedAccessService } from './scoped-access.service.js';

describe('ScopedAccessService', () => {
  function createService(options?: { authEnabled?: boolean; allowed?: boolean }) {
    const authEnabled = options?.authEnabled ?? true;
    const allowed = options?.allowed ?? true;

    const authService = {
      isEnabled: vi.fn(() => authEnabled),
    };

    const accessService = {
      can: vi.fn(async () => ({ allowed, source: allowed ? 'test' : 'denied' })),
      evaluateScope: vi.fn(() => ({ scope_required: true, scope_matched: allowed })),
    };

    const service = new ScopedAccessService(authService as any, accessService as any);
    return { service, authService, accessService };
  }

  it('bypasses scoped checks when auth is disabled', async () => {
    const { service, accessService } = createService({ authEnabled: false, allowed: false });

    const result = await service.can({
      org_id: 'org_test',
      permission: 'orgdocs:read',
      resource: { type: 'orgdocs', id: '/docs/a.md', action: 'read' },
    });

    expect(result).toBe(true);
    expect(accessService.can).not.toHaveBeenCalled();
  });

  it('resolves user principal and delegates to AccessService', async () => {
    const { service, accessService } = createService({ authEnabled: true, allowed: true });
    const user: AuthUser = { user_id: 'user_123' };

    const result = await service.can({
      org_id: 'org_test',
      project_id: 'proj_123',
      permission: 'orgdocs:read',
      user,
      resource: { type: 'orgdocs', id: '/docs/a.md', action: 'read' },
    });

    expect(result).toBe(true);
    expect(accessService.can).toHaveBeenCalledWith({
      org_id: 'org_test',
      principal_type: 'user',
      principal_id: 'user_123',
      project_id: 'proj_123',
      permission: 'orgdocs:read',
      resource: { type: 'orgdocs', id: '/docs/a.md', action: 'read' },
    });
  });

  it('resolves service principal identity when token principal is service principal', async () => {
    const { service, accessService } = createService({ authEnabled: true, allowed: true });
    const user: AuthUser = { user_id: 'sp_123', is_service_principal: true };

    await service.can({
      org_id: 'org_test',
      permission: 'orgfs:write',
      user,
      resource: { type: 'orgfs', id: '/groups/pm/spec.md', action: 'write' },
    });

    expect(accessService.can).toHaveBeenCalledWith({
      org_id: 'org_test',
      principal_type: 'service_principal',
      principal_id: 'sp_123',
      project_id: undefined,
      permission: 'orgfs:write',
      resource: { type: 'orgfs', id: '/groups/pm/spec.md', action: 'write' },
    });
  });

  it('throws unauthorized when auth is enabled but request user is missing', async () => {
    const { service } = createService({ authEnabled: true, allowed: true });

    await expect(
      service.can({
        org_id: 'org_test',
        permission: 'orgdocs:read',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('assert throws a 403 resource_access_denied error when scoped check fails', async () => {
    const { service } = createService({ authEnabled: true, allowed: false });
    const user: AuthUser = { user_id: 'user_123' };

    await expect(
      service.assert({
        org_id: 'org_test',
        permission: 'orgdocs:write',
        user,
        resource: { type: 'orgdocs', id: '/groups/eng/spec.md', action: 'write' },
      }),
    ).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({
        error: expect.objectContaining({
          code: 'resource_access_denied',
        }),
      }),
    });
  });

  it('preserves legacy job-token permission-only behavior when no scope claim is present', async () => {
    const { service, accessService } = createService({ authEnabled: true, allowed: false });
    const user: AuthUser = {
      user_id: 'user_job',
      is_job_token: true,
      permissions: ['orgfs:write'],
    };

    const result = await service.can({
      org_id: 'org_test',
      permission: 'orgfs:write',
      user,
      resource: { type: 'orgfs', id: '/groups/projects/project-b/x.yaml', action: 'write' },
    });

    expect(result).toBe(true);
    expect(accessService.can).not.toHaveBeenCalled();
    expect(accessService.evaluateScope).not.toHaveBeenCalled();
  });

  it('evaluates resource scope for scoped job tokens', async () => {
    const { service, accessService } = createService({ authEnabled: true, allowed: true });
    const user: AuthUser = {
      user_id: 'user_job',
      is_job_token: true,
      permissions: ['orgfs:write'],
      scope: { orgfs: { allow_prefixes: ['/groups/projects/project-a/**'] } },
    };

    const result = await service.can({
      org_id: 'org_test',
      permission: 'orgfs:write',
      user,
      resource: { type: 'orgfs', id: '/groups/projects/project-a/x.yaml', action: 'write' },
    });

    expect(result).toBe(true);
    expect(accessService.evaluateScope).toHaveBeenCalledWith(
      user.scope,
      'orgfs:write',
      { type: 'orgfs', id: '/groups/projects/project-a/x.yaml', action: 'write' },
    );
  });

  it('denies scoped job tokens when the scope evaluator misses', async () => {
    const { service } = createService({ authEnabled: true, allowed: false });
    const user: AuthUser = {
      user_id: 'user_job',
      is_job_token: true,
      permissions: ['cloud_fs:read'],
      scope: { cloud_fs: { allow_mount_ids: ['mount_a'] } },
    };

    const result = await service.can({
      org_id: 'org_test',
      permission: 'cloud_fs:read',
      user,
      resource: { type: 'cloud_fs', id: 'mount_b', action: 'read' },
    });

    expect(result).toBe(false);
  });
});
