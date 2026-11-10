import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { TokenVerifierService } from './token-verifier.service';
import type { AppAuthService } from './app-auth.service';
import type { MagicLinkService } from './magic-link.service';

const SUPABASE_SECRET = 'test-supabase-jwt-secret';
const GOTRUE_ID = '6f1c1f9e-0a43-4b8e-9d55-1c2b3a4d5e6f';
const OTHER_GOTRUE_ID = '0b7e2d4c-91aa-4f3c-8e21-7d6c5b4a3f2e';

const mocks = vi.hoisted(() => ({
  users: {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    create: vi.fn(),
  },
  identities: {
    findByFingerprint: vi.fn(),
    listByUserAndProvider: vi.fn(),
    create: vi.fn(),
  },
  memberships: {
    listOrgMembershipsForUser: vi.fn(),
    upsertOrgMembership: vi.fn(),
  },
  orgInvites: {
    findByIdentityHint: vi.fn(),
    markUsed: vi.fn(),
  },
}));

vi.mock('@eve/db', () => ({
  userQueries: vi.fn(() => mocks.users),
  identityQueries: vi.fn(() => mocks.identities),
  membershipQueries: vi.fn(() => mocks.memberships),
  orgInviteQueries: vi.fn(() => mocks.orgInvites),
}));

function base64url(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Build a GoTrue-shaped HS256 access token. */
function gotrueToken(claims: Record<string, unknown>): string {
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url({
    aud: 'authenticated',
    role: 'authenticated',
    iat: now,
    exp: now + 3600,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    ...claims,
  });
  const signature = createHmac('sha256', SUPABASE_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function signedInWith(method: string | null, extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return gotrueToken({
    sub: GOTRUE_ID,
    email: 'admin@example.com',
    phone: '',
    ...(method ? { amr: [{ method, timestamp: now }] } : {}),
    ...extra,
  });
}

const existingUser = {
  id: 'user_existing',
  email: 'admin@example.com',
  is_admin: true,
  display_name: null,
};

const pendingInvite = {
  id: 'oinv_pending',
  org_id: 'org_target',
  role: 'member',
  used_at: null,
  expires_at: null,
  redirect_to: null,
  app_context: null,
};

describe('TokenVerifierService GoTrue identity linking', () => {
  let verifier: TokenVerifierService;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'false';
    process.env.SUPABASE_JWT_SECRET = SUPABASE_SECRET;

    mocks.identities.findByFingerprint.mockResolvedValue(null);
    mocks.identities.listByUserAndProvider.mockResolvedValue([]);
    mocks.identities.create.mockImplementation(async (identity) => identity);
    mocks.users.findById.mockResolvedValue(null);
    mocks.users.findByEmail.mockResolvedValue(null);
    mocks.users.create.mockImplementation(async (user) => user);
    mocks.memberships.listOrgMembershipsForUser.mockResolvedValue([]);
    mocks.memberships.upsertOrgMembership.mockResolvedValue(undefined);
    mocks.orgInvites.findByIdentityHint.mockResolvedValue(null);
    mocks.orgInvites.markUsed.mockResolvedValue(undefined);

    const db = vi.fn(async () => []);
    const magicLink = { emitDomainSignupEvent: vi.fn() } as unknown as MagicLinkService;
    verifier = new TokenVerifierService(db as never, {} as AppAuthService, magicLink);
  });

  describe('first sign-in for an existing Eve user', () => {
    beforeEach(() => {
      mocks.users.findByEmail.mockResolvedValue(existingUser);
    });

    it.each([
      ['a password sign-in', 'password'],
      ['a token without sign-in methods', null],
      ['an anonymous session', 'anonymous'],
    ])('refuses %s and writes no link', async (_label, method) => {
      await expect(
        verifier.resolveSupabaseTokenForExchange(signedInWith(method)),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(mocks.identities.create).not.toHaveBeenCalled();
      expect(mocks.users.create).not.toHaveBeenCalled();
      expect(mocks.memberships.upsertOrgMembership).not.toHaveBeenCalled();
    });

    it('refuses a one-time code sign-in when the account also has a phone number', async () => {
      const token = signedInWith('otp', { phone: '447700900123' });

      await expect(verifier.resolveSupabaseTokenForExchange(token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mocks.identities.create).not.toHaveBeenCalled();
    });

    it.each(['otp', 'magiclink', 'invite', 'recovery', 'email/signup'])(
      'links an email-proven sign-in (%s)',
      async (method) => {
        const authUser = await verifier.resolveSupabaseTokenForExchange(signedInWith(method));

        expect(authUser.user_id).toBe(existingUser.id);
        expect(mocks.identities.create).toHaveBeenCalledWith(
          expect.objectContaining({
            user_id: existingUser.id,
            provider: 'supabase',
            fingerprint: GOTRUE_ID,
          }),
        );
      },
    );

    it('does not re-link a user already linked to another GoTrue account', async () => {
      mocks.identities.listByUserAndProvider.mockResolvedValue([
        {
          id: 'ident_other',
          user_id: existingUser.id,
          provider: 'supabase',
          public_key: OTHER_GOTRUE_ID,
          fingerprint: OTHER_GOTRUE_ID,
          label: 'supabase-auto-linked',
        },
      ]);

      await expect(
        verifier.resolveSupabaseTokenForExchange(signedInWith('otp')),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(mocks.identities.create).not.toHaveBeenCalled();
    });

    it('refuses a password sign-in on the Authorization header path too', async () => {
      process.env.EVE_AUTH_ENABLED = 'true';
      const db = vi.fn(async () => []);
      const magicLink = { emitDomainSignupEvent: vi.fn() } as unknown as MagicLinkService;
      const enabled = new TokenVerifierService(db as never, {} as AppAuthService, magicLink);

      await expect(
        enabled.verifyAuthorizationHeader(`Bearer ${signedInWith('password')}`),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.identities.create).not.toHaveBeenCalled();
    });
  });

  describe('pending org invites', () => {
    beforeEach(() => {
      mocks.orgInvites.findByIdentityHint.mockResolvedValue(pendingInvite);
    });

    it('are not applied for a password sign-in of a new account', async () => {
      const authUser = await verifier.resolveSupabaseTokenForExchange(signedInWith('password'));

      expect(authUser.invite_org_id).toBeUndefined();
      expect(mocks.memberships.upsertOrgMembership).not.toHaveBeenCalled();
      expect(mocks.orgInvites.markUsed).not.toHaveBeenCalled();
    });

    it('are not applied for a password sign-in of an already linked account', async () => {
      mocks.identities.findByFingerprint.mockResolvedValue({
        id: 'ident_linked',
        user_id: existingUser.id,
        provider: 'supabase',
        public_key: GOTRUE_ID,
        fingerprint: GOTRUE_ID,
        label: 'supabase-auto-linked',
      });
      mocks.users.findById.mockResolvedValue(existingUser);

      const authUser = await verifier.resolveSupabaseTokenForExchange(signedInWith('password'));

      expect(authUser.user_id).toBe(existingUser.id);
      expect(mocks.memberships.upsertOrgMembership).not.toHaveBeenCalled();
      expect(mocks.orgInvites.markUsed).not.toHaveBeenCalled();
    });

    it('are applied for an invite-link sign-in of a new account', async () => {
      const authUser = await verifier.resolveSupabaseTokenForExchange(signedInWith('otp'));

      expect(authUser.invite_org_id).toBe(pendingInvite.org_id);
      expect(mocks.memberships.upsertOrgMembership).toHaveBeenCalledWith(
        pendingInvite.org_id,
        authUser.user_id,
        'member',
      );
      expect(mocks.orgInvites.markUsed).toHaveBeenCalledWith(pendingInvite.id, authUser.user_id);
    });

    it('are applied for an email-link sign-in of an already linked account', async () => {
      mocks.identities.findByFingerprint.mockResolvedValue({
        id: 'ident_linked',
        user_id: existingUser.id,
        provider: 'supabase',
        public_key: GOTRUE_ID,
        fingerprint: GOTRUE_ID,
        label: 'supabase-auto-linked',
      });
      mocks.users.findById.mockResolvedValue(existingUser);

      const authUser = await verifier.resolveSupabaseTokenForExchange(signedInWith('otp'));

      expect(authUser.invite_org_id).toBe(pendingInvite.org_id);
      expect(mocks.orgInvites.markUsed).toHaveBeenCalledWith(pendingInvite.id, existingUser.id);
    });
  });

  it('still signs in a linked account with a password', async () => {
    mocks.identities.findByFingerprint.mockResolvedValue({
      id: 'ident_linked',
      user_id: existingUser.id,
      provider: 'supabase',
      public_key: GOTRUE_ID,
      fingerprint: GOTRUE_ID,
      label: 'supabase-auto-linked',
    });
    mocks.users.findById.mockResolvedValue(existingUser);

    const authUser = await verifier.resolveSupabaseTokenForExchange(signedInWith('password'));

    expect(authUser.user_id).toBe(existingUser.id);
    expect(mocks.identities.create).not.toHaveBeenCalled();
  });

  it('still provisions a new Eve user for a new email', async () => {
    const authUser = await verifier.resolveSupabaseTokenForExchange(
      signedInWith('password', { email: 'new.person@example.com' }),
    );

    expect(mocks.users.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new.person@example.com', is_admin: false }),
    );
    expect(mocks.identities.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: authUser.user_id, fingerprint: GOTRUE_ID }),
    );
  });
});
