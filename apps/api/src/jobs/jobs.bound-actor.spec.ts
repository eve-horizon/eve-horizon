import { describe, expect, it, vi } from 'vitest';
import { JobsController } from './jobs.controller';
import { WorkflowsController } from '../workflows/workflows.controller';
import { PipelineRunsController } from '../pipelines/pipeline-runs.controller';
import { PipelineExpanderController } from '../pipelines/pipeline-expander.controller';
import { EnvironmentsController } from '../environments/environments.controller';
import { SecretsService } from '../secrets/secrets.service';
import type { AuthUser } from '../auth/auth.types';

const secretRows = vi.hoisted(() => ({
  listByScope: vi.fn(async (scopeType: string) => [{ key: `${scopeType.toUpperCase()}_KEY`, value_encrypted: 'x', type: 'env_var' }]),
}));

vi.mock('@eve/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/db')>();
  return {
    ...actual,
    secretQueries: vi.fn(() => secretRows),
    projectQueries: vi.fn(() => ({ findById: vi.fn(async () => ({ id: 'proj_a', org_id: 'org_a' })) })),
  };
});

/** A user token minted by an org admin for a bot: bound to org_a. */
const bound: AuthUser = { user_id: 'user_bot', org_id: 'org_a', bound_org_id: 'org_a', memberships: [] };
const person: AuthUser = { user_id: 'user_person' };

describe('work started with an org-bound token has no user actor', () => {
  it('POST /projects/:id/jobs and the batch route record no actor', async () => {
    const jobsService = { create: vi.fn(async () => ({})), createBatch: vi.fn(async () => ({})) };
    const controller = new JobsController(jobsService as never, {} as never);

    await controller.create('proj_a', { description: 'go' } as never, bound, 'corr_1');
    await controller.create('proj_a', { description: 'go' } as never, person, 'corr_2');
    await controller.createBatch('proj_a', {} as never, bound, 'corr_3');

    expect(jobsService.create).toHaveBeenNthCalledWith(1, 'proj_a', { description: 'go' }, undefined, 'corr_1');
    expect(jobsService.create).toHaveBeenNthCalledWith(2, 'proj_a', { description: 'go' }, 'user_person', 'corr_2');
    expect(jobsService.createBatch).toHaveBeenCalledWith('proj_a', {}, 'corr_3', undefined);
  });

  it('workflow invoke and retry record no actor', async () => {
    const workflowsService = { invoke: vi.fn(async () => ({})), retry: vi.fn(async () => ({})) };
    const controller = new WorkflowsController(workflowsService as never, {} as never);

    await controller.invoke('proj_a', 'nightly', {} as never, bound);
    await controller.retry('proj_a', {} as never, bound);

    expect(workflowsService.invoke).toHaveBeenCalledWith('proj_a', 'nightly', {}, false, undefined);
    expect(workflowsService.retry).toHaveBeenCalledWith('proj_a', {}, undefined);
  });

  it('pipeline runs and deploys record no actor', async () => {
    const runsService = { createRun: vi.fn(async () => ({ detail: {}, pipeline: {} })) };
    const runs = new PipelineRunsController(runsService as never);
    const expanderService = { expandPipeline: vi.fn(async () => ({})) };
    const expander = new PipelineExpanderController(expanderService as never);
    const environmentsService = { deploy: vi.fn(async () => ({})) };
    const environments = new EnvironmentsController(environmentsService as never, {} as never, {} as never);

    await runs.createRun('proj_a', 'release', {} as never, false, undefined, undefined, bound);
    await expander.createRun('proj_a', 'release', { git_sha: 'abc' }, bound);
    await environments.deploy('proj_a', 'staging', {} as never, bound);

    expect(runsService.createRun).toHaveBeenCalledWith('proj_a', 'release', {}, 'async', { actorUserId: undefined });
    expect(expanderService.expandPipeline).toHaveBeenCalledWith('proj_a', expect.anything(), undefined);
    expect(environmentsService.deploy).toHaveBeenCalledWith('proj_a', 'staging', {}, undefined);
  });

  it('a job with no actor resolves project, org and system secrets but no user secrets', async () => {
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_SECRETS_MASTER_KEY = 'test-master-key';
    const secrets = new SecretsService({} as never);
    (secrets as unknown as { decrypt: (v: string) => string }).decrypt = (v) => v;

    const resolved = await secrets.resolveForProject('proj_a', undefined);

    expect(resolved.map((r) => r.scope_type).sort()).toEqual(['org', 'project', 'system']);
    expect(secretRows.listByScope).not.toHaveBeenCalledWith('user', expect.anything(), expect.anything());
  });
});
