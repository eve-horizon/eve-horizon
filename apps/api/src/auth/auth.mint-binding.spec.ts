import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import type { AuthMintRequest } from '@eve/shared';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AppAuthService } from './app-auth.service';
import { MagicLinkService } from './magic-link.service';
import { TokenVerifierService } from './token-verifier.service';
import { BootstrapService } from './bootstrap.service';
import { RbacService } from './rbac.service';
import { PermissionGuard } from './permission.guard';
import { PERMISSION_KEY } from './permission.decorator';
import { IS_PUBLIC_KEY } from './auth.decorator';
import { OrgsService } from '../orgs/orgs.service';
import type { AuthUser } from './auth.types';
import type { MailerService } from '../mailer/mailer.service';
import type { IdentityProviderRegistry } from './providers/index.js';

type Role = 'owner' | 'admin' | 'member';

/** In-memory stand-in for the users, memberships and projects tables. */
const db = vi.hoisted(() => {
  const state = {
    users: [] as Array<{ id: string; email: string; display_name: string | null; is_admin: boolean }>,
    orgMemberships: [] as Array<{ org_id: string; user_id: string; role: 'owner' | 'admin' | 'member'; created_at: Date }>,
    projectMemberships: [] as Array<{ project_id: string; user_id: string; role: 'owner' | 'admin' | 'member' }>,
    projects: [] as Array<{ id: string; org_id: string }>,
  };

  const users = {
    findByEmail: vi.fn(async (email: string) => state.users.find((u) => u.email === email) ?? null),
    findById: vi.fn(async (id: string) => state.users.find((u) => u.id === id) ?? null),
    create: vi.fn(async (row: { id: string; email: string; display_name: string | null; is_admin: boolean }) => {
      state.users.push(row);
      return row;
    }),
  };

  const memberships = {
    findOrgMembership: vi.fn(async (userId: string, orgId: string) =>
      state.orgMemberships.find((m) => m.user_id === userId && m.org_id === orgId) ?? null),
    findProjectMembership: vi.fn(async (userId: string, projectId: string) =>
      state.projectMemberships.find((m) => m.user_id === userId && m.project_id === projectId) ?? null),
    listOrgMembershipsForUser: vi.fn(async (userId: string) =>
      state.orgMemberships.filter((m) => m.user_id === userId)),
    listProjectMembershipsForUser: vi.fn(async (userId: string, options: { org_id?: string } = {}) =>
      state.projectMemberships.filter((m) => {
        if (m.user_id !== userId) return false;
        if (!options.org_id) return true;
        return state.projects.find((p) => p.id === m.project_id)?.org_id === options.org_id;
      })),
    upsertOrgMembership: vi.fn(async (orgId: string, userId: string, role: 'owner' | 'admin' | 'member') => {
      state.orgMemberships = state.orgMemberships.filter((m) => !(m.user_id === userId && m.org_id === orgId));
      const row = { org_id: orgId, user_id: userId, role, created_at: new Date(), updated_at: new Date() };
      state.orgMemberships.push(row);
      return row;
    }),
    upsertProjectMembership: vi.fn(async (projectId: string, userId: string, role: 'owner' | 'admin' | 'member') => {
      const row = { project_id: projectId, user_id: userId, role };
      state.projectMemberships.push(row);
      return row;
    }),
  };

  const projects = {
    findById: vi.fn(async (id: string) => state.projects.find((p) => p.id === id) ?? null),
  };

  const accessRoles = {
    getEffectiveCustomPermissions: vi.fn(async () => []),
  };

  const identities = {
    findByFingerprint: vi.fn(async () => null),
    listByUserAndProvider: vi.fn(async () => []),
    create: vi.fn(async (row: Record<string, unknown>) => ({ ...row, created_at: new Date(), updated_at: new Date() })),
  };

  return { state, users, memberships, projects, accessRoles, identities };
});

vi.mock('@eve/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/db')>();
  return {
    ...actual,
    userQueries: vi.fn(() => db.users),
    membershipQueries: vi.fn(() => db.memberships),
    projectQueries: vi.fn(() => db.projects),
    accessRoleQueries: vi.fn(() => db.accessRoles),
    identityQueries: vi.fn(() => db.identities),
  };
});

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const knownOrgs = ['org_mine', 'org_other'];

/** Raw SQL: org lookups by id find the known orgs; everything else returns no rows. */
const rawSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join('?');
  if (/FROM orgs WHERE \(id = \? OR slug = \?\)/.test(sql)) {
    return knownOrgs.includes(values[0] as string) ? [{ id: values[0] }] : [];
  }
  return [];
}) as never;

function addUser(id: string, email: string, options: { is_admin?: boolean } = {}): void {
  db.state.users.push({ id, email, display_name: null, is_admin: options.is_admin ?? false });
}

function joinOrg(userId: string, orgId: string, role: Role): void {
  db.state.orgMemberships.push({ org_id: orgId, user_id: userId, role, created_at: new Date() });
}

function build() {
  const mailer = { send: vi.fn() } as unknown as MailerService;
  const magicLink = new MagicLinkService({} as never, mailer);
  const appAuth = new AppAuthService({} as never, magicLink);
  const tokenVerifier = new TokenVerifierService(rawSql, appAuth, magicLink);
  const bootstrap = new BootstrapService({} as never, appAuth);
  const authService = new AuthService({} as never, {} as IdentityProviderRegistry, magicLink, appAuth, tokenVerifier, bootstrap);
  const rbacService = new RbacService(rawSql);
  const controller = new AuthController(authService, rbacService, mailer);
  const orgs = new OrgsService({} as never, authService, mailer);
  return { controller, authService, rbacService, orgs };
}

/** Runs the permission guard for a route that requires `required` (none = undecorated). */
function guardAllows(
  rbacService: RbacService,
  user: AuthUser,
  request: { params?: Record<string, string>; url: string; route: string; body?: unknown },
  required: string[] = [],
): Promise<boolean> {
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => {
      if (key === PERMISSION_KEY) return required;
      if (key === IS_PUBLIC_KEY) return false;
      return undefined;
    }),
  };
  const guard = new PermissionGuard({ isEnabled: () => true } as never, rbacService, reflector as never);
  return guard.canActivate({
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        params: request.params ?? {},
        body: request.body,
        url: request.url,
        routeOptions: { url: request.route },
      }),
    }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as never);
}

function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

describe('POST /auth/mint tokens minted by an org or project admin', () => {
  const orgOwner: AuthUser = { user_id: 'user_owner' };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'true';
    process.env.EVE_AUTH_PRIVATE_KEY = privatePem;
    process.env.EVE_AUTH_TOKEN_TTL_DAYS = '7';

    db.state.users = [];
    db.state.orgMemberships = [];
    db.state.projectMemberships = [];
    db.state.projects = [
      { id: 'proj_mine', org_id: 'org_mine' },
      { id: 'proj_other', org_id: 'org_other' },
    ];

    addUser('user_owner', 'owner@example.com');
    joinOrg('user_owner', 'org_mine', 'owner');
    addUser('user_other_owner', 'boss@other.example');
    joinOrg('user_other_owner', 'org_other', 'owner');
  });

  it("stay bound to the minting org after another org adds the same email", async () => {
    const { controller, authService, rbacService, orgs } = build();
    const minted = await controller.mint(
      { email: 'newhire@other.example', org_id: 'org_mine', role: 'member', ttl_days: 7 } as AuthMintRequest,
      orgOwner,
    );
    expect(minted.created).toBe(true);

    // The holder cannot attach a login key of their own to the account.
    const holder = await authService.verifyAuthorizationHeader(`Bearer ${minted.access_token}`);
    await expect(
      guardAllows(rbacService, holder, { url: '/auth/identities', route: '/auth/identities', body: { public_key: 'ssh-ed25519 AAAA' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Later the other org adds the same email as an admin.
    await orgs.addMember('org_other', { email: 'newhire@other.example', role: 'admin' } as never);
    db.state.projects.push({ id: 'proj_other2', org_id: 'org_other' });

    const later = await authService.verifyAuthorizationHeader(`Bearer ${minted.access_token}`);
    expect(later.memberships?.map((m) => m.org_id)).toEqual(['org_mine']);

    await expect(
      guardAllows(
        rbacService,
        later,
        { params: { project_id: 'proj_other' }, url: '/projects/proj_other/jobs', route: '/projects/:project_id/jobs' },
        ['jobs:write'],
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guardAllows(
        rbacService,
        later,
        { params: { org_id: 'org_other' }, url: '/orgs/org_other/docs', route: '/orgs/:org_id/docs' },
        ['orgdocs:read'],
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guardAllows(rbacService, later, { url: '/auth/identities', route: '/auth/identities' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cannot register a login key, even when the service is called directly', async () => {
    const { controller, authService } = build();
    const minted = await controller.mint(
      { email: 'newhire@other.example', org_id: 'org_mine', role: 'member' } as AuthMintRequest,
      orgOwner,
    );
    const holder = await authService.verifyAuthorizationHeader(`Bearer ${minted.access_token}`);
    const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl holder';

    await expect(controller.registerIdentity({ public_key: publicKey } as never, holder)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(authService.registerIdentity({ public_key: publicKey }, holder)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cannot mint further tokens or reach user-level routes', async () => {
    const { controller, authService, rbacService } = build();
    const minted = await controller.mint(
      { email: 'app-bot@example.com', org_id: 'org_mine', role: 'member' } as AuthMintRequest,
      orgOwner,
    );
    const bot = await authService.verifyAuthorizationHeader(`Bearer ${minted.access_token}`);

    await expect(
      guardAllows(rbacService, bot, { url: '/auth/mint', route: '/auth/mint', body: { email: 'x@example.com', org_id: 'org_mine' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guardAllows(rbacService, bot, { params: { user_id: minted.user_id }, url: `/users/${minted.user_id}/secrets`, route: '/users/:user_id/secrets' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guardAllows(rbacService, bot, { url: '/orgs', route: '/orgs', body: { name: 'side-org' } }, ['orgs:create']),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cannot create an org, even when the body names its own org', async () => {
    const { controller, authService, rbacService } = build();
    const minted = await controller.mint(
      { email: 'app-bot@example.com', org_id: 'org_mine', role: 'member' } as AuthMintRequest,
      orgOwner,
    );
    const bot = await authService.verifyAuthorizationHeader(`Bearer ${minted.access_token}`);

    for (const route of ['/orgs', '/orgs/ensure']) {
      await expect(
        guardAllows(rbacService, bot, { url: route, route, body: { name: 'side-org', org_id: 'org_mine' } }, ['orgs:create']),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it("let a bot minted by an org admin work on its own org's project routes", async () => {
    const { controller, authService, rbacService } = build();
    addUser('user_admin', 'admin@example.com');
    joinOrg('user_admin', 'org_mine', 'admin');
    const minted = await controller.mint(
      { email: 'app-bot@example.com', org_id: 'org_mine', role: 'member' } as AuthMintRequest,
      { user_id: 'user_admin' },
    );
    const bot = await authService.verifyAuthorizationHeader(`Bearer ${minted.access_token}`);

    await expect(
      guardAllows(
        rbacService,
        bot,
        { params: { project_id: 'proj_mine' }, url: '/projects/proj_mine/jobs', route: '/projects/:project_id/jobs' },
        ['jobs:write'],
      ),
    ).resolves.toBe(true);
    await expect(
      guardAllows(
        rbacService,
        bot,
        { params: { org_id: 'org_mine' }, url: '/orgs/org_mine/docs', route: '/orgs/:org_id/docs' },
        ['orgs:read'],
      ),
    ).resolves.toBe(true);
  });

  it('keep the requested lifetime within the documented 1-90 days', async () => {
    const { controller } = build();
    const now = Math.floor(Date.now() / 1000);
    const minted = await controller.mint(
      { email: 'app-bot@example.com', org_id: 'org_mine', role: 'member', ttl_days: 90 } as AuthMintRequest,
      orgOwner,
    );

    expect(minted.expires_at).toBeGreaterThanOrEqual(now + 90 * 24 * 60 * 60 - 5);
    expect(minted.expires_at).toBeLessThanOrEqual(now + 90 * 24 * 60 * 60 + 5);
  });
});

describe('POST /auth/mint tokens minted by a system admin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'true';
    process.env.EVE_AUTH_PRIVATE_KEY = privatePem;
    process.env.EVE_AUTH_TOKEN_TTL_DAYS = '7';
    db.state.users = [];
    db.state.orgMemberships = [];
    db.state.projectMemberships = [];
    db.state.projects = [];
    addUser('user_root', 'root@example.com', { is_admin: true });
  });

  it('stay unbound', async () => {
    const { controller, authService } = build();
    const minted = await controller.mint(
      { email: 'ops-bot@example.com', org_id: 'org_mine', role: 'member' } as AuthMintRequest,
      { user_id: 'user_root', is_admin: true },
    );
    joinOrg(minted.user_id, 'org_other', 'member');

    expect(decode(minted.access_token).bound_org_id).toBeUndefined();
    const bot = await authService.verifyAuthorizationHeader(`Bearer ${minted.access_token}`);
    expect(bot.memberships?.map((m) => m.org_id).sort()).toEqual(['org_mine', 'org_other']);
  });
});
