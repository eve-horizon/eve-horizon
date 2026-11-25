import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { JOB_TOKEN_READ_SCOPE_RULE, jobTreeRoot, PermissionGuard } from './permission.guard.js';
import { PERMISSION_KEY } from './permission.decorator.js';
import { IS_PUBLIC_KEY } from './auth.decorator.js';
import type { AuthUser } from './auth.types.js';

/*
 * Rule jobs.token_read_scope (project, rule set 5): a job token reads only
 * the jobs of its own tree and pipeline run. Any other job in its project is
 * allowed and recorded under `audit` and refused under `strict`.
 */

type Profile = 'legacy' | 'audit' | 'strict';

const JOBS: Record<string, { project_id: string; org_id: string; run_id: string | null }> = {
  'shop-11111111': { project_id: 'proj_shop', org_id: 'org_a', run_id: null },
  'shop-11111111.1': { project_id: 'proj_shop', org_id: 'org_a', run_id: null },
  'shop-11111111.2': { project_id: 'proj_shop', org_id: 'org_a', run_id: null },
  'shop-11111111.2.1': { project_id: 'proj_shop', org_id: 'org_a', run_id: null },
  'shop-22222222': { project_id: 'proj_shop', org_id: 'org_a', run_id: null },
  'shop-33333333': { project_id: 'proj_shop', org_id: 'org_a', run_id: 'prun_1' },
  'shop-44444444': { project_id: 'proj_shop', org_id: 'org_a', run_id: 'prun_1' },
  'shop-55555555': { project_id: 'proj_shop', org_id: 'org_a', run_id: 'prun_2' },
  'other-66666666': { project_id: 'proj_other', org_id: 'org_a', run_id: null },
};

function setup(profile: Profile, opts: { security?: boolean } = {}) {
  const findings: Array<{ rule: string; projectId?: string | null; detail?: Record<string, unknown> }> = [];
  const rbacService = {
    getResourceProjectContext: vi.fn(async (_kind: string, id: string) => {
      const job = JOBS[id];
      if (!job) throw new NotFoundException('Job not found');
      return { project_id: job.project_id, org_id: job.org_id };
    }),
    getJobPipelineRunId: vi.fn(async (id: string) => JOBS[id]?.run_id ?? null),
  };
  const security = {
    gate: vi.fn(async (rule: string, ctx: { projectId?: string | null; detail?: Record<string, unknown> }, message?: string) => {
      if (profile === 'legacy') return 'allowed';
      findings.push({ rule, projectId: ctx.projectId, detail: ctx.detail });
      if (profile === 'strict') throw new ForbiddenException(`${message} (rule ${rule})`);
      return 'recorded';
    }),
  };
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => {
      if (key === PERMISSION_KEY) return ['jobs:read'];
      if (key === IS_PUBLIC_KEY) return false;
      return undefined;
    }),
  };
  const guard = new PermissionGuard(
    { isEnabled: () => true } as never,
    rbacService as never,
    reflector as never,
    opts.security === false ? undefined : (security as never),
  );
  return { guard, findings, security, rbacService };
}

const tokenFor = (jobId: string): AuthUser => ({
  user_id: 'user_actor',
  is_job_token: true,
  job_id: jobId,
  project_id: JOBS[jobId].project_id,
  org_id: 'org_a',
  permissions: ['jobs:read', 'jobs:write'],
});

function read(guard: PermissionGuard, user: AuthUser, jobId: string, method = 'GET', suffix = '') {
  const request = { user, method, params: { job_id: jobId }, url: `/jobs/${jobId}${suffix}`, routeOptions: { url: `/jobs/:job_id${suffix}` } };
  return guard.canActivate({
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as never);
}

describe('jobTreeRoot', () => {
  it('is the id before the first dot', () => {
    expect(jobTreeRoot('shop-11111111')).toBe('shop-11111111');
    expect(jobTreeRoot('shop-11111111.2.1')).toBe('shop-11111111');
  });
});

describe('PermissionGuard: rule jobs.token_read_scope', () => {
  it('lets a job token read its own tree: root, parent, siblings and descendants, with no finding', async () => {
    const { guard, findings, security } = setup('strict');
    const child = tokenFor('shop-11111111.2');
    for (const id of ['shop-11111111.2', 'shop-11111111.2.1', 'shop-11111111', 'shop-11111111.1']) {
      await expect(read(guard, child, id)).resolves.toBe(true);
    }
    expect(findings).toEqual([]);
    expect(security.gate).not.toHaveBeenCalled();
  });

  it('lets a pipeline step read the other steps of its own run', async () => {
    const { guard, findings } = setup('strict');
    await expect(read(guard, tokenFor('shop-33333333'), 'shop-44444444')).resolves.toBe(true);
    expect(findings).toEqual([]);
  });

  it('refuses another tree under strict, on the job and every route under it', async () => {
    const { guard, findings } = setup('strict');
    const token = tokenFor('shop-11111111.1');
    await expect(read(guard, token, 'shop-22222222')).rejects.toThrow(/may not read job shop-22222222 \(rule jobs.token_read_scope\)/);
    await expect(read(guard, token, 'shop-22222222', 'GET', '/attempts/1/logs')).rejects.toBeInstanceOf(ForbiddenException);
    expect(findings[0]).toEqual({
      rule: JOB_TOKEN_READ_SCOPE_RULE,
      projectId: 'proj_shop',
      detail: { job_id: 'shop-22222222', reader_job_id: 'shop-11111111.1' },
    });
  });

  it('refuses another pipeline run, and a run step reading outside its run', async () => {
    const { guard } = setup('strict');
    await expect(read(guard, tokenFor('shop-33333333'), 'shop-55555555')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(read(guard, tokenFor('shop-33333333'), 'shop-22222222')).rejects.toBeInstanceOf(ForbiddenException);
    // A job outside any run does not count as sharing a run with another such job.
    await expect(read(guard, tokenFor('shop-22222222'), 'shop-11111111')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows and records under audit, and allows under legacy', async () => {
    const audit = setup('audit');
    await expect(read(audit.guard, tokenFor('shop-11111111'), 'shop-22222222')).resolves.toBe(true);
    expect(audit.findings).toHaveLength(1);
    const legacy = setup('legacy');
    await expect(read(legacy.guard, tokenFor('shop-11111111'), 'shop-22222222')).resolves.toBe(true);
    expect(legacy.findings).toEqual([]);
  });

  it('holds reads only: writes keep their own rules', async () => {
    const { guard, security } = setup('strict');
    await expect(read(guard, tokenFor('shop-11111111'), 'shop-22222222', 'POST', '/cancel')).resolves.toBe(true);
    expect(security.gate).not.toHaveBeenCalled();
  });

  it('leaves user tokens alone', async () => {
    const { guard, security, rbacService } = setup('strict');
    rbacService.getResourceProjectContext.mockClear();
    const user: AuthUser = { user_id: 'user_actor' };
    const getEffectivePermissions = vi.fn(async () => new Set(['jobs:read']));
    Object.assign(rbacService, { getEffectivePermissions });
    await expect(read(guard, user, 'shop-22222222')).resolves.toBe(true);
    expect(security.gate).not.toHaveBeenCalled();
  });

  it('still refuses another project before the rule is consulted', async () => {
    const { guard, security } = setup('legacy');
    await expect(read(guard, tokenFor('shop-11111111'), 'other-66666666')).rejects.toThrow(/project that owns this resource/);
    expect(security.gate).not.toHaveBeenCalled();
  });
});
