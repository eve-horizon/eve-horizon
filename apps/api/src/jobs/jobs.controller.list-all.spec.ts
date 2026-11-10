import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { JobListResponse } from '@eve/shared';
import { JobsController } from './jobs.controller';
import type { JobsService } from './jobs.service';
import type { RbacService } from '../auth/rbac.service';
import type { AuthUser } from '../auth/auth.service';

const projectOrg: Record<string, string> = { proj_a: 'org_a', proj_a2: 'org_a', proj_b: 'org_b' };

/** Invokes GET /jobs with its query arguments in route order, then the caller. */
function listAll(
  controller: JobsController,
  caller: AuthUser,
  query: { org_id?: string; project_id?: string } = {},
): Promise<JobListResponse> {
  const handler = controller.listAll as unknown as (...args: unknown[]) => Promise<JobListResponse>;
  return handler.call(
    controller,
    query.org_id,
    query.project_id,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    50,
    0,
    caller,
  );
}

describe('JobsController GET /jobs', () => {
  let jobsService: { listAll: ReturnType<typeof vi.fn> };
  let controller: JobsController;

  const serviceToken: AuthUser = {
    user_id: 'service:web',
    is_service_token: true,
    project_id: 'proj_a',
    org_id: 'org_a',
    service_name: 'web',
    env_name: 'staging',
    permissions: ['jobs:admin'],
  };
  const jobToken: AuthUser = {
    user_id: 'user_owner',
    is_job_token: true,
    job_id: 'demo-abc12345',
    project_id: 'proj_a',
    org_id: 'org_a',
    permissions: ['jobs:admin'],
  };
  const principal: AuthUser = { user_id: 'sp_1', is_service_principal: true, org_id: 'org_a', permissions: ['jobs:admin'] };

  beforeEach(() => {
    jobsService = { listAll: vi.fn(async () => ({ jobs: [] })) };
    const rbac = {
      getProjectScope: vi.fn(async (projectInput: string) => {
        const orgId = projectOrg[projectInput];
        if (!orgId) throw new NotFoundException('Project not found');
        return { id: projectInput, org_id: orgId };
      }),
      getOrgScopeId: vi.fn(async (orgInput: string) => {
        if (!Object.values(projectOrg).includes(orgInput)) throw new NotFoundException('Org not found');
        return orgInput;
      }),
    };
    controller = new JobsController(jobsService as unknown as JobsService, rbac as unknown as RbacService);
  });

  it("refuses a service token listing another org's jobs", async () => {
    await expect(listAll(controller, serviceToken, { org_id: 'org_b' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(jobsService.listAll).not.toHaveBeenCalled();
  });

  it("refuses a token listing another project's jobs, in its own org or another", async () => {
    await expect(listAll(controller, serviceToken, { project_id: 'proj_b' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(listAll(controller, jobToken, { project_id: 'proj_a2' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(jobsService.listAll).not.toHaveBeenCalled();
  });

  it("lists a service token's own project", async () => {
    await listAll(controller, serviceToken, { project_id: 'proj_a' });

    expect(jobsService.listAll).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj_a' }));
  });

  it("narrows an unfiltered listing to the token's own project", async () => {
    await listAll(controller, jobToken);

    expect(jobsService.listAll).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj_a' }));
  });

  it("narrows an org-only service principal to its org and refuses other orgs", async () => {
    await listAll(controller, principal);
    expect(jobsService.listAll).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: 'org_a', projectId: undefined }));

    await listAll(controller, principal, { project_id: 'proj_a2' });
    expect(jobsService.listAll).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: 'org_a', projectId: 'proj_a2' }));

    await expect(listAll(controller, principal, { org_id: 'org_b' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(listAll(controller, principal, { project_id: 'proj_b' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('passes user filters through unchanged', async () => {
    await listAll(controller, { user_id: 'user_member' }, { org_id: 'org_b', project_id: 'proj_b' });

    expect(jobsService.listAll).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org_b', projectId: 'proj_b' }));
  });
});
