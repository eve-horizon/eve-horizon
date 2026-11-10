import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AccessService } from './access.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { PipelineExpanderService } from '../pipelines/pipeline-expander.service';

/**
 * user_padmin: project admin of proj_a, plain member of org_a.
 * user_oadmin: admin of org_a.
 */
const m = vi.hoisted(() => ({
  memberships: {
    findProjectMembership: vi.fn(async (userId: string, projectId: string) =>
      userId === 'user_padmin' && projectId === 'proj_a' ? { role: 'admin' } : null),
    findOrgMembership: vi.fn(async (userId: string, orgId: string) => {
      if (orgId !== 'org_a') return null;
      if (userId === 'user_padmin') return { role: 'member' };
      if (userId === 'user_oadmin') return { role: 'admin' };
      return null;
    }),
  },
  projects: { findById: vi.fn(async (id: string) => (id === 'proj_a' ? { id: 'proj_a', org_id: 'org_a' } : null)) },
  accessRoles: { listApplicableBindings: vi.fn(async () => []) },
}));

vi.mock('@eve/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/db')>();
  return {
    ...actual,
    membershipQueries: vi.fn(() => m.memberships),
    projectQueries: vi.fn(() => m.projects),
    accessRoleQueries: vi.fn(() => m.accessRoles),
  };
});

/** The ceiling both expanders apply to a step's declared job-token permissions. */
type StepPermissionCeiling = {
  assertActorCanGrantPermissions(
    orgId: string,
    projectId: string,
    userId: string | undefined,
    permissions: string[] | null,
    context: string,
  ): Promise<void>;
};

const rawSql = (async () => []) as never;
const access = new AccessService({} as never, rawSql);
const expanders: Array<[string, StepPermissionCeiling]> = [
  ['workflow steps', new WorkflowsService(rawSql, access) as unknown as StepPermissionCeiling],
  ['pipeline steps', new PipelineExpanderService(rawSql, access) as unknown as StepPermissionCeiling],
];

describe.each(expanders)('job-token permissions declared on %s', (_label, expander) => {
  it('may not grant org management from a project role alone', async () => {
    for (const permission of ['orgs:invite', 'orgs:write', 'integrations:write', 'system:read']) {
      await expect(
        expander.assertActorCanGrantPermissions('org_a', 'proj_a', 'user_padmin', [permission], 'step'),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("may still grant a project admin's project-level permissions", async () => {
    await expect(
      expander.assertActorCanGrantPermissions('org_a', 'proj_a', 'user_padmin', ['secrets:write', 'envs:write', 'jobs:write'], 'step'),
    ).resolves.toBeUndefined();
  });

  it('may grant org management the actor holds through their org role', async () => {
    await expect(
      expander.assertActorCanGrantPermissions('org_a', 'proj_a', 'user_oadmin', ['orgs:invite'], 'step'),
    ).resolves.toBeUndefined();
  });
});
