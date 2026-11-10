import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { AccessService } from './access.service';
import { AuthService } from './auth.service';
import { AppAuthService } from './app-auth.service';
import { MagicLinkService } from './magic-link.service';
import { TokenVerifierService } from './token-verifier.service';
import { BootstrapService } from './bootstrap.service';
import { AuthInternalController } from './auth.internal.controller';
import { WorkflowsService } from '../workflows/workflows.service';
import type { MailerService } from '../mailer/mailer.service';
import type { IdentityProviderRegistry } from './providers/index.js';

/**
 * A tenant shape: a script step that writes the org filesystem and a cloud-fs
 * mount, run by people who hold those permissions on the project only.
 */
const MANIFEST = `
name: a
workflows:
  scaffold:
    steps:
      - name: scaffold
        permissions: [orgfs:read, orgfs:write, cloud_fs:read, cloud_fs:write, cloud_fs:admin, jobs:write]
        script:
          run: "true"
  mount-admin:
    steps:
      - name: tidy
        permissions: [cloud_fs:admin, jobs:write]
        script:
          run: "true"
`;

/**
 * A project-scoped custom role binding, as an access.yaml would declare it. The
 * binding scope names the org paths and the cloud-fs mount it covers: cloud_fs
 * permissions need a cloud_fs scope on the grant to count.
 */
const PROJECT_ANALYST_ROLE = {
  project_id: 'proj_a',
  role_name: 'project_analyst',
  role_permissions: ['jobs:harness_override', 'orgfs:read', 'orgfs:write', 'cloud_fs:read', 'cloud_fs:write', 'cloud_fs:admin'],
  scope_json: {
    orgfs: { allow_prefixes: ['/groups/projects/proj-a'] },
    cloud_fs: { allow_mount_ids: ['mnt_proj_a'] },
  },
};

/**
 * user_analyst: org member, holds PROJECT_ANALYST_ROLE on proj_a.
 * user_padmin: org member, built-in admin role on proj_a.
 */
const m = vi.hoisted(() => {
  const jobs: Array<Record<string, unknown>> = [];
  let n = 0;
  return {
    jobs,
    memberships: {
      findProjectMembership: vi.fn(async (userId: string, projectId: string) =>
        userId === 'user_padmin' && projectId === 'proj_a' ? { role: 'admin' } : null),
      findOrgMembership: vi.fn(async (userId: string, orgId: string) =>
        orgId === 'org_a' && (userId === 'user_analyst' || userId === 'user_padmin') ? { role: 'member' } : null),
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
      // Set per test: project-scoped bindings apply only when the check names that project.
      listApplicableBindings: vi.fn(async (_params: { principalId: string; projectId?: string }): Promise<unknown[]> => []),
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

function buildAuthService(): AuthService {
  const mailer = { send: vi.fn() } as unknown as MailerService;
  const magicLink = new MagicLinkService({} as never, mailer);
  const appAuth = new AppAuthService({} as never, magicLink);
  const tokenVerifier = new TokenVerifierService(rawSql, appAuth, magicLink);
  const bootstrap = new BootstrapService({} as never, appAuth);
  return new AuthService({} as never, {} as IdentityProviderRegistry, magicLink, appAuth, tokenVerifier, bootstrap);
}

async function mintedPermissions(job: Record<string, unknown>): Promise<string[]> {
  const controller = new AuthInternalController(buildAuthService(), rawSql, new AccessService({} as never, rawSql));
  const minted = await controller.mintJobToken({ job_id: job.id as string, permissions: job.token_permissions as string[] });
  return JSON.parse(Buffer.from(minted.access_token.split('.')[1], 'base64url').toString()).permissions as string[];
}

describe('org data admin held through a project role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.jobs.length = 0;
    m.manifests.findLatestByProject.mockResolvedValue({ manifest_yaml: MANIFEST, manifest_hash: 'h', parsed_defaults: null });
    m.accessRoles.listApplicableBindings.mockImplementation(async (params: { principalId: string; projectId?: string }) =>
      params.principalId === 'user_analyst' && params.projectId === 'proj_a' ? [PROJECT_ANALYST_ROLE] : []);
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'true';
    process.env.EVE_AUTH_PRIVATE_KEY = privatePem;
  });

  it('lets a project-scoped custom role run a step that declares it, and the job token carries it', async () => {
    const workflows = new WorkflowsService(rawSql, new AccessService({} as never, rawSql));

    await workflows.invoke('proj_a', 'scaffold', undefined, false, 'user_analyst');

    const step = m.jobs.find((j) => j.step_name === 'scaffold');
    expect(step?.token_permissions).toEqual(expect.arrayContaining(['cloud_fs:admin', 'orgfs:write']));
    expect(await mintedPermissions(step!)).toEqual(expect.arrayContaining(['cloud_fs:admin', 'orgfs:write']));
  });

  it('lets the built-in project admin role run a step that declares cloud_fs:admin', async () => {
    const workflows = new WorkflowsService(rawSql, new AccessService({} as never, rawSql));

    await workflows.invoke('proj_a', 'mount-admin', undefined, false, 'user_padmin');

    const step = m.jobs.find((j) => j.step_name === 'tidy');
    expect(step?.token_permissions).toEqual(['cloud_fs:admin', 'jobs:write']);
    expect(await mintedPermissions(step!)).toEqual(['cloud_fs:admin', 'jobs:write']);
  });
});
