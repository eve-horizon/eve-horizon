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
import type { AuthUser } from './auth.types';
import type { MailerService } from '../mailer/mailer.service';
import type { IdentityProviderRegistry } from './providers/index.js';

type Role = 'owner' | 'admin' | 'member';
type UserRow = { id: string; email: string; display_name: string | null; is_admin: boolean };

/** In-memory stand-in for the users, memberships and projects tables. */
const db = vi.hoisted(() => {
  const state = {
    users: [] as Array<{ id: string; email: string; display_name: string | null; is_admin: boolean }>,
    orgMemberships: [] as Array<{ org_id: string; user_id: string; role: 'owner' | 'admin' | 'member'; created_at: Date }>,
    projectMemberships: [] as Array<{ project_id: string; user_id: string; role: 'owner' | 'admin' | 'member' }>,
    projects: [] as Array<{ id: string; org_id: string }>,
    identities: [] as Array<{ user_id: string; provider: string }>,
    userSecrets: [] as Array<{ user_id: string; key: string }>,
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
      const row = { org_id: orgId, user_id: userId, role, created_at: new Date() };
      state.orgMemberships.push(row);
      return row;
    }),
    upsertProjectMembership: vi.fn(async (projectId: string, userId: string, role: 'owner' | 'admin' | 'member') => {
      state.projectMemberships = state.projectMemberships.filter((m) => !(m.user_id === userId && m.project_id === projectId));
      const row = { project_id: projectId, user_id: userId, role };
      state.projectMemberships.push(row);
      return row;
    }),
  };

  const projects = {
    findById: vi.fn(async (id: string) => state.projects.find((p) => p.id === id) ?? null),
  };

  const identities = {
    listByUser: vi.fn(async (userId: string) => state.identities.filter((i) => i.user_id === userId)),
  };

  const secrets = {
    listByScope: vi.fn(async (scopeType: string, scopeId: string) =>
      scopeType === 'user' ? state.userSecrets.filter((s) => s.user_id === scopeId) : []),
  };

  return { state, users, memberships, projects, identities, secrets };
});

vi.mock('@eve/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/db')>();
  return {
    ...actual,
    userQueries: vi.fn(() => db.users),
    membershipQueries: vi.fn(() => db.memberships),
    projectQueries: vi.fn(() => db.projects),
    identityQueries: vi.fn(() => db.identities),
    secretQueries: vi.fn(() => db.secrets),
  };
});

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function addUser(id: string, email: string, options: { is_admin?: boolean } = {}): UserRow {
  const row = { id, email, display_name: null, is_admin: options.is_admin ?? false };
  db.state.users.push(row);
  return row;
}

function joinOrg(userId: string, orgId: string, role: Role): void {
  db.state.orgMemberships.push({ org_id: orgId, user_id: userId, role, created_at: new Date() });
}

function joinProject(userId: string, projectId: string, role: Role): void {
  db.state.projectMemberships.push({ project_id: projectId, user_id: userId, role });
}

function buildController(): AuthController {
  const mailer = { send: vi.fn() } as unknown as MailerService;
  const magicLink = new MagicLinkService({} as never, mailer);
  const appAuth = new AppAuthService({} as never, magicLink);
  const tokenVerifier = new TokenVerifierService({} as never, appAuth, magicLink);
  const bootstrap = new BootstrapService({} as never, appAuth);
  const authService = new AuthService(
    {} as never,
    {} as IdentityProviderRegistry,
    magicLink,
    appAuth,
    tokenVerifier,
    bootstrap,
  );
  const rbacService = new RbacService({} as never);
  return new AuthController(authService, rbacService, mailer);
}

function mintRequest(overrides: Partial<AuthMintRequest> & { email: string }): AuthMintRequest {
  return { role: 'member', ...overrides } as AuthMintRequest;
}

describe('AuthController POST /auth/mint', () => {
  let controller: AuthController;
  const orgOwner: AuthUser = { user_id: 'user_owner' };
  const orgAdmin: AuthUser = { user_id: 'user_admin' };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'true';
    process.env.EVE_AUTH_PRIVATE_KEY = privatePem;

    db.state.users = [];
    db.state.orgMemberships = [];
    db.state.projectMemberships = [];
    db.state.identities = [];
    db.state.userSecrets = [];
    db.state.projects = [
      { id: 'proj_a', org_id: 'org_a' },
      { id: 'proj_a2', org_id: 'org_a' },
      { id: 'proj_b', org_id: 'org_b' },
    ];

    addUser('user_owner', 'owner@example.com');
    joinOrg('user_owner', 'org_a', 'owner');
    addUser('user_admin', 'admin@example.com');
    joinOrg('user_admin', 'org_a', 'admin');

    controller = buildController();
  });

  function expectNothingMinted(): void {
    expect(db.users.create).not.toHaveBeenCalled();
    expect(db.memberships.upsertOrgMembership).not.toHaveBeenCalled();
    expect(db.memberships.upsertProjectMembership).not.toHaveBeenCalled();
  }

  describe('callers who are not system admins', () => {
    it('cannot mint a token for a system admin', async () => {
      addUser('user_root', 'root@example.com', { is_admin: true });
      joinOrg('user_root', 'org_a', 'member');

      await expect(
        controller.mint(mintRequest({ email: 'root@example.com', org_id: 'org_a' }), orgOwner),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expectNothingMinted();
    });

    it('cannot mint a token for an existing user who is not in the org', async () => {
      addUser('user_outside', 'outside@example.com');

      await expect(
        controller.mint(mintRequest({ email: 'outside@example.com', org_id: 'org_a' }), orgOwner),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expectNothingMinted();
    });

    it('cannot mint a token for an org member who also belongs to another org', async () => {
      addUser('user_shared', 'shared@example.com');
      joinOrg('user_shared', 'org_a', 'member');
      joinOrg('user_shared', 'org_b', 'owner');

      await expect(
        controller.mint(mintRequest({ email: 'shared@example.com', org_id: 'org_a' }), orgOwner),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expectNothingMinted();
    });

    it('cannot mint a token for an org member who belongs to a project in another org', async () => {
      addUser('user_guest', 'guest@example.com');
      joinOrg('user_guest', 'org_a', 'member');
      joinProject('user_guest', 'proj_b', 'admin');

      await expect(
        controller.mint(mintRequest({ email: 'guest@example.com', project_id: 'proj_a' }), orgOwner),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expectNothingMinted();
    });

    it('cannot mint a token for a user whose role in the org is higher than their own', async () => {
      await expect(
        controller.mint(mintRequest({ email: 'owner@example.com', org_id: 'org_a' }), orgAdmin),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expectNothingMinted();
    });

    it("cannot mint a token for a user whose role in one of the org's projects is higher than their own", async () => {
      addUser('user_member', 'member@example.com');
      joinOrg('user_member', 'org_a', 'member');
      joinProject('user_member', 'proj_a', 'admin');
      addUser('user_lead', 'lead@example.com');
      joinOrg('user_lead', 'org_a', 'member');
      joinProject('user_lead', 'proj_a2', 'admin');

      await expect(
        controller.mint(mintRequest({ email: 'lead@example.com', project_id: 'proj_a' }), { user_id: 'user_member' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expectNothingMinted();
    });

    it('cannot grant a role above their own role in the org', async () => {
      addUser('user_member', 'member@example.com');
      joinOrg('user_member', 'org_a', 'member');
      joinProject('user_member', 'proj_a', 'admin');

      await expect(
        controller.mint(
          mintRequest({ email: 'new-bot@example.com', project_id: 'proj_a', role: 'admin' }),
          { user_id: 'user_member' },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expectNothingMinted();
    });

    it('creates a new bot user in the org and mints its token', async () => {
      const response = await controller.mint(
        mintRequest({ email: 'app-bot@example.com', org_id: 'org_a' }),
        orgAdmin,
      );

      expect(response.created).toBe(true);
      expect(response.org_id).toBe('org_a');
      expect(response.role).toBe('member');
      expect(response.access_token).toEqual(expect.any(String));
      expect(db.memberships.upsertOrgMembership).toHaveBeenCalledWith('org_a', response.user_id, 'member');
    });

    it('cannot mint a token for an existing member who signs in as a person', async () => {
      for (const provider of ['github_ssh', 'supabase', 'nostr']) {
        const userId = `user_person_${provider}`;
        addUser(userId, `${provider}@example.com`);
        joinOrg(userId, 'org_a', 'member');
        db.state.identities.push({ user_id: userId, provider });

        await expect(
          controller.mint(mintRequest({ email: `${provider}@example.com`, org_id: 'org_a' }), orgOwner),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      expectNothingMinted();
    });

    it('cannot mint a token for an existing member who keeps personal secrets', async () => {
      addUser('user_keeper', 'keeper@example.com');
      joinOrg('user_keeper', 'org_a', 'member');
      db.state.userSecrets.push({ user_id: 'user_keeper', key: 'GITHUB_TOKEN' });

      await expect(
        controller.mint(mintRequest({ email: 'keeper@example.com', org_id: 'org_a' }), orgOwner),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expectNothingMinted();
    });

    it('mints again for an existing bot that belongs only to the org', async () => {
      addUser('user_bot', 'app-bot@example.com');
      joinOrg('user_bot', 'org_a', 'member');
      joinProject('user_bot', 'proj_a', 'member');

      const response = await controller.mint(
        mintRequest({ email: 'app-bot@example.com', project_id: 'proj_a', role: 'admin' }),
        orgAdmin,
      );

      expect(response.created).toBe(false);
      expect(response.user_id).toBe('user_bot');
      expect(response.project_id).toBe('proj_a');
      expect(response.access_token).toEqual(expect.any(String));
    });
  });

  describe('system admins', () => {
    it('keep minting for any user', async () => {
      addUser('user_root', 'root@example.com', { is_admin: true });
      addUser('user_shared', 'shared@example.com');
      joinOrg('user_shared', 'org_b', 'owner');

      const forAdmin = await controller.mint(
        mintRequest({ email: 'root@example.com', org_id: 'org_a' }),
        { user_id: 'user_root', is_admin: true },
      );
      const forOutsider = await controller.mint(
        mintRequest({ email: 'shared@example.com', org_id: 'org_a', role: 'admin' }),
        { user_id: 'user_root', is_admin: true },
      );

      expect(forAdmin.user_id).toBe('user_root');
      expect(forOutsider.user_id).toBe('user_shared');
    });
  });
});
