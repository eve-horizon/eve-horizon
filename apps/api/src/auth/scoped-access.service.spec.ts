import { describe, expect, it, vi } from 'vitest';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
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

    // Legacy job-token cases below carry org_test, so the token is always in scope here.
    const rbacService = {
      getProjectScope: vi.fn(async (projectInput: string) => ({ id: projectInput, org_id: 'org_test' })),
      getOrgScopeId: vi.fn(async (orgInput: string) => orgInput),
    };

    const service = new ScopedAccessService(authService as any, accessService as any, rbacService as any);
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
      org_id: 'org_test',
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
      org_id: 'org_test',
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
      org_id: 'org_test',
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

describe('ScopedAccessService job tokens and the org or project they address', () => {
  const projectOrg: Record<string, string> = { proj_a: 'org_a', proj_a2: 'org_a', proj_b: 'org_b' };
  const projectSlugs: Record<string, string> = { alpha: 'proj_a' };
  const orgSlugs: Record<string, string> = { acme: 'org_a', other: 'org_b' };
  const jobToken: AuthUser = {
    user_id: 'user_job',
    is_job_token: true,
    job_id: 'demo-abc12345',
    project_id: 'proj_a',
    org_id: 'org_a',
    permissions: ['envdb:read', 'orgdocs:read', 'orgfs:write'],
  };

  function createService() {
    const authService = { isEnabled: vi.fn(() => true) };
    const accessService = {
      can: vi.fn(async () => ({ allowed: true, source: 'test' })),
      evaluateScope: vi.fn(() => ({ scope_required: true, scope_matched: true })),
    };
    const rbacService = {
      getProjectScope: vi.fn(async (projectInput: string) => {
        const id = projectSlugs[projectInput] ?? projectInput;
        const orgId = projectOrg[id];
        if (!orgId) throw new NotFoundException('Project not found');
        return { id, org_id: orgId };
      }),
      getOrgScopeId: vi.fn(async (orgInput: string) => {
        const id = orgSlugs[orgInput] ?? orgInput;
        if (!Object.values(projectOrg).includes(id)) throw new NotFoundException('Org not found');
        return id;
      }),
    };
    const service = new ScopedAccessService(authService as any, accessService as any, rbacService as any);
    return { service, accessService, rbacService };
  }

  it('refuses a job token for another org', async () => {
    const { service } = createService();

    await expect(service.can({ org_id: 'org_b', permission: 'orgdocs:read', user: jobToken })).resolves.toBe(false);
  });

  it('refuses a job token for another project, in its own org or another', async () => {
    const { service } = createService();

    await expect(
      service.can({ org_id: 'org_a', project_id: 'proj_a2', permission: 'envdb:read', user: jobToken }),
    ).resolves.toBe(false);
    await expect(
      service.can({ org_id: 'org_b', project_id: 'proj_b', permission: 'envdb:read', user: jobToken }),
    ).resolves.toBe(false);
  });

  it('allows a job token on its own org and project, by id or by slug', async () => {
    const { service } = createService();

    await expect(service.can({ org_id: 'org_a', permission: 'orgdocs:read', user: jobToken })).resolves.toBe(true);
    await expect(
      service.can({ org_id: 'org_a', project_id: 'proj_a', permission: 'envdb:read', user: jobToken }),
    ).resolves.toBe(true);
    await expect(
      service.can({ org_id: 'org_a', project_id: 'alpha', permission: 'envdb:read', user: jobToken }),
    ).resolves.toBe(true);
    await expect(service.can({ org_id: 'acme', permission: 'orgdocs:read', user: jobToken })).resolves.toBe(true);
  });

  it('refuses a job token for another org addressed by slug', async () => {
    const { service } = createService();

    await expect(service.can({ org_id: 'other', permission: 'orgdocs:read', user: jobToken })).resolves.toBe(false);
  });

  it("judges a job token without an org claim by its project's org", async () => {
    const { service } = createService();
    const projectOnly: AuthUser = { ...jobToken, org_id: undefined };

    await expect(service.can({ org_id: 'org_a', permission: 'orgdocs:read', user: projectOnly })).resolves.toBe(true);
    await expect(service.can({ org_id: 'org_b', permission: 'orgdocs:read', user: projectOnly })).resolves.toBe(false);
  });

  it('refuses a job token that carries neither a project nor an org', async () => {
    const { service } = createService();
    const unscoped: AuthUser = { user_id: 'user_job', is_job_token: true, permissions: ['orgdocs:read'] };

    await expect(service.can({ org_id: 'org_a', permission: 'orgdocs:read', user: unscoped })).resolves.toBe(false);
  });

  it('refuses a scoped job token for another org before its scope claim is evaluated', async () => {
    const { service, accessService } = createService();
    const scoped: AuthUser = { ...jobToken, scope: { orgfs: { allow_prefixes: ['/groups/**'] } } };

    await expect(
      service.can({
        org_id: 'org_b',
        permission: 'orgfs:write',
        user: scoped,
        resource: { type: 'orgfs', id: '/groups/x.yaml', action: 'write' },
      }),
    ).resolves.toBe(false);
    expect(accessService.evaluateScope).not.toHaveBeenCalled();
  });

  it('leaves user tokens to AccessService', async () => {
    const { service, accessService, rbacService } = createService();

    await expect(
      service.can({ org_id: 'org_b', project_id: 'proj_b', permission: 'envdb:read', user: { user_id: 'user_123' } }),
    ).resolves.toBe(true);
    expect(accessService.can).toHaveBeenCalledWith(expect.objectContaining({ org_id: 'org_b', project_id: 'proj_b' }));
    expect(rbacService.getProjectScope).not.toHaveBeenCalled();
  });
});
