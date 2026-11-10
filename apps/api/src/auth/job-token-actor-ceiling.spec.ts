import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { AccessService } from './access.service';
import { AuthService } from './auth.service';
import { AppAuthService } from './app-auth.service';
import { MagicLinkService } from './magic-link.service';
import { TokenVerifierService } from './token-verifier.service';
import { BootstrapService } from './bootstrap.service';
import { AuthInternalController } from './auth.internal.controller';
import { createJwtRs256 } from './auth.util';
import { PipelineExpanderService } from '../pipelines/pipeline-expander.service';
import { PipelineRunsService } from '../pipelines/pipeline-runs.service';
import { PipelineRunsController } from '../pipelines/pipeline-runs.controller';
import { WorkflowsService } from '../workflows/workflows.service';
import type { AuthUser } from './auth.types';
import type { MailerService } from '../mailer/mailer.service';
import type { IdentityProviderRegistry } from './providers/index.js';

const PIPELINE_MANIFEST = `
name: a
pipelines:
  release:
    steps:
      - name: run
        permissions: [system:admin, orgs:admin, orgs:invite, secrets:write, envs:write]
        action:
          type: run
          command: "true"
  tidy:
    steps:
      - name: run
        permissions: [secrets:write, envs:write]
        action:
          type: run
          command: "true"
workflows:
  nightly:
    steps:
      - name: sweep
        permissions: [system:admin, orgs:invite, secrets:write, envs:write]
        script:
          run: "true"
`;

/**
 * user_padmin: project admin of proj_a, plain member of org_a.
 * user_oadmin: admin of org_a.
 */
const m = vi.hoisted(() => {
  const jobs: Array<Record<string, unknown>> = [];
  let n = 0;
  return {
    jobs,
    memberships: {
      findProjectMembership: vi.fn(async (userId: string, projectId: string) =>
        userId === 'user_padmin' && projectId === 'proj_a' ? { role: 'admin' } : null),
      findOrgMembership: vi.fn(async (userId: string, orgId: string) => {
        if (orgId !== 'org_a') return null;
        if (userId === 'user_padmin') return { role: 'member' };
        if (userId === 'user_oadmin') return { role: 'admin' };
        return null;
      }),
      listOrgMembershipsForUser: vi.fn(async () => []),
    },
    projects: {
      findById: vi.fn(async (id: string) => (id === 'proj_a' ? { id: 'proj_a', org_id: 'org_a', slug: 'a', name: 'a' } : null)),
    },
    manifests: {
      findByProjectAndGitSha: vi.fn(async () => null),
      findLatestByProject: vi.fn(async () => ({ manifest_yaml: '', manifest_hash: 'h', parsed_defaults: null })),
    },
    runs: {
      createRun: vi.fn(async (d: Record<string, unknown>) => ({ ...d, created_at: new Date(), updated_at: new Date() })),
      findActiveRunByDedupeKey: vi.fn(async () => null),
    },
    jobQ: {
      generateJobId: vi.fn(async (_p: string, parentId?: string) => ({ id: parentId ? `${parentId}.${++n}` : `a-${++n}`, projectId: 'proj_a' })),
      create: vi.fn(async (d: Record<string, unknown>) => {
        jobs.push(d);
        return { ...d, created_at: new Date(), updated_at: new Date() };
      }),
      addDependency: vi.fn(async () => 'rel'),
      updatePhase: vi.fn(async () => ({ success: true })),
      findById: vi.fn(async (id: string) => jobs.find((j) => j.id === id) ?? null),
    },
    appLinks: { listByConsumer: vi.fn(async () => []) },
    accessRoles: {
      listApplicableBindings: vi.fn(async () => []),
      getEffectiveCustomPermissions: vi.fn(async () => []),
    },
  };
});

vi.mock('@eve/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/db')>();
  return {
    ...actual,
    membershipQueries: vi.fn(() => m.memberships),
    projectQueries: vi.fn(() => m.projects),
    projectManifestQueries: vi.fn(() => m.manifests),
    pipelineRunQueries: vi.fn(() => m.runs),
    jobQueries: vi.fn(() => m.jobQ),
    appLinkSubscriptionQueries: vi.fn(() => m.appLinks),
    accessRoleQueries: vi.fn(() => m.accessRoles),
  };
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const rawSql = (async () => []) as never;

const OUT_OF_REACH = ['system:admin', 'system:read', 'orgs:admin', 'orgs:invite'];

function tokenPermissionsOf(job: Record<string, unknown> | undefined): string[] {
  return (job?.token_permissions as string[] | null) ?? [];
}

function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

/** PipelineRunsService.createRun with an actor as its fifth argument. */
type CreateRunWithActor = (
  projectId: string,
  pipelineName: string,
  request: Record<string, unknown>,
  runMode: string,
  options: { actorUserId?: string },
) => Promise<unknown>;

function pipelineRuns(): PipelineRunsService {
  const access = new AccessService({} as never, rawSql);
  const expander = new PipelineExpanderService(rawSql, access);
  return new PipelineRunsService(rawSql, expander);
}

function buildAuthService(): AuthService {
  const mailer = { send: vi.fn() } as unknown as MailerService;
  const magicLink = new MagicLinkService({} as never, mailer);
  const appAuth = new AppAuthService({} as never, magicLink);
  const tokenVerifier = new TokenVerifierService(rawSql, appAuth, magicLink);
  const bootstrap = new BootstrapService({} as never, appAuth);
  return new AuthService({} as never, {} as IdentityProviderRegistry, magicLink, appAuth, tokenVerifier, bootstrap);
}

describe('job-token permissions when no user started the work', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.jobs.length = 0;
    m.manifests.findLatestByProject.mockResolvedValue({ manifest_yaml: PIPELINE_MANIFEST, manifest_hash: 'h', parsed_defaults: null });
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'true';
    process.env.EVE_AUTH_PRIVATE_KEY = privatePem;
  });

  it('a pipeline run with no actor gets no platform or org-management permissions', async () => {
    await pipelineRuns().createRun('proj_a', 'release', {} as never, 'async').catch(() => undefined);

    const job = m.jobs.find((j) => j.step_name === 'run');
    expect(job).toBeDefined();
    for (const permission of OUT_OF_REACH) {
      expect(tokenPermissionsOf(job)).not.toContain(permission);
    }
    expect(tokenPermissionsOf(job)).toEqual(expect.arrayContaining(['secrets:write', 'envs:write']));
    expect((job?.hints as Record<string, unknown>).token_permissions_withheld).toEqual(
      expect.arrayContaining(['system:admin', 'orgs:admin', 'orgs:invite']),
    );
  });

  it('an event-triggered workflow step keeps its project-scoped permissions only', async () => {
    const workflows = new WorkflowsService(rawSql, new AccessService({} as never, rawSql));

    await workflows.invoke('proj_a', 'nightly', undefined, false, undefined);

    const step = m.jobs.find((j) => j.step_name === 'sweep');
    expect(step).toBeDefined();
    expect(tokenPermissionsOf(step).sort()).toEqual(['envs:write', 'secrets:write']);
  });

  it('a manual run by a project admin is held to that admin', async () => {
    const runs = pipelineRuns();
    const run = runs.createRun.bind(runs) as unknown as CreateRunWithActor;

    await expect(run('proj_a', 'release', {}, 'async', { actorUserId: 'user_padmin' })).rejects.toBeInstanceOf(BadRequestException);
    expect(m.jobs).toHaveLength(0);

    await run('proj_a', 'tidy', {}, 'async', { actorUserId: 'user_padmin' }).catch(() => undefined);
    const job = m.jobs.find((j) => j.step_name === 'run');
    expect(tokenPermissionsOf(job).sort()).toEqual(['envs:write', 'secrets:write']);
    expect(job?.actor_user_id).toBe('user_padmin');
  });

  it('POST /projects/:id/pipelines/:name/run passes the caller as the actor', async () => {
    const service = { createRun: vi.fn(async () => ({ detail: { run: { id: 'prun_1' } }, pipeline: {} })) };
    const controller = new PipelineRunsController(service as never);
    const handler = controller.createRun as unknown as (...args: unknown[]) => Promise<unknown>;
    const caller: AuthUser = { user_id: 'user_padmin' };

    await handler.call(controller, 'proj_a', 'tidy', {}, false, undefined, undefined, caller);

    expect(service.createRun).toHaveBeenCalledWith('proj_a', 'tidy', {}, 'async', { actorUserId: 'user_padmin' });
  });

  it('mint-job-token signs no platform permissions, and org management only for an actor who holds it', async () => {
    const authService = buildAuthService();
    const controller = Reflect.construct(AuthInternalController, [
      authService,
      rawSql,
      new AccessService({} as never, rawSql),
    ]) as AuthInternalController;
    const requested = ['jobs:read', 'secrets:write', 'system:admin', 'system:read', 'orgs:invite'];

    m.jobs.push({ id: 'a-actorless', project_id: 'proj_a', actor_user_id: null, target: null });
    const actorless = await controller.mintJobToken({ job_id: 'a-actorless', permissions: requested });
    expect(decode(actorless.access_token).permissions).toEqual(['jobs:read', 'secrets:write']);

    m.jobs.push({ id: 'a-padmin', project_id: 'proj_a', actor_user_id: 'user_padmin', target: null });
    const byProjectAdmin = await controller.mintJobToken({ job_id: 'a-padmin', permissions: requested });
    expect(decode(byProjectAdmin.access_token).permissions).toEqual(['jobs:read', 'secrets:write']);

    m.jobs.push({ id: 'a-oadmin', project_id: 'proj_a', actor_user_id: 'user_oadmin', target: null });
    const byOrgAdmin = await controller.mintJobToken({ job_id: 'a-oadmin', permissions: requested });
    expect(decode(byOrgAdmin.access_token).permissions).toEqual(['jobs:read', 'secrets:write', 'orgs:invite']);
  });

  it('a job token signed with platform permissions is held to the same rule when presented', async () => {
    const authService = buildAuthService();
    const now = Math.floor(Date.now() / 1000);
    const sign = (userId: string) => createJwtRs256(
      {
        sub: userId,
        user_id: userId,
        org_id: 'org_a',
        project_id: 'proj_a',
        job_id: 'a-1',
        permissions: ['jobs:read', 'system:admin', 'orgs:invite'],
        iat: now,
        exp: now + 600,
        type: 'job',
      },
      { kid: 'key-1', privateKey, publicKey },
    );

    const actorless = await authService.verifyAuthorizationHeader(`Bearer ${sign('system')}`);
    expect(actorless.permissions).toEqual(['jobs:read']);
    const withActor = await authService.verifyAuthorizationHeader(`Bearer ${sign('user_oadmin')}`);
    expect(withActor.permissions).toEqual(['jobs:read', 'orgs:invite']);
  });
});
