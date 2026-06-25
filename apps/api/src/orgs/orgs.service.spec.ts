import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { OrgsService } from './orgs.service';
import type { AuthService } from '../auth/auth.service';
import type { MailerService } from '../mailer/mailer.service';

const mocks = vi.hoisted(() => ({
  projectQueries: {
    findById: vi.fn(),
  },
  orgInviteQueries: {
    create: vi.fn(),
  },
}));

vi.mock('@eve/db', () => ({
  orgQueries: vi.fn(() => ({})),
  membershipQueries: vi.fn(() => ({})),
  userQueries: vi.fn(() => ({})),
  agentQueries: vi.fn(() => ({})),
  spendQueries: vi.fn(() => ({})),
  projectQueries: vi.fn(() => mocks.projectQueries),
  environmentQueries: vi.fn(() => ({})),
  orgInviteQueries: vi.fn(() => mocks.orgInviteQueries),
}));

function makeInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite_123',
    org_id: 'org_123',
    created_by: 'user_admin',
    invite_code: 'code_123',
    provider_hint: 'supabase',
    identity_hint: 'invitee@example.com',
    role: 'member',
    redirect_to: 'http://app.example.com',
    app_context: null,
    expires_at: new Date('2026-05-10T12:00:00.000Z'),
    used_at: null,
    created_at: new Date('2026-05-09T12:00:00.000Z'),
    ...overrides,
  };
}

describe('OrgsService createOrgInvite branded emails', () => {
  let service: OrgsService;
  let authService: Pick<AuthService, 'generateInviteLink' | 'generateWrappedInviteLink'>;
  let mailerService: Pick<MailerService, 'send'>;

  beforeEach(() => {
    vi.clearAllMocks();
    authService = {
      generateInviteLink: vi.fn().mockResolvedValue('http://auth.eve.lvh.me/verify?token=abc'),
      generateWrappedInviteLink: vi.fn().mockResolvedValue('http://sso.eve.lvh.me/m/mlw_test1234567890'),
    };
    mailerService = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    mocks.orgInviteQueries.create.mockImplementation(async (input: Record<string, unknown>) => makeInvite({
      identity_hint: input.identity_hint,
      role: input.role,
      redirect_to: input.redirect_to,
      app_context: input.app_context,
      expires_at: input.expires_at,
    }));
    service = new OrgsService(
      {} as never,
      authService as AuthService,
      mailerService as MailerService,
    );
  });

  it('sends project-branded invite email and stores project context', async () => {
    mocks.projectQueries.findById.mockResolvedValue({
      id: 'proj_123',
      org_id: 'org_123',
      branding: {
        app_name: 'ACME Portal',
        primary_color: '#1f6feb',
        email_from_name: 'ACME Portal',
      },
    });

    const response = await service.createOrgInvite('org_123', 'user_admin', {
      email: 'invitee@example.com',
      redirect_to: 'http://app.example.com',
      project_id: 'proj_123',
    });

    expect(response.app_context).toEqual({ project_id: 'proj_123' });
    expect(authService.generateWrappedInviteLink).toHaveBeenCalledWith({
      email: 'invitee@example.com',
      redirectTo: 'http://sso.eve.lvh.me/?project_id=proj_123&redirect_to=http%3A%2F%2Fapp.example.com',
      projectId: 'proj_123',
      orgId: 'org_123',
    });
    const sendCall = (mailerService.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sendCall.to).toBe('invitee@example.com');
    expect(sendCall.fromName).toBe('ACME Portal');
    expect(sendCall.subject).toBe('You have been invited to ACME Portal');
    expect(sendCall.html).toContain('http://sso.eve.lvh.me/m/mlw_test1234567890');
    expect(sendCall.html).not.toContain('auth.eve.lvh.me/verify');
  });

  it('falls back to Eve Horizon branding without project_id', async () => {
    await service.createOrgInvite('org_123', 'user_admin', {
      email: 'invitee@example.com',
    });

    expect(mocks.projectQueries.findById).not.toHaveBeenCalled();
    expect(mailerService.send).toHaveBeenCalledWith(expect.objectContaining({
      fromName: 'Eve Horizon',
      subject: 'You have been invited to Eve Horizon',
    }));
  });

  it('rejects a project from another org without sending email', async () => {
    mocks.projectQueries.findById.mockResolvedValue({
      id: 'proj_other',
      org_id: 'org_other',
      branding: {
        app_name: 'Other App',
      },
    });

    await expect(service.createOrgInvite('org_123', 'user_admin', {
      email: 'invitee@example.com',
      project_id: 'proj_other',
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(mocks.orgInviteQueries.create).not.toHaveBeenCalled();
    expect(authService.generateWrappedInviteLink).not.toHaveBeenCalled();
    expect(mailerService.send).not.toHaveBeenCalled();
  });
});
