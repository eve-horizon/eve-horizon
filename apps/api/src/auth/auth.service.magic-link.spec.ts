import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { MagicLinkService } from './magic-link.service';
import { AppAuthService } from './app-auth.service';
import { TokenVerifierService } from './token-verifier.service';
import { BootstrapService } from './bootstrap.service';
import type { MailerService } from '../mailer/mailer.service';
import { EmailSuppressedError } from '../mailer/errors';
import type { IdentityProviderRegistry } from './providers/index.js';

const mocks = vi.hoisted(() => ({
  users: {
    findByEmail: vi.fn(),
  },
  memberships: {
    findOrgMembership: vi.fn(),
    findProjectMembership: vi.fn(),
  },
  projects: {
    findById: vi.fn(),
  },
  appLinkSubscriptions: {
    findWithGrantsById: vi.fn(),
  },
  orgInvites: {
    findPendingByIdentityHintForOrg: vi.fn(),
    findPendingByIdentityHintForOrgs: vi.fn(),
    create: vi.fn(),
  },
  magicLinkWraps: {
    create: vi.fn(),
    inspect: vi.fn(),
    consume: vi.fn(),
    pruneExpired: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock('@eve/db', () => ({
  userQueries: vi.fn(() => mocks.users),
  identityQueries: vi.fn(() => ({})),
  authChallengeQueries: vi.fn(() => ({})),
  membershipQueries: vi.fn(() => mocks.memberships),
  projectQueries: vi.fn(() => mocks.projects),
  appLinkSubscriptionQueries: vi.fn(() => mocks.appLinkSubscriptions),
  orgInviteQueries: vi.fn(() => mocks.orgInvites),
  servicePrincipalQueries: vi.fn(() => ({})),
  magicLinkWrapQueries: vi.fn(() => mocks.magicLinkWraps),
}));

describe('AuthService app magic-link login', () => {
  let service: AuthService;
  let magicLink: MagicLinkService;
  let mailerService: Pick<MailerService, 'send'>;

  function buildService(appAuthPolicy?: unknown): AuthService {
    magicLink = new MagicLinkService(
      {} as never,
      mailerService as MailerService,
      appAuthPolicy as never,
    );
    const appAuth = new AppAuthService(
      {} as never,
      magicLink,
      appAuthPolicy as never,
    );
    const tokenVerifier = new TokenVerifierService(
      {} as never,
      appAuth,
      magicLink,
    );
    const bootstrap = new BootstrapService({} as never, appAuth);
    return new AuthService(
      {} as never,
      {} as IdentityProviderRegistry,
      magicLink,
      appAuth,
      tokenVerifier,
      bootstrap,
      appAuthPolicy as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'false';
    process.env.SUPABASE_AUTH_URL = 'http://auth.eve.lvh.me';
    process.env.SUPABASE_AUTH_SERVICE_KEY = 'service-key';
    process.env.EVE_SSO_URL = 'http://sso.eve.lvh.me';

    mailerService = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    service = buildService();

    mocks.projects.findById.mockResolvedValue({
      id: 'proj_123',
      org_id: 'org_123',
      branding: {
        app_name: 'ACME Portal',
        primary_color: '#1f6feb',
        email_from_name: 'ACME Portal',
      },
      auth_config: {
        login_method: 'magic_link',
        self_signup: false,
        invite_requires_password: false,
      },
    });
    mocks.users.findByEmail.mockResolvedValue(null);
    mocks.memberships.findOrgMembership.mockResolvedValue(null);
    mocks.memberships.findProjectMembership.mockResolvedValue(null);
    mocks.orgInvites.findPendingByIdentityHintForOrg.mockResolvedValue([]);
    mocks.orgInvites.findPendingByIdentityHintForOrgs.mockResolvedValue([]);
    mocks.orgInvites.create.mockResolvedValue({
      id: 'invite_123',
      expires_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    mocks.magicLinkWraps.create.mockImplementation(async (params) => ({
      ...params,
      created_at: new Date(),
      consumed_at: null,
      get_count: 0,
      last_get_at: null,
    }));
  });

  it('returns safe app context with parsed branding and auth config', async () => {
    await expect(service.getAppAuthContext('proj_123')).resolves.toEqual({
      project_id: 'proj_123',
      org_id: 'org_123',
      branding: {
        app_name: 'ACME Portal',
        primary_color: '#1f6feb',
        email_from_name: 'ACME Portal',
      },
      auth: {
        login_method: 'magic_link',
        self_signup: false,
        invite_requires_password: false,
        org_access: {
          mode: 'project_org',
          multi_org: false,
          invite_enabled: false,
          domain_signup_enabled: false,
        },
        allowed_redirect_origins: [],
      },
    });
  });

  it('sends branded magic-link email for an existing org member', async () => {
    mocks.users.findByEmail.mockResolvedValue({ id: 'user_123', email: 'User@Example.com' });
    mocks.memberships.findOrgMembership.mockResolvedValue({ id: 'mem_123' });
    const generate = vi.spyOn(magicLink, 'generateAuthActionLink')
      .mockResolvedValue('http://auth.eve.lvh.me/verify?token=magic');

    await expect(service.sendAppMagicLink({
      email: 'User@Example.com',
      project_id: 'proj_123',
      redirect_to: 'http://api.mlv-mlstrt-sandbox.lvh.me/health',
    })).resolves.toEqual({ sent: true });

    expect(generate).toHaveBeenCalledWith(
      'magiclink',
      'user@example.com',
      'http://sso.eve.lvh.me/?project_id=proj_123&redirect_to=http%3A%2F%2Fapi.mlv-mlstrt-sandbox.lvh.me%2Fhealth',
    );
    expect(mailerService.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@example.com',
      fromName: 'ACME Portal',
      subject: 'Sign in to ACME Portal',
      html: expect.stringContaining('#1f6feb'),
    }));
  });

  describe('magic-link confirmation wrap', () => {
    beforeEach(() => {
      mocks.users.findByEmail.mockResolvedValue({ id: 'user_123', email: 'user@example.com' });
      mocks.memberships.findOrgMembership.mockResolvedValue({ id: 'mem_123' });
    });

    it('writes a wrap row and puts the wrap URL — not the GoTrue URL — into the magic-link email', async () => {
      vi.spyOn(magicLink, 'generateAuthActionLink')
        .mockResolvedValue('http://auth.eve.lvh.me/verify?token=raw-magic-otp');

      await service.sendAppMagicLink({
        email: 'user@example.com',
        project_id: 'proj_123',
      });

      expect(mocks.magicLinkWraps.create).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.stringMatching(/^mlw_[a-z0-9]{26}$/),
        gotrue_action_link: 'http://auth.eve.lvh.me/verify?token=raw-magic-otp',
        project_id: 'proj_123',
        kind: 'magic_link',
        email_hash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/),
        expires_at: expect.any(Date),
      }));
      const sendCall = (mailerService.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.html).toContain('http://sso.eve.lvh.me/m/mlw_');
      expect(sendCall.html).not.toContain('auth.eve.lvh.me/verify');
      expect(sendCall.text).toContain('http://sso.eve.lvh.me/m/mlw_');
    });

    it('writes a wrap row and puts the wrap URL into the project-invite email', async () => {
      const appAuthPolicy = {
        assertCanInvite: vi.fn().mockResolvedValue(undefined),
      };
      service = buildService(appAuthPolicy);
      vi.spyOn(magicLink, 'generateInviteLink')
        .mockResolvedValue('http://auth.eve.lvh.me/verify?token=raw-invite-otp');

      mocks.users.findByEmail.mockResolvedValue(null);

      await service.createAppInvite({
        project_id: 'proj_123',
        org_id: 'org_customer',
        email: 'invitee@example.com',
        redirect_to: 'http://app.example.com/',
        resend: false,
      }, { user_id: 'user_admin' });

      expect(mocks.magicLinkWraps.create).toHaveBeenCalledWith(expect.objectContaining({
        gotrue_action_link: 'http://auth.eve.lvh.me/verify?token=raw-invite-otp',
        project_id: 'proj_123',
        org_id: 'org_customer',
        kind: 'invite',
      }));
      const sendCall = (mailerService.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.html).toContain('http://sso.eve.lvh.me/m/mlw_');
      expect(sendCall.html).not.toContain('auth.eve.lvh.me/verify');
    });

    it('generateWrappedInviteLink wraps a raw invite link', async () => {
      vi.spyOn(magicLink, 'generateInviteLink')
        .mockResolvedValue('http://auth.eve.lvh.me/verify?token=raw-invite');

      const wrapped = await service.generateWrappedInviteLink({
        email: 'admin@example.com',
        redirectTo: null,
        projectId: null,
        orgId: null,
      });

      expect(wrapped).toMatch(/^http:\/\/sso\.eve\.lvh\.me\/m\/mlw_[a-z0-9]{26}$/);
      expect(mocks.magicLinkWraps.create).toHaveBeenCalledWith(expect.objectContaining({
        gotrue_action_link: 'http://auth.eve.lvh.me/verify?token=raw-invite',
        project_id: null,
        org_id: null,
        kind: 'invite',
      }));
    });

    it('wrapActionLink rejects a magic_link wrap without project_id', async () => {
      await expect(service.wrapActionLink({
        gotrueActionLink: 'http://auth.eve.lvh.me/verify?token=x',
        kind: 'magic_link',
        email: 'user@example.com',
        projectId: null,
      })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('consumeMagicLinkWrap forwards expired/already_consumed/unknown status from the query layer', async () => {
      mocks.magicLinkWraps.consume.mockResolvedValueOnce({ status: 'expired' });
      await expect(service.consumeMagicLinkWrap('mlw_test')).resolves.toEqual({ status: 'expired' });

      mocks.magicLinkWraps.consume.mockResolvedValueOnce({ status: 'already_consumed' });
      await expect(service.consumeMagicLinkWrap('mlw_test')).resolves.toEqual({ status: 'already_consumed' });

      mocks.magicLinkWraps.consume.mockResolvedValueOnce({ status: 'unknown' });
      await expect(service.consumeMagicLinkWrap('mlw_test')).resolves.toEqual({ status: 'unknown' });
    });

    it('consumeMagicLinkWrap returns the stored GoTrue link on success', async () => {
      mocks.magicLinkWraps.consume.mockResolvedValueOnce({
        status: 'ok',
        gotrue_action_link: 'http://auth.eve.lvh.me/verify?token=hidden',
        project_id: 'proj_123',
        org_id: null,
        email_hash: 'sha256:abc123def456',
        kind: 'magic_link',
        get_count: 3,
        created_at: new Date(Date.now() - 5_000),
      });

      const result = await service.consumeMagicLinkWrap('mlw_test');
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.gotrue_action_link).toBe('http://auth.eve.lvh.me/verify?token=hidden');
        expect(result.kind).toBe('magic_link');
        expect(result.project_id).toBe('proj_123');
        expect(result.get_count).toBe(3);
        expect(result.latency_ms).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it('does not create or email unknown users when self-signup is disabled', async () => {
    const generate = vi.spyOn(magicLink, 'generateAuthActionLink');

    await expect(service.sendAppMagicLink({
      email: 'unknown@example.com',
      project_id: 'proj_123',
    })).resolves.toEqual({ sent: true });

    expect(generate).not.toHaveBeenCalled();
    expect(mailerService.send).not.toHaveBeenCalled();
  });

  it('allows unknown emails when self-signup is explicitly enabled', async () => {
    mocks.projects.findById.mockResolvedValue({
      id: 'proj_123',
      org_id: 'org_123',
      branding: null,
      auth_config: {
        login_method: 'magic_link',
        self_signup: true,
        invite_requires_password: false,
      },
    });
    const generate = vi.spyOn(magicLink, 'generateAuthActionLink')
      .mockResolvedValue('http://auth.eve.lvh.me/verify?token=magic');

    await expect(service.sendAppMagicLink({
      email: 'unknown@example.com',
      project_id: 'proj_123',
    })).resolves.toEqual({ sent: true });

    expect(generate).toHaveBeenCalledWith(
      'magiclink',
      'unknown@example.com',
      'http://sso.eve.lvh.me/?project_id=proj_123',
    );
    expect(mailerService.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'unknown@example.com',
      subject: 'Sign in to Eve Horizon',
    }));
  });

  it('allows app-scoped magic links when password and magic-link login are both enabled', async () => {
    mocks.projects.findById.mockResolvedValue({
      id: 'proj_123',
      org_id: 'org_123',
      branding: null,
      auth_config: {
        login_method: 'password_or_magic_link',
        self_signup: false,
        invite_requires_password: true,
      },
    });
    mocks.users.findByEmail.mockResolvedValue({ id: 'user_123', email: 'user@example.com' });
    mocks.memberships.findProjectMembership.mockResolvedValue({ id: 'pmem_123' });
    const generate = vi.spyOn(magicLink, 'generateAuthActionLink')
      .mockResolvedValue('http://auth.eve.lvh.me/verify?token=magic');

    await expect(service.sendAppMagicLink({
      email: 'user@example.com',
      project_id: 'proj_123',
    })).resolves.toEqual({ sent: true });

    expect(generate).toHaveBeenCalledWith(
      'magiclink',
      'user@example.com',
      'http://sso.eve.lvh.me/?project_id=proj_123',
    );
    expect(mailerService.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@example.com',
      subject: 'Sign in to Eve Horizon',
    }));
  });

  it('does not send a generic magic login when a matching project invite is pending', async () => {
    mocks.orgInvites.findPendingByIdentityHintForOrgs.mockResolvedValue([
      { app_context: { project_id: 'proj_123' } },
    ]);
    const generate = vi.spyOn(magicLink, 'generateAuthActionLink');

    await expect(service.sendAppMagicLink({
      email: 'invitee@example.com',
      project_id: 'proj_123',
    })).resolves.toEqual({ sent: true });

    expect(generate).not.toHaveBeenCalled();
    expect(mailerService.send).not.toHaveBeenCalled();
  });

  it('rejects app-scoped magic-link requests for password-only projects', async () => {
    mocks.projects.findById.mockResolvedValue({
      id: 'proj_123',
      org_id: 'org_123',
      branding: null,
      auth_config: {
        login_method: 'password',
        self_signup: false,
        invite_requires_password: true,
      },
    });

    await expect(service.sendAppMagicLink({
      email: 'user@example.com',
      project_id: 'proj_123',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates app-scoped member invites with project-branded email', async () => {
    const appAuthPolicy = {
      assertCanInvite: vi.fn().mockResolvedValue(undefined),
    };
    service = buildService(appAuthPolicy);
    const generate = vi.spyOn(magicLink, 'generateInviteLink')
      .mockResolvedValue('http://auth.eve.lvh.me/verify?token=invite');

    await expect(service.createAppInvite({
      project_id: 'proj_123',
      org_id: 'org_customer',
      email: 'Invitee@Example.com',
      redirect_to: 'http://app.example.com/',
      resend: false,
    }, { user_id: 'user_admin' })).resolves.toEqual({
      status: 'invited',
      org_id: 'org_customer',
      email: 'invitee@example.com',
      role: 'member',
      invite_id: 'invite_123',
    });

    expect(appAuthPolicy.assertCanInvite).toHaveBeenCalledWith('proj_123', 'org_customer', 'user_admin');
    expect(mocks.orgInvites.create).toHaveBeenCalledWith(expect.objectContaining({
      org_id: 'org_customer',
      created_by: 'user_admin',
      provider_hint: 'supabase',
      identity_hint: 'invitee@example.com',
      role: 'member',
      redirect_to: 'http://app.example.com/',
      app_context: {
        project_id: 'proj_123',
        org_id: 'org_customer',
      },
    }));
    expect(generate).toHaveBeenCalledWith(
      'invitee@example.com',
      'http://sso.eve.lvh.me/?project_id=proj_123&redirect_to=http%3A%2F%2Fapp.example.com%2F',
    );
    expect(mailerService.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'invitee@example.com',
      fromName: 'ACME Portal',
      subject: expect.stringContaining('ACME Portal'),
    }));
  });

  it('preserves {sent:true} when SES suppression drops the magic-link email', async () => {
    mocks.users.findByEmail.mockResolvedValue({ id: 'user_123', email: 'admin@example.com' });
    mocks.memberships.findOrgMembership.mockResolvedValue({ id: 'mem_123' });
    vi.spyOn(magicLink, 'generateAuthActionLink')
      .mockResolvedValue('http://auth.eve.lvh.me/verify?token=magic');
    (mailerService.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new EmailSuppressedError('admin@example.com', 'BOUNCE', '2026-05-11T09:28:17.364Z'),
    );

    await expect(service.sendAppMagicLink({
      email: 'admin@example.com',
      project_id: 'proj_123',
    })).resolves.toEqual({ sent: true });

    expect(mailerService.send).toHaveBeenCalledTimes(1);
  });

  describe('domain_signup Path C (v2 rule list)', () => {
    const domainSignupProject = {
      id: 'proj_123',
      org_id: 'org_123',
      branding: {
        app_name: 'ACME Portal',
        primary_color: '#1f6feb',
        email_from_name: 'ACME Portal',
      },
      auth_config: {
        login_method: 'magic_link',
        self_signup: false,
        invite_requires_password: false,
        org_access: {
          mode: 'allowlist',
          allowed_orgs: ['org_acme', 'org_partner'],
          invite: { enabled: false },
          domain_signup: {
            enabled: true,
            domains: [
              { domain: 'acme.com', target_org: 'org_acme', role: 'member' },
              { domain: '*.acme.com', target_org: 'org_acme', role: 'member' },
              { domain: 'partner.example', target_org: 'org_partner', role: 'member' },
            ],
          },
        },
      },
    };

    let appAuthPolicy: { getAllowedOrgIds: ReturnType<typeof vi.fn>; resolveDomainSignup: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      appAuthPolicy = {
        getAllowedOrgIds: vi.fn().mockResolvedValue(['org_acme', 'org_partner']),
        resolveDomainSignup: vi.fn().mockResolvedValue([
          { domain: 'acme.com', target_org: 'org_acme', role: 'member' },
          { domain: '*.acme.com', target_org: 'org_acme', role: 'member' },
          { domain: 'partner.example', target_org: 'org_partner', role: 'member' },
        ]),
      };
      service = buildService(appAuthPolicy);
      mocks.projects.findById.mockResolvedValue(domainSignupProject);
    });

    it('writes a system invite tagged with the matched rule and target_org', async () => {
      const generate = vi.spyOn(magicLink, 'generateAuthActionLink')
        .mockResolvedValue('http://auth.eve.lvh.me/verify?token=magic');

      await expect(service.sendAppMagicLink({
        email: 'Someone@ACME.com',
        project_id: 'proj_123',
      })).resolves.toEqual({ sent: true });

      expect(mocks.orgInvites.create).toHaveBeenCalledWith(expect.objectContaining({
        org_id: 'org_acme',
        created_by: null,
        provider_hint: 'supabase',
        identity_hint: 'someone@acme.com',
        role: 'member',
        app_context: expect.objectContaining({
          project_id: 'proj_123',
          org_id: 'org_acme',
          source: 'domain_signup',
          matched_domain: 'acme.com',
          matched_rule: 'acme.com',
        }),
      }));
      expect(generate).toHaveBeenCalled();
      expect(mailerService.send).toHaveBeenCalled();
    });

    it('routes a different domain to its own target_org', async () => {
      vi.spyOn(magicLink, 'generateAuthActionLink')
        .mockResolvedValue('http://auth.eve.lvh.me/verify?token=magic');

      await expect(service.sendAppMagicLink({
        email: 'buyer@partner.example',
        project_id: 'proj_123',
      })).resolves.toEqual({ sent: true });

      expect(mocks.orgInvites.create).toHaveBeenCalledWith(expect.objectContaining({
        org_id: 'org_partner',
        app_context: expect.objectContaining({
          org_id: 'org_partner',
          matched_rule: 'partner.example',
        }),
      }));
    });

    it('matches wildcard subdomain rule', async () => {
      vi.spyOn(magicLink, 'generateAuthActionLink')
        .mockResolvedValue('http://auth.eve.lvh.me/verify?token=magic');

      await expect(service.sendAppMagicLink({
        email: 'someone@eu.acme.com',
        project_id: 'proj_123',
      })).resolves.toEqual({ sent: true });

      expect(mocks.orgInvites.create).toHaveBeenCalledWith(expect.objectContaining({
        org_id: 'org_acme',
        app_context: expect.objectContaining({
          matched_rule: '*.acme.com',
        }),
      }));
    });

    it('first-match wins when an apex appears before a wildcard', async () => {
      // Reverse default order: apex first, then a broader wildcard pointing
      // to a different org. eu.acme.com should hit the wildcard (apex
      // doesn't match eu.acme.com), confirming we iterate the declared list.
      appAuthPolicy.resolveDomainSignup.mockResolvedValue([
        { domain: 'acme.com', target_org: 'org_acme', role: 'member' },
        { domain: '*.acme.com', target_org: 'org_partner', role: 'member' },
      ]);
      vi.spyOn(magicLink, 'generateAuthActionLink')
        .mockResolvedValue('http://auth.eve.lvh.me/verify?token=magic');

      await expect(service.sendAppMagicLink({
        email: 'user@eu.acme.com',
        project_id: 'proj_123',
      })).resolves.toEqual({ sent: true });

      expect(mocks.orgInvites.create).toHaveBeenCalledWith(expect.objectContaining({
        org_id: 'org_partner',
        app_context: expect.objectContaining({
          matched_rule: '*.acme.com',
        }),
      }));
    });

    it('returns generic success without writing invite for non-matching domain', async () => {
      const generate = vi.spyOn(magicLink, 'generateAuthActionLink');

      await expect(service.sendAppMagicLink({
        email: 'attacker@evil.example',
        project_id: 'proj_123',
      })).resolves.toEqual({ sent: true });

      expect(mocks.orgInvites.create).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(mailerService.send).not.toHaveBeenCalled();
    });

    it('reuses an existing pending domain_signup invite (idempotent re-request)', async () => {
      mocks.orgInvites.findPendingByIdentityHintForOrgs.mockResolvedValue([
        {
          id: 'invite_existing',
          org_id: 'org_acme',
          app_context: {
            project_id: 'proj_123',
            org_id: 'org_acme',
            source: 'domain_signup',
          },
        },
      ]);
      vi.spyOn(magicLink, 'generateAuthActionLink')
        .mockResolvedValue('http://auth.eve.lvh.me/verify?token=magic');

      await expect(service.sendAppMagicLink({
        email: 'someone@acme.com',
        project_id: 'proj_123',
      })).resolves.toEqual({ sent: true });

      expect(mocks.orgInvites.create).not.toHaveBeenCalled();
      expect(mailerService.send).toHaveBeenCalledTimes(1);
    });

    it('lets explicit pending invites win over domain_signup', async () => {
      mocks.orgInvites.findPendingByIdentityHintForOrgs.mockResolvedValue([
        {
          id: 'invite_explicit',
          org_id: 'org_acme',
          app_context: {
            project_id: 'proj_123',
            org_id: 'org_acme',
          },
        },
      ]);
      const generate = vi.spyOn(magicLink, 'generateAuthActionLink');

      await expect(service.sendAppMagicLink({
        email: 'someone@acme.com',
        project_id: 'proj_123',
      })).resolves.toEqual({ sent: true });

      expect(mocks.orgInvites.create).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(mailerService.send).not.toHaveBeenCalled();
    });

    it('skips Path C and falls through when resolveDomainSignup returns null', async () => {
      appAuthPolicy.resolveDomainSignup.mockResolvedValue(null);
      const generate = vi.spyOn(magicLink, 'generateAuthActionLink');

      await expect(service.sendAppMagicLink({
        email: 'someone@acme.com',
        project_id: 'proj_123',
      })).resolves.toEqual({ sent: true });

      expect(mocks.orgInvites.create).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(mailerService.send).not.toHaveBeenCalled();
    });
  });

  it('does not create an app invite when the email is already a target-org member', async () => {
    const appAuthPolicy = {
      assertCanInvite: vi.fn().mockResolvedValue(undefined),
    };
    service = buildService(appAuthPolicy);
    mocks.users.findByEmail.mockResolvedValue({ id: 'user_existing', email: 'member@example.com' });
    mocks.memberships.findOrgMembership.mockResolvedValue({ id: 'mem_existing' });
    const generate = vi.spyOn(magicLink, 'generateInviteLink');

    await expect(service.createAppInvite({
      project_id: 'proj_123',
      org_id: 'org_customer',
      email: 'member@example.com',
      resend: false,
    }, { user_id: 'user_admin' })).resolves.toEqual({
      status: 'already_member',
      org_id: 'org_customer',
      email: 'member@example.com',
      role: 'member',
    });

    expect(mocks.orgInvites.create).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(mailerService.send).not.toHaveBeenCalled();
  });
});
