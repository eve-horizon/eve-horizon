import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { OAuthSignInService } from './oauth-sign-in.service';
import type { AppAuthPolicyService } from './app-auth-policy.service';
import type { AppAuthService } from './app-auth.service';

const mocks = vi.hoisted(() => ({
  identities: {
    findByFingerprint: vi.fn(),
    create: vi.fn(),
  },
  users: {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('@eve/db', () => ({
  identityQueries: vi.fn(() => mocks.identities),
  userQueries: vi.fn(() => mocks.users),
}));

const gotrueId = '550e8400-e29b-41d4-a716-446655440000';
const eveUser = {
  id: 'user_existing',
  email: 'member@example.com',
  display_name: null,
  is_admin: false,
  created_at: new Date(),
  updated_at: new Date(),
};

function validGoTrueUser(overrides: Record<string, unknown> = {}) {
  return {
    id: gotrueId,
    email: 'Member@Example.com',
    email_confirmed_at: '2026-09-09T09:00:00.000Z',
    identities: [{
      provider: 'google',
      identity_data: {
        email: 'member@example.com',
        email_verified: true,
      },
    }],
    ...overrides,
  };
}

function response(payload: unknown, ok = true): Response {
  return { ok, json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
}

describe('OAuthSignInService', () => {
  let policy: Pick<AppAuthPolicyService, 'getProjectPolicy' | 'getUserAppAccess'>;
  let appAuth: Pick<AppAuthService, 'mintUserToken'>;
  let service: OAuthSignInService;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'false';
    process.env.SUPABASE_AUTH_URL = 'http://auth.example.test/auth/v1';
    policy = {
      getProjectPolicy: vi.fn().mockResolvedValue({ auth: { oauth_providers: ['google'] } }),
      getUserAppAccess: vi.fn().mockResolvedValue({
        project_id: 'proj_123',
        orgs: [{ id: 'org_123', capabilities: { enter_app: true } }],
        admin_orgs: [],
      }),
    } as unknown as Pick<AppAuthPolicyService, 'getProjectPolicy' | 'getUserAppAccess'>;
    appAuth = {
      mintUserToken: vi.fn().mockResolvedValue({
        access_token: 'eve-token',
        token_type: 'bearer',
        expires_at: 123,
      }),
    };
    service = new OAuthSignInService({} as never, policy as AppAuthPolicyService, appAuth as AppAuthService);
    mocks.identities.findByFingerprint.mockResolvedValue({ user_id: eveUser.id });
    mocks.users.findById.mockResolvedValue(eveUser);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(validGoTrueUser())));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses an existing identity and preserves the configured GoTrue base path', async () => {
    await expect(service.exchange('gotrue-token', { project_id: 'proj_123', provider: 'google' })).resolves.toEqual({
      access_token: 'eve-token', token_type: 'bearer', expires_at: 123, user_id: eveUser.id,
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://auth.example.test/auth/v1/user'),
      expect.objectContaining({
        headers: { authorization: 'Bearer gotrue-token' },
        redirect: 'error',
      }),
    );
    expect(mocks.users.findByEmail).not.toHaveBeenCalled();
    expect(mocks.identities.create).not.toHaveBeenCalled();
    expect(mocks.users.create).not.toHaveBeenCalled();
  });

  it('links a verified matching email only after app access is granted', async () => {
    mocks.identities.findByFingerprint.mockResolvedValue(null);
    mocks.users.findByEmail.mockResolvedValue(eveUser);
    mocks.identities.create.mockResolvedValue({});

    await service.exchange('gotrue-token', { project_id: 'proj_123', provider: 'google' });

    expect(mocks.users.findByEmail).toHaveBeenCalledWith('member@example.com');
    expect(mocks.identities.create).toHaveBeenCalledWith(expect.objectContaining({
      user_id: eveUser.id,
      provider: 'supabase',
      fingerprint: gotrueId,
    }));
    expect(policy.getUserAppAccess).toHaveBeenCalledTimes(2);
    expect(mocks.users.create).not.toHaveBeenCalled();
  });

  it('denies unknown users without provisioning or invitation side effects', async () => {
    mocks.identities.findByFingerprint.mockResolvedValue(null);
    mocks.users.findByEmail.mockResolvedValue(null);

    await expect(service.exchange('gotrue-token', { project_id: 'proj_123', provider: 'google' }))
      .rejects.toBeInstanceOf(UnauthorizedException);

    expect(mocks.identities.create).not.toHaveBeenCalled();
    expect(mocks.users.create).not.toHaveBeenCalled();
    expect(appAuth.mintUserToken).not.toHaveBeenCalled();
  });

  it('rejects unavailable and malformed GoTrue responses without resolving an Eve account', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(service.exchange('gotrue-token', { project_id: 'proj_123', provider: 'google' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ id: gotrueId })));
    await expect(service.exchange('gotrue-token', { project_id: 'proj_123', provider: 'google' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(mocks.identities.findByFingerprint).not.toHaveBeenCalled();
  });

  it.each([
    ['unconfirmed email', { email_confirmed_at: null }],
    ['unverified identity email', { identities: [{ provider: 'google', identity_data: { email: 'member@example.com', email_verified: false } }] }],
    ['non-google identity', { identities: [{ provider: 'github', identity_data: { email: 'member@example.com', email_verified: true } }] }],
    ['mismatched identity email', { identities: [{ provider: 'google', identity_data: { email: 'other@example.com', email_verified: true } }] }],
  ])('rejects %s before resolving an Eve account', async (_name, overrides) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(validGoTrueUser(overrides))));

    await expect(service.exchange('gotrue-token', { project_id: 'proj_123', provider: 'google' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(mocks.identities.findByFingerprint).not.toHaveBeenCalled();
  });

  it('requires explicit project opt-in before contacting GoTrue', async () => {
    (policy.getProjectPolicy as ReturnType<typeof vi.fn>).mockResolvedValue({ auth: { oauth_providers: [] } });

    await expect(service.exchange('gotrue-token', { project_id: 'proj_123', provider: 'google' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a membership that is revoked before token minting', async () => {
    (policy.getUserAppAccess as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ project_id: 'proj_123', orgs: [{ id: 'org_123', capabilities: { enter_app: true } }], admin_orgs: [] })
      .mockResolvedValueOnce({ project_id: 'proj_123', orgs: [], admin_orgs: [] });

    await expect(service.exchange('gotrue-token', { project_id: 'proj_123', provider: 'google' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(appAuth.mintUserToken).not.toHaveBeenCalled();
  });

  it('denies a user with no current app access before linking', async () => {
    mocks.identities.findByFingerprint.mockResolvedValue(null);
    mocks.users.findByEmail.mockResolvedValue(eveUser);
    (policy.getUserAppAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ project_id: 'proj_123', orgs: [], admin_orgs: [] });

    await expect(service.exchange('gotrue-token', { project_id: 'proj_123', provider: 'google' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(mocks.identities.create).not.toHaveBeenCalled();
    expect(appAuth.mintUserToken).not.toHaveBeenCalled();
  });

  it('handles a concurrent link for the same user but rejects a different owner', async () => {
    mocks.identities.findByFingerprint
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user_id: eveUser.id });
    mocks.users.findByEmail.mockResolvedValue(eveUser);
    mocks.identities.create.mockRejectedValue(Object.assign(new Error('unique'), { code: '23505' }));

    await expect(service.exchange('gotrue-token', { project_id: 'proj_123', provider: 'google' })).resolves.toMatchObject({ user_id: eveUser.id });

    mocks.identities.findByFingerprint
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user_id: 'user_other' });
    await expect(service.exchange('gotrue-token', { project_id: 'proj_123', provider: 'google' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
});
