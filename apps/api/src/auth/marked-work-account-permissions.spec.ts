import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { AccessService } from './access.service';
import { AuthService } from './auth.service';
import { AppAuthService } from './app-auth.service';
import { MagicLinkService } from './magic-link.service';
import { TokenVerifierService } from './token-verifier.service';
import { BootstrapService } from './bootstrap.service';
import { AuthInternalController } from './auth.internal.controller';
import { createJwtRs256 } from './auth.util';
import { WorkflowsService } from '../workflows/workflows.service';
import { PipelineExpanderService } from '../pipelines/pipeline-expander.service';
import type { MailerService } from '../mailer/mailer.service';
import type { IdentityProviderRegistry } from './providers/index.js';

const MANIFEST = `
name: a
workflows:
  tidy:
    steps:
      - name: sweep
        permissions: [jobs:read, orgs:create]
        script:
          run: "true"
pipelines:
  release:
    steps:
      - name: run
        permissions: [jobs:read, orgs:create]
        action:
          type: run
          command: "true"
`;

/** user_bot and user_person are plain members of org_a (the member role includes orgs:create). */
const m = vi.hoisted(() => {
  const jobs: Array<Record<string, unknown>> = [];
  let n = 0;
  return {
    jobs,
    memberships: {
      findProjectMembership: vi.fn(async () => null),
      findOrgMembership: vi.fn(async (userId: string, orgId: string) =>
        orgId === 'org_a' && (userId === 'user_bot' || userId === 'user_person') ? { role: 'member' } : null),
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
const MARKED = { userSecretsExcluded: true };

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

/** The expanders' private checks, called the way their invoke paths call them. */
type ActorChecks = {
  assertActorCanGrantPermissions(orgId: string, projectId: string, userId: string | undefined, permissions: string[] | null, context: string): Promise<void>;
  assertActorCanUseScope?(orgId: string, projectId: string, userId: string | undefined, scope: unknown, context: string): Promise<void>;
};

describe('work started with an org-bound token never carries account-level permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.jobs.length = 0;
    m.manifests.findLatestByProject.mockResolvedValue({ manifest_yaml: MANIFEST, manifest_hash: 'h', parsed_defaults: null });
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'true';
    process.env.EVE_AUTH_PRIVATE_KEY = privatePem;
  });

  it('at the step ceiling, for workflows and pipelines', async () => {
    await new WorkflowsService(rawSql, access()).invoke('proj_a', 'tidy', undefined, false, 'user_bot', MARKED);
    await new PipelineExpanderService(rawSql, access()).expandPipeline(
      'proj_a',
      { pipeline_name: 'release', git_sha: 'abc' },
      'user_bot',
      MARKED,
    );

    for (const stepName of ['sweep', 'run']) {
      const step = m.jobs.find((j) => j.step_name === stepName);
      expect(step?.token_permissions).toEqual(['jobs:read']);
      expect((step?.hints as Record<string, unknown>).token_permissions_withheld).toEqual(['orgs:create']);
    }
  });

  it("but a person's own work keeps what their role gives", async () => {
    await new WorkflowsService(rawSql, access()).invoke('proj_a', 'tidy', undefined, false, 'user_person');

    expect(m.jobs.find((j) => j.step_name === 'sweep')?.token_permissions).toEqual(['jobs:read', 'orgs:create']);
  });

  it('when mint-job-token signs the job token', async () => {
    const controller = new AuthInternalController(buildAuthService(), rawSql, access());
    m.jobs.push({ id: 'a-bot', project_id: 'proj_a', actor_user_id: 'user_bot', user_secrets_excluded: true, target: null });

    const minted = await controller.mintJobToken({ job_id: 'a-bot', permissions: ['jobs:read', 'orgs:create'] });

    expect(JSON.parse(Buffer.from(minted.access_token.split('.')[1], 'base64url').toString()).permissions).toEqual(['jobs:read']);
  });

  it('when a job token signed earlier is presented', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createJwtRs256(
      {
        sub: 'user_bot',
        user_id: 'user_bot',
        org_id: 'org_a',
        project_id: 'proj_a',
        job_id: 'a-bot',
        permissions: ['jobs:read', 'orgs:create'],
        user_secrets_excluded: true,
        iat: now,
        exp: now + 600,
        type: 'job',
      },
      { kid: 'key-1', privateKey, publicKey },
    );

    const user = await buildAuthService().verifyAuthorizationHeader(`Bearer ${token}`);

    expect(user.permissions).toEqual(['jobs:read']);
  });
});

describe("the 'system' actor counts as no user in the expanders' checks", () => {
  it('skips the actor scope and permission checks for it, as for no user', async () => {
    const workflows = new WorkflowsService(rawSql, access()) as unknown as ActorChecks;
    const pipelines = new PipelineExpanderService(rawSql, access()) as unknown as ActorChecks;

    await expect(
      workflows.assertActorCanUseScope?.('org_a', 'proj_a', 'system', { orgfs: { allow_prefixes: ['/groups/projects/a/**'] } }, 'step'),
    ).resolves.toBeUndefined();
    await expect(workflows.assertActorCanGrantPermissions('org_a', 'proj_a', 'system', ['jobs:read'], 'step')).resolves.toBeUndefined();
    await expect(pipelines.assertActorCanGrantPermissions('org_a', 'proj_a', 'system', ['jobs:read'], 'step')).resolves.toBeUndefined();
  });
});
