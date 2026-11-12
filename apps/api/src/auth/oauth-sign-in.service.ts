import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import {
  generateIdentityId,
  loadConfig,
  type AuthExchangeResponse,
  type OAuthSignInExchangeRequest,
} from '@eve/shared';
import { identityQueries, userQueries, type Db, type User } from '@eve/db';
import { AppAuthPolicyService } from './app-auth-policy.service.js';
import { AppAuthService } from './app-auth.service.js';

type GoTrueIdentity = {
  provider?: unknown;
  identity_data?: unknown;
};

type VerifiedGoogleUser = {
  id: string;
  email: string;
};

const GOTRUE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * App-scoped Google sign-in for existing Eve members. This deliberately does
 * not use TokenVerifierService because its legacy Supabase exchange path can
 * apply invitations or provision users.
 */
@Injectable()
export class OAuthSignInService {
  private readonly identities: ReturnType<typeof identityQueries>;
  private readonly users: ReturnType<typeof userQueries>;
  private readonly supabaseAuthUrl?: string;

  constructor(
    @Inject('DB') db: Db,
    private readonly appAuthPolicy: AppAuthPolicyService,
    private readonly appAuth: AppAuthService,
  ) {
    this.identities = identityQueries(db);
    this.users = userQueries(db);
    this.supabaseAuthUrl = loadConfig().SUPABASE_AUTH_URL;
  }

  async exchange(token: string, request: OAuthSignInExchangeRequest): Promise<AuthExchangeResponse> {
    await this.assertGoogleEnabled(request.project_id);
    const googleUser = await this.fetchVerifiedGoogleUser(token);

    const existingIdentity = await this.identities.findByFingerprint('supabase', googleUser.id);
    let user: User;
    let needsLink = false;

    if (existingIdentity) {
      // A stale link is never eligible for email fallback: that could reassign
      // a GoTrue account after an incomplete or corrupt prior operation.
      const linkedUser = await this.users.findById(existingIdentity.user_id);
      if (!linkedUser) {
        throw new UnauthorizedException('Google account is not eligible for this app');
      }
      user = linkedUser;
    } else {
      const emailUser = await this.users.findByEmail(googleUser.email);
      if (!emailUser) {
        throw new UnauthorizedException('Google account is not eligible for this app');
      }
      user = emailUser;
      needsLink = true;
    }

    await this.assertCurrentAppAccess(request.project_id, user.id);

    if (needsLink) {
      await this.linkSupabaseIdentity(googleUser.id, user.id);
    }

    // The policy and membership can change during an asynchronous identity
    // creation. Re-evaluate immediately before issuing an Eve credential.
    await this.assertGoogleEnabled(request.project_id);
    await this.assertCurrentAppAccess(request.project_id, user.id);

    const minted = await this.appAuth.mintUserToken(user.id, user.email);
    return {
      access_token: minted.access_token,
      token_type: minted.token_type,
      expires_at: minted.expires_at,
      user_id: user.id,
    };
  }

  private async assertGoogleEnabled(projectId: string): Promise<void> {
    const { auth } = await this.appAuthPolicy.getProjectPolicy(projectId);
    if (!auth.oauth_providers.includes('google')) {
      throw new ForbiddenException('Google sign-in is not enabled for this app');
    }
  }

  private async assertCurrentAppAccess(projectId: string, userId: string): Promise<void> {
    const access = await this.appAuthPolicy.getUserAppAccess(projectId, userId);
    if (!access.orgs.some((org) => org.capabilities.enter_app)) {
      throw new ForbiddenException('User does not have access to this app');
    }
  }

  private async fetchVerifiedGoogleUser(token: string): Promise<VerifiedGoogleUser> {
    if (!this.supabaseAuthUrl) {
      throw new ServiceUnavailableException('Google sign-in is unavailable');
    }

    let response: Response;
    try {
      const authBase = this.supabaseAuthUrl.endsWith('/')
        ? this.supabaseAuthUrl
        : `${this.supabaseAuthUrl}/`;
      // Resolve a relative endpoint so deployments with a GoTrue base path
      // (for example, /auth/v1/) retain that configured prefix.
      response = await fetch(new URL('user', authBase), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
    } catch {
      throw new ServiceUnavailableException('Google sign-in is unavailable');
    }

    if (!response.ok) {
      throw new UnauthorizedException('Google session is invalid');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new UnauthorizedException('Google session is invalid');
    }
    return this.parseVerifiedGoogleUser(payload);
  }

  private parseVerifiedGoogleUser(payload: unknown): VerifiedGoogleUser {
    if (
      !isRecord(payload)
      || typeof payload.id !== 'string'
      || !GOTRUE_UUID_PATTERN.test(payload.id)
      || typeof payload.email !== 'string'
      || payload.email.length === 0
      || payload.email.length > 320
      || payload.email !== payload.email.trim()
      || !EMAIL_PATTERN.test(payload.email)
      || typeof payload.email_confirmed_at !== 'string'
      || !payload.email_confirmed_at
      || Number.isNaN(Date.parse(payload.email_confirmed_at))
    ) {
      throw new UnauthorizedException('Google session is invalid');
    }

    const normalizedEmail = payload.email.trim().toLowerCase();
    if (!Array.isArray(payload.identities)) {
      throw new UnauthorizedException('Google session is invalid');
    }

    const googleIdentity = payload.identities.find((identity): identity is GoTrueIdentity => (
      isRecord(identity) && identity.provider === 'google'
    ));
    const identityData = googleIdentity?.identity_data;
    if (!googleIdentity || !isRecord(identityData)) {
      throw new UnauthorizedException('Google session is invalid');
    }
    const identityEmail = identityData.email;
    if (
      identityData.email_verified !== true
      || typeof identityEmail !== 'string'
      || identityEmail.length === 0
      || identityEmail.length > 320
      || identityEmail.trim().toLowerCase() !== normalizedEmail
    ) {
      throw new UnauthorizedException('Google session is invalid');
    }

    return { id: payload.id, email: normalizedEmail };
  }

  private async linkSupabaseIdentity(supabaseUuid: string, userId: string): Promise<void> {
    try {
      await this.identities.create({
        id: generateIdentityId(),
        user_id: userId,
        provider: 'supabase',
        public_key: supabaseUuid,
        fingerprint: supabaseUuid,
        label: 'supabase-google-linked',
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const linked = await this.identities.findByFingerprint('supabase', supabaseUuid);
      if (!linked || linked.user_id !== userId) {
        throw new UnauthorizedException('Google account is not eligible for this app');
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === '23505';
}
