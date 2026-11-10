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
  /** Project slugs, keyed slug -> project id */
  projectSlugs?: Record<string, string>;
  /** Org slugs, keyed slug -> org id */
  orgSlugs?: Record<string, string>;
  jobs?: Record<string, JobContext>;
  /** Other project-owned resources keyed as `<kind>:<id>` */
  resources?: Record<string, JobContext>;
} = {}) {
  const authService = { isEnabled: vi.fn(() => true) };
  const rbacService = {
    getProjectOrgId: vi.fn(async (projectId: string) => {
      const orgId = options.projectOrg?.[projectId];
      if (!orgId) throw new NotFoundException('Project not found');
      return orgId;
    }),
    getProjectScope: vi.fn(async (projectInput: string) => {
      const id = options.projectSlugs?.[projectInput] ?? projectInput;
      const orgId = options.projectOrg?.[id];
      if (!orgId) throw new NotFoundException('Project not found');
      return { id, org_id: orgId };
    }),
    getOrgScopeId: vi.fn(async (orgInput: string) => {
      const id = options.orgSlugs?.[orgInput] ?? orgInput;
      if (!Object.values(options.projectOrg ?? {}).includes(id)) throw new NotFoundException('Org not found');
      return id;
    }),
    getResourceProjectContext: vi.fn(async (kind: string, id: string) => {
      const context = options.resources?.[`${kind}:${id}`] ?? (kind === 'job' ? options.jobs?.[id] : undefined);
      if (!context) throw new NotFoundException(`${kind} not found`);
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
      expect(rbacService.getResourceProjectContext).toHaveBeenCalledWith('job', jobA);
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
      expect(rbacService.getResourceProjectContext).not.toHaveBeenCalled();
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

  describe('other flat resource routes (pipeline runs, builds, threads)', () => {
    const run = 'prun_01ownedbyproja00000000000';
    const build = 'bld_01ownedbyprojb000000000000';
    const thread = 'thr_01ownedbyproja00000000000';
    const resources: Record<string, JobContext> = {
      [`pipeline_run:${run}`]: { project_id: 'proj_a', org_id: 'org_a' },
      [`build:${build}`]: { project_id: 'proj_b', org_id: 'org_b' },
      [`thread:${thread}`]: { project_id: 'proj_a', org_id: 'org_a' },
    };

    it("lets an admin of the owning org approve a gated pipeline run", async () => {
      const { guard, rbacService } = createGuard({ required: ['pipelines:write'], resources, perms: orgAOnly(['pipelines:write']) });

      await expect(
        guard.canActivate(executionContext({ user: member, params: { runId: run }, url: `/pipeline-runs/${run}/approve` })),
      ).resolves.toBe(true);
      expect(rbacService.getResourceProjectContext).toHaveBeenCalledWith('pipeline_run', run);
      expect(rbacService.getEffectivePermissions).toHaveBeenCalledWith('user_member', 'org_a', 'proj_a');
    });

    it('denies an admin of another org on the same pipeline run', async () => {
      const { guard } = createGuard({
        required: ['pipelines:write'],
        resources,
        perms: (_userId, orgId) => (orgId === 'org_attacker' ? new Set(['pipelines:write']) : new Set()),
      });

      await expect(
        guard.canActivate(executionContext({ user: member, params: { runId: run }, url: `/pipeline-runs/${run}/approve` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('resolves builds through the build spec project', async () => {
      const { guard, rbacService } = createGuard({ required: ['builds:read'], resources, perms: orgAOnly(['builds:read']) });

      await expect(
        guard.canActivate(executionContext({ user: member, params: { build_id: build }, url: `/builds/${build}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rbacService.getEffectivePermissions).toHaveBeenCalledWith('user_member', 'org_b', 'proj_b');
    });

    it('resolves flat thread routes through the thread project', async () => {
      const { guard, rbacService } = createGuard({ required: ['threads:read'], resources, perms: orgAOnly(['threads:read']) });

      await expect(
        guard.canActivate(executionContext({ user: member, params: { thread_id: thread }, url: `/threads/${thread}` })),
      ).resolves.toBe(true);
      expect(rbacService.getResourceProjectContext).toHaveBeenCalledWith('thread', thread);
    });

    it('keeps the org param authoritative on org-prefixed thread routes', async () => {
      const { guard, rbacService } = createGuard({ required: ['threads:read'], resources, perms: orgAOnly(['threads:read']) });

      await expect(
        guard.canActivate(
          executionContext({ user: member, params: { org_id: 'org_a', thread_id: thread }, url: `/orgs/org_a/threads/${thread}` }),
        ),
      ).resolves.toBe(true);
      expect(rbacService.getResourceProjectContext).not.toHaveBeenCalled();
      expect(rbacService.getEffectivePermissions).toHaveBeenCalledWith('user_member', 'org_a', undefined);
    });

    it('returns 404 for an unknown pipeline run instead of the member baseline', async () => {
      const { guard } = createGuard({ required: ['pipelines:read'], resources: {} });

      await expect(
        guard.canActivate(executionContext({ user: member, params: { runId: 'prun_ghost' }, url: '/pipeline-runs/prun_ghost/logs' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('scopes job tokens to pipeline runs in their own project', async () => {
      const jobToken: AuthUser = { user_id: 'u', is_job_token: true, job_id: jobA, project_id: 'proj_a', org_id: 'org_a', permissions: ['pipelines:write'] };
      const { guard } = createGuard({ required: ['pipelines:write'], resources });

      await expect(
        guard.canActivate(executionContext({ user: jobToken, params: { runId: run }, url: `/pipeline-runs/${run}/approve` })),
      ).resolves.toBe(true);
      const foreign = { ...jobToken, project_id: 'proj_b' };
      await expect(
        guard.canActivate(executionContext({ user: foreign, params: { runId: run }, url: `/pipeline-runs/${run}/approve` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('job, service and service-principal tokens on project and org routes', () => {
    const projectOrg = { proj_a: 'org_a', proj_b: 'org_b', proj_a2: 'org_a' };
    const jobToken: AuthUser = {
      user_id: 'user_owner',
      is_job_token: true,
      job_id: jobA,
      project_id: 'proj_a',
      org_id: 'org_a',
      permissions: ['jobs:write', 'secrets:read', 'envdb:read', 'orgdocs:read', 'projects:create'],
    };
    const serviceToken: AuthUser = {
      user_id: 'service:web',
      is_service_token: true,
      project_id: 'proj_a',
      org_id: 'org_a',
      service_name: 'web',
      env_name: 'staging',
      permissions: ['jobs:write', 'secrets:read'],
    };
    const principal: AuthUser = {
      user_id: 'sp_1',
      is_service_principal: true,
      org_id: 'org_a',
      permissions: ['jobs:write', 'orgdocs:read'],
    };

    const createJob = (user: AuthUser, project: string) =>
      executionContext({
        user,
        params: { project_id: project },
        body: { description: 'do the thing' },
        routeOptions: { url: '/projects/:project_id/jobs' },
        url: `/projects/${project}/jobs`,
      });

    it("refuses a job token on another project's route", async () => {
      const { guard } = createGuard({ required: ['jobs:write'], projectOrg });

      await expect(guard.canActivate(createJob(jobToken, 'proj_b'))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a job token on a sibling project in its own org', async () => {
      const { guard } = createGuard({ required: ['jobs:write'], projectOrg });

      await expect(guard.canActivate(createJob(jobToken, 'proj_a2'))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a job token on its own project, by id or by slug', async () => {
      const { guard } = createGuard({ required: ['jobs:write'], projectOrg, projectSlugs: { alpha: 'proj_a' } });

      await expect(guard.canActivate(createJob(jobToken, 'proj_a'))).resolves.toBe(true);
      await expect(guard.canActivate(createJob(jobToken, 'alpha'))).resolves.toBe(true);
    });

    it('refuses a job token on /projects/:id routes of another project', async () => {
      const { guard } = createGuard({ required: ['envdb:read'], projectOrg });

      await expect(
        guard.canActivate(
          executionContext({
            user: jobToken,
            params: { id: 'proj_b', name: 'staging' },
            routeOptions: { url: '/projects/:id/envs/:name/db/snapshots' },
            url: '/projects/proj_b/envs/staging/db/snapshots',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a service token on another project and allows its own', async () => {
      const { guard } = createGuard({ required: ['secrets:read'], projectOrg });
      const listSecrets = (project: string) =>
        executionContext({
          user: serviceToken,
          params: { project_id: project },
          routeOptions: { url: '/projects/:project_id/secrets' },
          url: `/projects/${project}/secrets`,
        });

      await expect(guard.canActivate(listSecrets('proj_b'))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guard.canActivate(listSecrets('proj_a'))).resolves.toBe(true);
    });

    it('allows an org-scoped service principal on projects in its org and refuses other orgs', async () => {
      const { guard } = createGuard({ required: ['jobs:write'], projectOrg });

      await expect(guard.canActivate(createJob(principal, 'proj_a'))).resolves.toBe(true);
      await expect(guard.canActivate(createJob(principal, 'proj_a2'))).resolves.toBe(true);
      await expect(guard.canActivate(createJob(principal, 'proj_b'))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a token that carries neither a project nor an org', async () => {
      const unscoped: AuthUser = { user_id: 'u', is_job_token: true, job_id: jobA, permissions: ['jobs:write'] };
      const { guard } = createGuard({ required: ['jobs:write'], projectOrg });

      await expect(guard.canActivate(createJob(unscoped, 'proj_a'))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses /orgs/:org_id routes of another org and allows its own', async () => {
      const { guard } = createGuard({ required: ['orgdocs:read'], projectOrg });
      const readDocs = (user: AuthUser, org: string) =>
        executionContext({
          user,
          params: { org_id: org },
          routeOptions: { url: '/orgs/:org_id/docs' },
          url: `/orgs/${org}/docs`,
        });

      await expect(guard.canActivate(readDocs(jobToken, 'org_b'))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guard.canActivate(readDocs(principal, 'org_b'))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guard.canActivate(readDocs(jobToken, 'org_a'))).resolves.toBe(true);
      await expect(guard.canActivate(readDocs(principal, 'org_a'))).resolves.toBe(true);
    });

    it('allows a token on its own org addressed by slug', async () => {
      const { guard } = createGuard({ required: ['orgdocs:read'], projectOrg, orgSlugs: { acme: 'org_a', other: 'org_b' } });
      const readDocs = (user: AuthUser, org: string) =>
        executionContext({ user, params: { org_id: org }, routeOptions: { url: '/orgs/:org_id/docs' }, url: `/orgs/${org}/docs` });

      await expect(guard.canActivate(readDocs(jobToken, 'acme'))).resolves.toBe(true);
      await expect(guard.canActivate(readDocs(principal, 'acme'))).resolves.toBe(true);
      await expect(guard.canActivate(readDocs(jobToken, 'other'))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses /orgs/:id routes of another org', async () => {
      const { guard } = createGuard({ required: ['orgdocs:read'], projectOrg });

      await expect(
        guard.canActivate(
          executionContext({ user: jobToken, params: { id: 'org_b' }, routeOptions: { url: '/orgs/:id' }, url: '/orgs/org_b' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("judges a project-only token on org routes by its project's org", async () => {
      const projectOnly: AuthUser = { ...jobToken, org_id: undefined };
      const { guard } = createGuard({ required: ['orgdocs:read'], projectOrg });
      const readDocs = (org: string) =>
        executionContext({ user: projectOnly, params: { org_id: org }, routeOptions: { url: '/orgs/:org_id/docs' }, url: `/orgs/${org}/docs` });

      await expect(guard.canActivate(readDocs('org_a'))).resolves.toBe(true);
      await expect(guard.canActivate(readDocs('org_b'))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('holds body.org_id to the token org on routes with no path context', async () => {
      const { guard } = createGuard({ required: ['projects:create'], projectOrg });
      const createProject = (org: string) =>
        executionContext({ user: jobToken, params: {}, body: { org_id: org, name: 'x' }, routeOptions: { url: '/projects' }, url: '/projects' });

      await expect(guard.canActivate(createProject('org_b'))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guard.canActivate(createProject('org_a'))).resolves.toBe(true);
    });

    it('leaves user tokens on project and org routes to role resolution', async () => {
      const { guard, rbacService } = createGuard({
        required: ['jobs:write'],
        projectOrg,
        perms: (_userId, orgId) => (orgId === 'org_b' ? new Set(['jobs:write']) : new Set()),
      });

      await expect(guard.canActivate(createJob(member, 'proj_b'))).resolves.toBe(true);
      await expect(guard.canActivate(createJob(member, 'proj_a'))).rejects.toBeInstanceOf(ForbiddenException);
      expect(rbacService.getProjectScope).not.toHaveBeenCalled();
      expect(rbacService.getEffectivePermissions).toHaveBeenCalledWith('user_member', 'org_b', 'proj_b');
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
      expect(rbacService.getResourceProjectContext).not.toHaveBeenCalled();
    });
  });
});
