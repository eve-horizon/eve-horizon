import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller';
import type { AuthService, AuthUser } from './auth.service';
import type { RbacService } from './rbac.service';
import type { MailerService } from '../mailer/mailer.service';

type AuthServiceMock = {
  isEnabled: ReturnType<typeof vi.fn<() => boolean>>;
  verifyAuthorizationHeader: ReturnType<typeof vi.fn<(header: string) => Promise<AuthUser>>>;
  getAppAuthContext: ReturnType<typeof vi.fn<AuthService['getAppAuthContext']>>;
  getAppAuthContextAdmin: ReturnType<typeof vi.fn<AuthService['getAppAuthContextAdmin']>>;
  getAppAccess: ReturnType<typeof vi.fn<AuthService['getAppAccess']>>;
  createAppInvite: ReturnType<typeof vi.fn<AuthService['createAppInvite']>>;
  sendAppMagicLink: ReturnType<typeof vi.fn<AuthService['sendAppMagicLink']>>;
  generateInviteLink: ReturnType<typeof vi.fn<(email: string, redirectTo?: string) => Promise<string>>>;
  generateWrappedInviteLink: ReturnType<typeof vi.fn<AuthService['generateWrappedInviteLink']>>;
};

type MailerServiceMock = {
  send: ReturnType<typeof vi.fn<MailerService['send']>>;
};

describe('AuthController /auth/me', () => {
  let authService: AuthServiceMock;
  let mailerService: MailerServiceMock;
  let controller: AuthController;

  beforeEach(() => {
    authService = {
      isEnabled: vi.fn<() => boolean>(),
      verifyAuthorizationHeader: vi.fn<(header: string) => Promise<AuthUser>>(),
      getAppAuthContext: vi.fn<AuthService['getAppAuthContext']>(),
      getAppAuthContextAdmin: vi.fn<AuthService['getAppAuthContextAdmin']>(),
      getAppAccess: vi.fn<AuthService['getAppAccess']>(),
      createAppInvite: vi.fn<AuthService['createAppInvite']>(),
      sendAppMagicLink: vi.fn<AuthService['sendAppMagicLink']>(),
      generateInviteLink: vi.fn<(email: string, redirectTo?: string) => Promise<string>>(),
      generateWrappedInviteLink: vi.fn<AuthService['generateWrappedInviteLink']>(),
    };
    mailerService = {
      send: vi.fn<MailerService['send']>(),
    };
    controller = new AuthController(
      authService as unknown as AuthService,
      {} as RbacService,
      mailerService as unknown as MailerService,
    );
  });

  it('returns unauthenticated when auth is enabled but no header is provided', async () => {
    authService.isEnabled.mockReturnValue(true);

    const response = await controller.me(undefined);

    expect(response).toEqual({
      auth_enabled: true,
      authenticated: false,
    });
  });

  it('returns explicit job token claims and permissions without role expansion', async () => {
    authService.isEnabled.mockReturnValue(true);
    authService.verifyAuthorizationHeader.mockResolvedValue({
      user_id: 'user_123',
      role: 'member',
      is_admin: false,
      org_id: 'org_123',
      is_job_token: true,
      job_id: 'job_123',
      project_id: 'proj_123',
      permissions: ['projects:read'],
    });

    const response = await controller.me('Bearer job-token');

    expect(response).toMatchObject({
      auth_enabled: true,
      authenticated: true,
      type: 'job',
      user_id: 'user_123',
      org_id: 'org_123',
      job_id: 'job_123',
      project_id: 'proj_123',
      is_job_token: true,
      permissions: ['projects:read'],
    });
    expect(response.permissions).not.toContain('projects:create');
  });

  it('expands permissions for user tokens', async () => {
    authService.isEnabled.mockReturnValue(true);
    authService.verifyAuthorizationHeader.mockResolvedValue({
      user_id: 'user_456',
      email: 'user@example.com',
      role: 'member',
      is_admin: false,
    });

    const response = await controller.me('Bearer user-token');

    expect(response.type).toBe('user');
    expect(response.permissions).toContain('projects:create');
    expect(response.is_job_token).toBeUndefined();
  });

  it('expands permissions across all user memberships when role is unset', async () => {
    authService.isEnabled.mockReturnValue(true);
    authService.verifyAuthorizationHeader.mockResolvedValue({
      user_id: 'user_789',
      email: 'multi-org@example.test',
      is_admin: false,
      memberships: [
        { org_id: 'org_1', role: 'owner' },
        { org_id: 'org_2', role: 'member' },
      ],
    });

    const response = await controller.me('Bearer multi-org-token');

    expect(response.permissions).toContain('projects:create');
    expect(response.permissions).toContain('jobs:write');
    expect(response.permissions).toContain('orgs:admin');
    expect(response.permissions).toContain('events:read');
  });
});

describe('AuthController /auth/supabase/invite', () => {
  let authService: AuthServiceMock;
  let mailerService: MailerServiceMock;
  let controller: AuthController;

  beforeEach(() => {
    authService = {
      isEnabled: vi.fn<() => boolean>(),
      verifyAuthorizationHeader: vi.fn<(header: string) => Promise<AuthUser>>(),
      getAppAuthContext: vi.fn<AuthService['getAppAuthContext']>(),
      getAppAuthContextAdmin: vi.fn<AuthService['getAppAuthContextAdmin']>(),
      getAppAccess: vi.fn<AuthService['getAppAccess']>(),
      createAppInvite: vi.fn<AuthService['createAppInvite']>(),
      sendAppMagicLink: vi.fn<AuthService['sendAppMagicLink']>(),
      generateInviteLink: vi.fn<(email: string, redirectTo?: string) => Promise<string>>(),
      generateWrappedInviteLink: vi.fn<AuthService['generateWrappedInviteLink']>(),
    };
    mailerService = {
      send: vi.fn<MailerService['send']>(),
    };
    controller = new AuthController(
      authService as unknown as AuthService,
      {} as RbacService,
      mailerService as unknown as MailerService,
    );
  });

  it('sends a default-branded invite through the shared mailer path, wrapping the action link', async () => {
    authService.generateWrappedInviteLink.mockResolvedValue('http://sso.eve.lvh.me/m/mlw_abc123');

    const response = await controller.sendSupabaseInvite(
      { email: 'invitee@example.com', redirect_to: 'http://app.example.com' },
      { user_id: 'user_admin', is_admin: true },
    );

    expect(response).toEqual({ email: 'invitee@example.com', invited: true });
    expect(authService.generateWrappedInviteLink).toHaveBeenCalledWith({
      email: 'invitee@example.com',
      redirectTo: 'http://app.example.com',
      projectId: null,
      orgId: null,
    });
    const sendCall = mailerService.send.mock.calls[0][0];
    expect(sendCall.to).toBe('invitee@example.com');
    expect(sendCall.fromName).toBe('Eve Horizon');
    expect(sendCall.subject).toBe('You have been invited to Eve Horizon');
    expect(sendCall.html).toContain('http://sso.eve.lvh.me/m/mlw_abc123');
    expect(sendCall.html).not.toContain('auth.eve.lvh.me/verify');
  });
});

describe('AuthController app-scoped magic links', () => {
  let authService: AuthServiceMock;
  let controller: AuthController;

  beforeEach(() => {
    authService = {
      isEnabled: vi.fn<() => boolean>(),
      verifyAuthorizationHeader: vi.fn<(header: string) => Promise<AuthUser>>(),
      getAppAuthContext: vi.fn<AuthService['getAppAuthContext']>(),
      getAppAuthContextAdmin: vi.fn<AuthService['getAppAuthContextAdmin']>(),
      getAppAccess: vi.fn<AuthService['getAppAccess']>(),
      createAppInvite: vi.fn<AuthService['createAppInvite']>(),
      sendAppMagicLink: vi.fn<AuthService['sendAppMagicLink']>(),
      generateInviteLink: vi.fn<(email: string, redirectTo?: string) => Promise<string>>(),
      generateWrappedInviteLink: vi.fn<AuthService['generateWrappedInviteLink']>(),
    };
    controller = new AuthController(
      authService as unknown as AuthService,
      {} as RbacService,
      { send: vi.fn<MailerService['send']>() } as unknown as MailerService,
    );
  });

  it('returns safe public app auth context', async () => {
    authService.getAppAuthContext.mockResolvedValue({
      project_id: 'proj_123',
      org_id: 'org_123',
      branding: {
        app_name: 'ACME Portal',
        primary_color: '#1f6feb',
      },
      auth: {
        login_method: 'magic_link',
        self_signup: false,
        invite_requires_password: false,
        org_access: {
          mode: 'allowlist',
          multi_org: true,
          invite_enabled: true,
          domain_signup_enabled: false,
        },
        allowed_redirect_origins: [],
      },
    });

    await expect(controller.getAppContext('proj_123')).resolves.toMatchObject({
      project_id: 'proj_123',
      branding: { app_name: 'ACME Portal' },
      auth: { login_method: 'magic_link' },
    });
    expect(authService.getAppAuthContext).toHaveBeenCalledWith('proj_123');
  });

  it('admin reveal returns full domain_signup block to project admins', async () => {
    const rbacService = {
      requireProjectRole: vi.fn().mockResolvedValue(undefined),
    };
    controller = new AuthController(
      authService as unknown as AuthService,
      rbacService as unknown as RbacService,
      { send: vi.fn<MailerService['send']>() } as unknown as MailerService,
    );
    authService.getAppAuthContextAdmin.mockResolvedValue({
      project_id: 'proj_123',
      org_id: 'org_123',
      branding: null,
      auth: {
        login_method: 'magic_link',
        self_signup: false,
        invite_requires_password: false,
        allowed_redirect_origins: [],
        org_access: {
          mode: 'allowlist',
          allowed_orgs: ['org_target'],
          multi_org: true,
          invite_enabled: false,
          domain_signup_enabled: true,
          domain_signup: {
            enabled: true,
            domains: [
              { domain: 'acme.com', target_org: 'org_target', role: 'member' },
              { domain: '*.acme.com', target_org: 'org_target', role: 'member' },
            ],
          },
        },
      },
    });

    await expect(controller.getAppContextAdmin('proj_123', { user_id: 'user_admin', is_admin: false })).resolves.toMatchObject({
      auth: {
        org_access: {
          domain_signup: {
            domains: [
              { domain: 'acme.com', target_org: 'org_target' },
              { domain: '*.acme.com', target_org: 'org_target' },
            ],
          },
        },
      },
    });
    expect(rbacService.requireProjectRole).toHaveBeenCalledWith('user_admin', 'proj_123', 'admin');
    expect(authService.getAppAuthContextAdmin).toHaveBeenCalledWith('proj_123');
  });

  it('admin reveal skips RBAC check for system admins', async () => {
    const rbacService = {
      requireProjectRole: vi.fn(),
    };
    controller = new AuthController(
      authService as unknown as AuthService,
      rbacService as unknown as RbacService,
      { send: vi.fn<MailerService['send']>() } as unknown as MailerService,
    );
    authService.getAppAuthContextAdmin.mockResolvedValue({
      project_id: 'proj_123',
      org_id: 'org_123',
      branding: null,
      auth: null,
    });

    await controller.getAppContextAdmin('proj_123', { user_id: 'user_root', is_admin: true });
    expect(rbacService.requireProjectRole).not.toHaveBeenCalled();
  });

  it('returns authenticated app access', async () => {
    authService.getAppAccess.mockResolvedValue({
      project_id: 'proj_123',
      orgs: [{
        id: 'org_123',
        slug: 'tenant',
        name: 'Tenant',
        role: 'admin',
        capabilities: {
          enter_app: true,
          invite_members: true,
        },
      }],
      admin_orgs: [{
        id: 'org_123',
        slug: 'tenant',
        name: 'Tenant',
        role: 'admin',
      }],
    });

    await expect(controller.getAppAccess('proj_123', { user_id: 'user_123' })).resolves.toMatchObject({
      project_id: 'proj_123',
      admin_orgs: [{ id: 'org_123' }],
    });
    expect(authService.getAppAccess).toHaveBeenCalledWith('proj_123', 'user_123');
  });

  it('delegates app invite creation to AuthService', async () => {
    authService.createAppInvite.mockResolvedValue({
      status: 'invited',
      org_id: 'org_123',
      email: 'invitee@example.com',
      role: 'member',
      invite_id: 'invite_123',
    });

    await expect(controller.createAppInvite({
      project_id: 'proj_123',
      org_id: 'org_123',
      email: 'invitee@example.com',
      redirect_to: 'http://app.example.com',
      resend: false,
    }, { user_id: 'user_admin' })).resolves.toEqual({
      status: 'invited',
      org_id: 'org_123',
      email: 'invitee@example.com',
      role: 'member',
      invite_id: 'invite_123',
    });

    expect(authService.createAppInvite).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'proj_123',
      org_id: 'org_123',
      email: 'invitee@example.com',
    }), { user_id: 'user_admin' });
  });

  it('delegates app magic-link sends to AuthService', async () => {
    authService.sendAppMagicLink.mockResolvedValue({ sent: true });

    await expect(controller.sendMagicLink({
      email: 'user@example.com',
      project_id: 'proj_123',
      redirect_to: 'http://app.example.com',
    })).resolves.toEqual({ sent: true });

    expect(authService.sendAppMagicLink).toHaveBeenCalledWith({
      email: 'user@example.com',
      project_id: 'proj_123',
      redirect_to: 'http://app.example.com',
    });
  });
});
