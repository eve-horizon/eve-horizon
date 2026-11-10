import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { ProjectListResponse, ProjectResponse } from '@eve/shared';
import { ProjectsController } from './projects.controller';
import type { ProjectsService } from './projects.service';
import type { AuthUser } from '../auth/auth.service';

function project(id: string, orgId: string, name: string): ProjectResponse {
  return { id, org_id: orgId, name } as ProjectResponse;
}

const ownProject = project('proj_a', 'org_a', 'alpha');
const elsewhere = project('proj_x', 'org_b', 'outside');

describe('ProjectsController GET /projects', () => {
  let projectsService: {
    list: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  let controller: ProjectsController;

  const jobToken: AuthUser = {
    user_id: 'user_owner',
    is_job_token: true,
    job_id: 'demo-abc12345',
    project_id: 'proj_a',
    org_id: 'org_a',
    permissions: ['projects:read'],
  };
  const principal: AuthUser = { user_id: 'sp_1', is_service_principal: true, org_id: 'org_a', permissions: ['projects:read'] };

  beforeEach(() => {
    projectsService = {
      // The membership listing of the job's actor spans every org they belong to.
      list: vi.fn(async (): Promise<ProjectListResponse> => ({
        data: [ownProject, elsewhere],
        pagination: { limit: 10, offset: 0, count: 2 },
      })),
      findById: vi.fn(async (id: string) => (id === ownProject.id ? ownProject : null)),
    };
    controller = new ProjectsController(projectsService as unknown as ProjectsService);
  });

  it("lists only a job token's own project", async () => {
    const response = await controller.list(10, 0, jobToken);

    expect(response.data.map((p) => p.id)).toEqual(['proj_a']);
  });

  it('refuses a job token filtering by another org', async () => {
    await expect(controller.list(10, 0, jobToken, undefined, 'org_b')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('holds an org-only service principal to its org', async () => {
    await controller.list(10, 0, principal);
    expect(projectsService.list).toHaveBeenLastCalledWith(expect.objectContaining({ org_id: 'org_a' }));

    await expect(controller.list(10, 0, principal, undefined, 'org_b')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('leaves user listings unchanged', async () => {
    const response = await controller.list(10, 0, { user_id: 'user_member' }, undefined, 'org_b');

    expect(projectsService.list).toHaveBeenCalledWith(expect.objectContaining({ org_id: 'org_b', user_id: 'user_member' }));
    expect(response.data).toHaveLength(2);
  });
});
