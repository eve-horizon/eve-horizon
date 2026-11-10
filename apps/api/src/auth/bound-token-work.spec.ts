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
import { WorkflowsService } from '../workflows/workflows.service';
import { WorkflowsController } from '../workflows/workflows.controller';
import { PipelineExpanderService } from '../pipelines/pipeline-expander.service';
import { PipelineRunsController } from '../pipelines/pipeline-runs.controller';
import { PipelineExpanderController } from '../pipelines/pipeline-expander.controller';
import { EnvironmentsController } from '../environments/environments.controller';
import { JobsController } from '../jobs/jobs.controller';
import { JobsService } from '../jobs/jobs.service';
import type { AuthUser } from './auth.types';
import type { MailerService } from '../mailer/mailer.service';
import type { IdentityProviderRegistry } from './providers/index.js';

const MANIFEST = `
name: a
workflows:
  plain:
    steps:
      - name: sweep
        script:
          run: "true"
pipelines:
  release:
    steps:
      - name: run
        permissions: [jobs:read]
        action:
          type: run
          command: "true"
`;

/**
 * user_owner: owner of org_a (a person).
 * user_bot: member of org_a, reached through an org-bound minted token.
 */
const m = vi.hoisted(() => {
  const jobs: Array<Record<string, unknown>> = [];
  let n = 0;
  return {
    jobs,
    memberships: {
      findProjectMembership: vi.fn(async () => null),
      findOrgMembership: vi.fn(async (userId: string, orgId: string) => {
        if (orgId !== 'org_a') return null;
        if (userId === 'user_owner') return { role: 'owner' };
        if (userId === 'user_bot') return { role: 'member' };
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
      resolveProjectSlug: vi.fn(async () => 'proj_a'),
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
    apiSources: { list: vi.fn(async () => []) },
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
    projectApiSourceQueries: vi.fn(() => m.apiSources),
    accessRoleQueries: vi.fn(() => m.accessRoles),
  };
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** A tagged-template DB stand-in; `begin` runs the transaction body inline. */
function fakeDb(rowsFor: (sql: string) => unknown[]) {
  const tag = ((strings: TemplateStringsArray) => Promise.resolve(rowsFor(strings.join('?')))) as unknown as Record<string, unknown>;
  tag.json = (v: unknown) => v;
  tag.begin = async (fn: (tx: unknown) => unknown) => fn(tag);
  return tag as never;
}
const rawSql = fakeDb(() => []);

/** Calls a method with arguments its current signature may not declare yet. */
function call(target: object, method: string, ...args: unknown[]): Promise<unknown> {
  const fn = (target as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
  return fn.call(target, ...args);
}

function access(): AccessService {
  return new AccessService({} as never, rawSql);
}

function buildAuthService(): AuthService {
  const mailer = { send: vi.fn() } as unknown as MailerService;
  const magicLink = new MagicLinkService({} as never, mailer);
  const appAuth = new AppAuthService({} as never, magicLink);
  const tokenVerifier = new TokenVerifierService(rawSql, appAuth, magicLink);
  const bootstrap = new BootstrapService({} as never, appAuth);
  return new AuthService({} as never, {} as IdentityProviderRegistry, magicLink, appAuth, tokenVerifier, bootstrap);
}

const BOUND_BOT: AuthUser = { user_id: 'user_bot', org_id: 'org_a', bound_org_id: 'org_a', memberships: [] };
const PERSON: AuthUser = { user_id: 'user_owner' };
const BOT_JOB_TOKEN: AuthUser = {
  user_id: 'user_bot',
  is_job_token: true,
  job_id: 'a-1',
  project_id: 'proj_a',
  org_id: 'org_a',
  permissions: ['jobs:write'],
  user_secrets_excluded: true,
} as AuthUser;

/** A finished workflow first run by user_owner, with one step to retry. */
function retryFixture(stepPermissions: string[]) {
  const root = { id: 'a-root', project_id: 'proj_a', hints: { workflow_root: true }, phase: 'done', labels: [] };
  const child = {
    id: 'a-root.1', project_id: 'proj_a', parent_id: 'a-root', depth: 1, step_name: 'sweep', phase: 'done',
    title: 't', description: 'd', issue_type: 'task', labels: [], priority: 0, hints: {}, execution_type: 'agent',
    assignee: 'agent_x', actor_user_id: 'user_owner', token_permissions: stepPermissions, token_scope: null,
    review_required: 'none',
  };
  m.jobs.push(root);
  return fakeDb((sql) => {
    if (sql.includes('FOR UPDATE') && sql.includes('WHERE id =')) return [root];
    if (sql.includes('WHERE parent_id')) return [child];
    if (sql.includes('RETURNING')) return [root];
    return [];
  });
}

function retried(): Record<string, unknown> | undefined {
  return m.jobs.find((j) => j.id !== 'a-root' && j.step_name === 'sweep');
}

describe('work started with an org-bound token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.jobs.length = 0;
    m.manifests.findLatestByProject.mockResolvedValue({ manifest_yaml: MANIFEST, manifest_hash: 'h', parsed_defaults: null });
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'true';
    process.env.EVE_AUTH_PRIVATE_KEY = privatePem;
  });

  describe('records the bot as its actor and marks it to resolve no user secrets', () => {
    it('on every route that starts work', async () => {
      const jobsService = { create: vi.fn(async () => ({})), createBatch: vi.fn(async () => ({})) };
      const jobs = new JobsController(jobsService as never, {} as never);
      const workflowsService = { invoke: vi.fn(async () => ({})), retry: vi.fn(async () => ({})) };
      const workflows = new WorkflowsController(workflowsService as never, {} as never);
      const runsService = { createRun: vi.fn(async () => ({ detail: {}, pipeline: {} })) };
      const runs = new PipelineRunsController(runsService as never);
      const expanderService = { expandPipeline: vi.fn(async () => ({})) };
      const expander = new PipelineExpanderController(expanderService as never);
      const environmentsService = { deploy: vi.fn(async () => ({})) };
      const environments = new EnvironmentsController(environmentsService as never, {} as never, {} as never);
      const marked = { userSecretsExcluded: true };

      await jobs.create('proj_a', { description: 'go' } as never, BOUND_BOT, 'corr');
      await jobs.createBatch('proj_a', {} as never, BOUND_BOT, 'corr');
      await workflows.invoke('proj_a', 'plain', {} as never, BOUND_BOT);
      await workflows.retry('proj_a', {} as never, BOUND_BOT);
      await runs.createRun('proj_a', 'release', {} as never, false, undefined, undefined, BOUND_BOT);
      await expander.createRun('proj_a', 'release', { git_sha: 'abc' }, BOUND_BOT);
      await environments.deploy('proj_a', 'staging', {} as never, BOUND_BOT);

      expect(jobsService.create).toHaveBeenCalledWith('proj_a', { description: 'go' }, 'user_bot', 'corr', marked);
      expect(jobsService.createBatch).toHaveBeenCalledWith('proj_a', {}, 'corr', 'user_bot', marked);
      expect(workflowsService.invoke).toHaveBeenCalledWith('proj_a', 'plain', {}, false, 'user_bot', marked);
      expect(workflowsService.retry).toHaveBeenCalledWith('proj_a', {}, 'user_bot', marked);
      expect(runsService.createRun).toHaveBeenCalledWith('proj_a', 'release', {}, 'async', { actorUserId: 'user_bot', userSecretsExcluded: true });
      expect(expanderService.expandPipeline).toHaveBeenCalledWith('proj_a', expect.anything(), 'user_bot', marked);
      expect(environmentsService.deploy).toHaveBeenCalledWith('proj_a', 'staging', {}, 'user_bot', marked);
    });

    it('for a job token of such work, and not for a person', async () => {
      const jobsService = { create: vi.fn(async () => ({})) };
      const jobs = new JobsController(jobsService as never, {} as never);

      await jobs.create('proj_a', { description: 'go' } as never, BOT_JOB_TOKEN, 'c1');
      await jobs.create('proj_a', { description: 'go' } as never, PERSON, 'c2');

      expect(jobsService.create).toHaveBeenNthCalledWith(1, 'proj_a', { description: 'go' }, 'user_bot', 'c1', { userSecretsExcluded: true });
      expect(jobsService.create).toHaveBeenNthCalledWith(2, 'proj_a', { description: 'go' }, 'user_owner', 'c2', { userSecretsExcluded: false });
    });

    it('on the jobs a job, workflow or pipeline creates', async () => {
      const jobsService = new JobsService(rawSql, {} as never, {} as never, {} as never);
      await call(jobsService, 'create', 'proj_a', { description: 'go' }, 'user_bot', 'c', { userSecretsExcluded: true });
      expect(m.jobs.at(-1)).toMatchObject({ actor_user_id: 'user_bot', user_secrets_excluded: true });

      m.jobs.length = 0;
      await call(new WorkflowsService(rawSql, access()), 'invoke', 'proj_a', 'plain', undefined, false, 'user_bot', { userSecretsExcluded: true });
      expect(m.jobs.length).toBeGreaterThan(1);
      for (const job of m.jobs) {
        expect(job).toMatchObject({ actor_user_id: 'user_bot', user_secrets_excluded: true });
      }

      m.jobs.length = 0;
      await call(new PipelineExpanderService(rawSql, access()), 'expandPipeline', 'proj_a', { pipeline_name: 'release', git_sha: 'abc' }, 'user_bot', { userSecretsExcluded: true });
      expect(m.jobs.at(-1)).toMatchObject({ actor_user_id: 'user_bot', user_secrets_excluded: true });

      m.jobs.length = 0;
      await call(jobsService, 'create', 'proj_a', { description: 'go' }, 'user_owner', 'c');
      expect(m.jobs.at(-1)).toMatchObject({ actor_user_id: 'user_owner', user_secrets_excluded: false });
    });

    it('in the job token minted for that work', async () => {
      const authService = buildAuthService();
      const controller = new AuthInternalController(authService, rawSql, access());
      m.jobs.push({ id: 'a-bot', project_id: 'proj_a', actor_user_id: 'user_bot', user_secrets_excluded: true, target: null });

      const minted = await controller.mintJobToken({ job_id: 'a-bot', permissions: ['jobs:read'] });
      const claims = JSON.parse(Buffer.from(minted.access_token.split('.')[1], 'base64url').toString());
      expect(claims.user_secrets_excluded).toBe(true);

      const now = Math.floor(Date.now() / 1000);
      const token = createJwtRs256(
        { ...claims, iat: now, exp: now + 600 },
        { kid: 'key-1', privateKey, publicKey },
      );
      const resolved = await authService.verifyAuthorizationHeader(`Bearer ${token}`);
      expect((resolved as Record<string, unknown>).user_secrets_excluded).toBe(true);
    });
  });

  describe('is held to the bot and the caller', () => {
    it("refuses caller-supplied permissions beyond the bot's own", async () => {
      const workflows = new WorkflowsService(rawSql, access());
      const wanted = ['orgdocs:read', 'orgdocs:admin', 'secrets:admin', 'agents:admin', 'cloud_fs:admin'];

      await expect(
        call(workflows, 'invoke', 'proj_a', 'plain', { permissions: wanted }, false, 'user_bot', { userSecretsExcluded: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(m.jobs).toHaveLength(0);
    });

    it('refuses caller-supplied permissions or scope when no user started the run', async () => {
      const workflows = new WorkflowsService(rawSql, access());

      await expect(workflows.invoke('proj_a', 'plain', { permissions: ['jobs:read'] } as never, false, undefined)).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        workflows.invoke('proj_a', 'plain', { scope: { orgfs: { allow_prefixes: ['/x/**'] } } } as never, false, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(m.jobs).toHaveLength(0);
    });

    it("retries a person's workflow as the bot, never as that person", async () => {
      const refused = new WorkflowsService(retryFixture(['orgs:invite', 'orgs:write', 'secrets:write']), access());
      await expect(
        call(refused, 'retry', 'proj_a', { root_job_id: 'a-root', from_step: 'sweep' }, 'user_bot', { userSecretsExcluded: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(retried()).toBeUndefined();

      m.jobs.length = 0;
      const allowed = new WorkflowsService(retryFixture(['jobs:read']), access());
      await call(allowed, 'retry', 'proj_a', { root_job_id: 'a-root', from_step: 'sweep' }, 'user_bot', { userSecretsExcluded: true });
      expect(retried()).toMatchObject({ actor_user_id: 'user_bot', user_secrets_excluded: true, token_permissions: ['jobs:read'] });
    });

    it('retries with no actor when no user asked for it', async () => {
      const workflows = new WorkflowsService(retryFixture(['orgs:invite', 'secrets:write']), access());

      await workflows.retry('proj_a', { root_job_id: 'a-root', from_step: 'sweep' } as never, undefined);

      expect(retried()?.actor_user_id).toBeNull();
      expect(retried()?.token_permissions).toEqual(['secrets:write']);
    });

    it("still retries a person's own workflow as that person", async () => {
      const workflows = new WorkflowsService(retryFixture(['orgs:invite', 'orgs:write', 'secrets:write']), access());

      await workflows.retry('proj_a', { root_job_id: 'a-root', from_step: 'sweep' } as never, 'user_owner');

      expect(retried()).toMatchObject({ actor_user_id: 'user_owner', token_permissions: ['orgs:invite', 'orgs:write', 'secrets:write'] });
      expect(retried()?.user_secrets_excluded).toBeFalsy();
    });
  });
});
