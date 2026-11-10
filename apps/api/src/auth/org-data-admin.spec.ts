import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AccessService } from './access.service';
import { AuthService } from './auth.service';
import { AppAuthService } from './app-auth.service';
import { MagicLinkService } from './magic-link.service';
import { TokenVerifierService } from './token-verifier.service';
import { BootstrapService } from './bootstrap.service';
import { AuthInternalController } from './auth.internal.controller';
import { WorkflowsService } from '../workflows/workflows.service';
import { PipelineExpanderService } from '../pipelines/pipeline-expander.service';
import { OrgFsSyncController } from '../org-fs-sync/org-fs-sync.controller';
import type { AuthUser } from './auth.types';
import type { MailerService } from '../mailer/mailer.service';
import type { IdentityProviderRegistry } from './providers/index.js';

const ORG_DATA_ADMIN = ['orgfs:admin', 'orgdocs:admin', 'cloud_fs:admin'];

const MANIFEST = `
name: a
workflows:
  nightly:
    steps:
      - name: sweep
        permissions: [orgfs:admin, orgdocs:admin, cloud_fs:admin, orgdocs:read]
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
    jobQueries: vi.fn(() => m.jobQ),
    appLinkSubscriptionQueries: vi.fn(() => m.appLinks),
    accessRoleQueries: vi.fn(() => m.accessRoles),
  };
});

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const rawSql = (async () => []) as never;

type StepCeiling = {
  ceilStepTokenPermissions(
    orgId: string,
    projectId: string,
    userId: string | undefined,
    permissions: string[] | null,
    context: string,
  ): Promise<{ permissions: string[] | null; withheld: string[] }>;
};

function buildAuthService(): AuthService {
  const mailer = { send: vi.fn() } as unknown as MailerService;
  const magicLink = new MagicLinkService({} as never, mailer);
  const appAuth = new AppAuthService({} as never, magicLink);
  const tokenVerifier = new TokenVerifierService(rawSql, appAuth, magicLink);
  const bootstrap = new BootstrapService({} as never, appAuth);
  return new AuthService({} as never, {} as IdentityProviderRegistry, magicLink, appAuth, tokenVerifier, bootstrap);
}

function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

describe('org data-plane admin permissions on job tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.jobs.length = 0;
    m.manifests.findLatestByProject.mockResolvedValue({ manifest_yaml: MANIFEST, manifest_hash: 'h', parsed_defaults: null });
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'true';
    process.env.EVE_AUTH_PRIVATE_KEY = privatePem;
  });

  it('are withheld from a step no user started', async () => {
    await new WorkflowsService(rawSql, new AccessService({} as never, rawSql)).invoke('proj_a', 'nightly', undefined, false, undefined);

    const step = m.jobs.find((j) => j.step_name === 'sweep');
    expect(step?.token_permissions).toEqual(['orgdocs:read']);
  });

  it("are judged against the actor's permissions for the project", async () => {
    const access = new AccessService({} as never, rawSql);
    for (const expander of [new WorkflowsService(rawSql, access), new PipelineExpanderService(rawSql, access)] as unknown as StepCeiling[]) {
      // The built-in project admin role holds cloud_fs:admin, but no orgfs or orgdocs admin.
      await expect(
        expander.ceilStepTokenPermissions('org_a', 'proj_a', 'user_padmin', ['cloud_fs:admin'], 'step'),
      ).resolves.toEqual({ permissions: ['cloud_fs:admin'], withheld: [] });
      await expect(
        expander.ceilStepTokenPermissions('org_a', 'proj_a', 'user_padmin', ['orgdocs:admin'], 'step'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        expander.ceilStepTokenPermissions('org_a', 'proj_a', 'user_oadmin', ['cloud_fs:admin'], 'step'),
      ).resolves.toEqual({ permissions: ['cloud_fs:admin'], withheld: [] });
    }
  });

  it("are signed by mint-job-token only for an actor who holds them for the job's project", async () => {
    const controller = new AuthInternalController(buildAuthService(), rawSql, new AccessService({} as never, rawSql));
    const requested = ['jobs:read', ...ORG_DATA_ADMIN];

    m.jobs.push({ id: 'a-none', project_id: 'proj_a', actor_user_id: null, target: null });
    m.jobs.push({ id: 'a-padmin', project_id: 'proj_a', actor_user_id: 'user_padmin', target: null });
    m.jobs.push({ id: 'a-oadmin', project_id: 'proj_a', actor_user_id: 'user_oadmin', target: null });

    const permissionsFor = async (jobId: string) =>
      decode((await controller.mintJobToken({ job_id: jobId, permissions: requested })).access_token).permissions;

    expect(await permissionsFor('a-none')).toEqual(['jobs:read']);
    expect(await permissionsFor('a-padmin')).toEqual(['jobs:read', 'cloud_fs:admin']);
    expect(await permissionsFor('a-oadmin')).toEqual(['jobs:read', 'cloud_fs:admin']);
  });
});

describe('org filesystem sharing and publishing', () => {
  const jobToken: AuthUser = {
    user_id: 'user_padmin',
    is_job_token: true,
    job_id: 'a-1',
    project_id: 'proj_a',
    org_id: 'org_a',
    permissions: ['orgfs:read', 'orgfs:write', 'orgfs:admin'],
  };
  const person: AuthUser = { user_id: 'user_oadmin' };

  function controller() {
    const service = {
      createShare: vi.fn(async () => ({})),
      revokeShare: vi.fn(async () => ({})),
      createPublicPath: vi.fn(async () => ({})),
      deletePublicPath: vi.fn(async () => undefined),
    };
    const scopedAccess = { assert: vi.fn(async () => undefined) };
    return { service, controller: new OrgFsSyncController(service as never, scopedAccess as never) };
  }

  it('refuse job and service tokens', async () => {
    for (const token of [jobToken, { ...jobToken, is_job_token: false, is_service_token: true } as AuthUser]) {
      const { service, controller: c } = controller();

      await expect(c.createShare('org_a', { path: '/x.md' } as never, token, 'r')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.revokeShare('org_a', 'shr_1', token, 'r')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.createPublicPath('org_a', { path_prefix: '/pub/' } as never, token, 'r')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.deletePublicPath('org_a', 'pp_1', token, 'r')).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.createShare).not.toHaveBeenCalled();
      expect(service.revokeShare).not.toHaveBeenCalled();
      expect(service.createPublicPath).not.toHaveBeenCalled();
      expect(service.deletePublicPath).not.toHaveBeenCalled();
    }
  });

  it('still let people share and publish', async () => {
    const { service, controller: c } = controller();

    await c.createShare('org_a', { path: '/x.md' } as never, person, 'r');
    await c.createPublicPath('org_a', { path_prefix: '/pub/' } as never, person, 'r');

    expect(service.createShare).toHaveBeenCalled();
    expect(service.createPublicPath).toHaveBeenCalled();
  });
});
