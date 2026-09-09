import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PermissionGuard } from './permission.guard.js';
import { PERMISSION_KEY } from './permission.decorator.js';
import { IS_PUBLIC_KEY } from './auth.decorator.js';
import type { AuthUser } from './auth.types.js';

type JobContext = { project_id: string; org_id: string };
type PermsResolver = (userId: string, orgId: string, projectId?: string) => Set<string>;

function createGuard(options: {
  required?: string[];
  isPublic?: boolean;
  perms?: PermsResolver;
  projectOrg?: Record<string, string>;
  jobs?: Record<string, JobContext>;
} = {}) {
  const authService = { isEnabled: vi.fn(() => true) };
  const rbacService = {
    getProjectOrgId: vi.fn(async (projectId: string) => {
      const orgId = options.projectOrg?.[projectId];
      if (!orgId) throw new NotFoundException('Project not found');
      return orgId;
    }),
    getJobProjectContext: vi.fn(async (jobId: string) => {
      const context = options.jobs?.[jobId];
      if (!context) throw new NotFoundException('Job not found');
      return context;
    }),
    getEffectivePermissions: vi.fn(async (userId: string, orgId: string, projectId?: string) =>
      options.perms ? options.perms(userId, orgId, projectId) : new Set<string>(),
    ),
  };
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => {
      if (key === PERMISSION_KEY) return options.required ?? [];
      if (key === IS_PUBLIC_KEY) return options.isPublic ?? false;
      return undefined;
    }),
  };
  const guard = new PermissionGuard(authService as any, rbacService as any, reflector as any);
  return { guard, rbacService };
}

function executionContext(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as any;
}

const member: AuthUser = { user_id: 'user_member' };
const jobA = 'demo-abc12345';
const jobB = 'other-9876fedc';
const jobs: Record<string, JobContext> = {
  [jobA]: { project_id: 'proj_a', org_id: 'org_a' },
  [jobB]: { project_id: 'proj_b', org_id: 'org_b' },
};

/** Grants the given permissions only inside org_a / proj_a. */
const orgAOnly = (granted: string[]): PermsResolver =>
  (_userId, orgId) => (orgId === 'org_a' ? new Set(granted) : new Set());

describe('PermissionGuard resource context', () => {
  describe('flat /jobs/:job_id routes (user tokens)', () => {
    it("resolves permissions against the job's project and owning org", async () => {
      const { guard, rbacService } = createGuard({
        required: ['jobs:read'],
        jobs,
        perms: orgAOnly(['jobs:read']),
      });

      const allowed = await guard.canActivate(
        executionContext({ user: member, params: { job_id: jobA }, url: `/jobs/${jobA}` }),
      );

      expect(allowed).toBe(true);
      expect(rbacService.getJobProjectContext).toHaveBeenCalledWith(jobA);
      expect(rbacService.getEffectivePermissions).toHaveBeenCalledWith('user_member', 'org_a', 'proj_a');
    });

    it("denies a user with no membership in the job's org", async () => {
      const { guard } = createGuard({ required: ['jobs:read'], jobs, perms: orgAOnly(['jobs:read']) });

      await expect(
        guard.canActivate(executionContext({ user: member, params: { job_id: jobB }, url: `/jobs/${jobB}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('does not fall back to the member baseline for an unknown job', async () => {
      const { guard, rbacService } = createGuard({ required: ['jobs:read'], jobs: {} });

      await expect(
        guard.canActivate(executionContext({ user: member, params: { job_id: 'ghost-00000000' }, url: '/jobs/ghost-00000000' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(rbacService.getEffectivePermissions).not.toHaveBeenCalled();
    });

    it('applies to attachment routes that only carry a job id', async () => {
      const { guard } = createGuard({ required: ['jobs:write'], jobs, perms: orgAOnly(['jobs:write']) });

      await expect(
        guard.canActivate(
          executionContext({ user: member, params: { job_id: jobB, att_id: 'att_1' }, url: `/jobs/${jobB}/attachments/att_1` }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('body org_id', () => {
    it('is ignored when the route addresses a project', async () => {
      const { guard, rbacService } = createGuard({
        required: ['projects:write'],
        projectOrg: { proj_a: 'org_a' },
        // The caller owns org_attacker, but proj_a belongs to org_a.
        perms: (_userId, orgId) => (orgId === 'org_attacker' ? new Set(['projects:write']) : new Set()),
      });

      await expect(
        guard.canActivate(
          executionContext({
            user: member,
            params: { project_id: 'proj_a' },
            body: { org_id: 'org_attacker' },
            url: '/projects/proj_a/manifest',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rbacService.getEffectivePermissions).toHaveBeenCalledWith('user_member', 'org_a', 'proj_a');
    });

    it('is ignored when the route addresses a job', async () => {
      const { guard, rbacService } = createGuard({
        required: ['jobs:write'],
        jobs,
        perms: (_userId, orgId) => (orgId === 'org_attacker' ? new Set(['jobs:write']) : new Set()),
      });

      await expect(
        guard.canActivate(
          executionContext({ user: member, params: { job_id: jobA }, body: { org_id: 'org_attacker' }, url: `/jobs/${jobA}` }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rbacService.getEffectivePermissions).toHaveBeenCalledWith('user_member', 'org_a', 'proj_a');
    });

    it('is still honoured on routes with no project or job context', async () => {
      const { guard, rbacService } = createGuard({ required: ['projects:create'], perms: orgAOnly(['projects:create']) });

      const allowed = await guard.canActivate(
        executionContext({ user: member, params: {}, body: { org_id: 'org_a' }, url: '/projects' }),
      );

      expect(allowed).toBe(true);
      expect(rbacService.getEffectivePermissions).toHaveBeenCalledWith('user_member', 'org_a', undefined);
    });
  });

  describe('job, service and service-principal tokens on /jobs/:job_id routes', () => {
    const jobToken: AuthUser = {
      user_id: 'user_owner',
      is_job_token: true,
      job_id: jobA,
      project_id: 'proj_a',
      org_id: 'org_a',
      permissions: ['jobs:read', 'jobs:write'],
    };

    it('may address its own job and that job\'s subtree without a lookup', async () => {
      const { guard, rbacService } = createGuard({ required: ['jobs:write'], jobs });

      await expect(
        guard.canActivate(executionContext({ user: jobToken, params: { job_id: `${jobA}.2` }, url: `/jobs/${jobA}.2` })),
      ).resolves.toBe(true);
      expect(rbacService.getJobProjectContext).not.toHaveBeenCalled();
    });

    it('may address another job in its own project', async () => {
      const sibling = 'sibling-1234abcd';
      const { guard } = createGuard({ required: ['jobs:read'], jobs: { ...jobs, [sibling]: { project_id: 'proj_a', org_id: 'org_a' } } });

      await expect(
        guard.canActivate(executionContext({ user: jobToken, params: { job_id: sibling }, url: `/jobs/${sibling}` })),
      ).resolves.toBe(true);
    });

    it('may not address a job in another project', async () => {
      const { guard } = createGuard({ required: ['jobs:read'], jobs });

      await expect(
        guard.canActivate(executionContext({ user: jobToken, params: { job_id: jobB }, url: `/jobs/${jobB}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('scopes service principals to the org that owns the job', async () => {
      const principal: AuthUser = { user_id: 'sp_1', is_service_principal: true, org_id: 'org_a', permissions: ['jobs:read'] };
      const { guard } = createGuard({ required: ['jobs:read'], jobs });

      await expect(
        guard.canActivate(executionContext({ user: principal, params: { job_id: jobA }, url: `/jobs/${jobA}` })),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(executionContext({ user: principal, params: { job_id: jobB }, url: `/jobs/${jobB}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('still requires the explicit permission after the scope check', async () => {
      const readOnly: AuthUser = { ...jobToken, permissions: ['jobs:read'] };
      const { guard } = createGuard({ required: ['jobs:write'], jobs });

      await expect(
        guard.canActivate(executionContext({ user: readOnly, params: { job_id: jobA }, url: `/jobs/${jobA}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('unchanged behaviour', () => {
    it('keeps the member baseline for routes with no resource context', async () => {
      const { guard, rbacService } = createGuard({ required: ['jobs:read'] });

      await expect(guard.canActivate(executionContext({ user: member, params: {}, url: '/jobs' }))).resolves.toBe(true);
      expect(rbacService.getEffectivePermissions).not.toHaveBeenCalled();

      const admin = createGuard({ required: ['jobs:admin'] });
      await expect(
        admin.guard.canActivate(executionContext({ user: member, params: {}, url: '/jobs' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets system admins bypass resource checks', async () => {
      const { guard, rbacService } = createGuard({ required: ['jobs:read'], jobs: {} });

      await expect(
        guard.canActivate(executionContext({ user: { user_id: 'root', is_admin: true }, params: { job_id: jobB }, url: `/jobs/${jobB}` })),
      ).resolves.toBe(true);
      expect(rbacService.getJobProjectContext).not.toHaveBeenCalled();
    });
  });
});
