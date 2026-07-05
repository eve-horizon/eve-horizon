import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Inject,
} from '@nestjs/common';

import {
  loadConfig,
  generateUserId,
  generateIdentityId,
  generateServicePrincipalTokenId,
  type AppAccessResponse,
  type AppInviteRequest,
  type AppInviteResponse,
  type AppAuthContextResponse,
  type AppAuthContextAdminResponse,
  type MagicLinkRequest,
  type MagicLinkResponse,
  type AccessBindingScope,
} from '@eve/shared';
import {
  type Db,
  userQueries,
  identityQueries,
  authChallengeQueries,
  membershipQueries,
  orgInviteQueries,
  servicePrincipalQueries,
  type MagicLinkWrapKind,
  type MembershipRole,
} from '@eve/db';
import type { VerifiedIdentity } from './providers/identity-provider.interface.js';
import { IdentityProviderRegistry } from './providers/index.js';
import { AppAuthPolicyService } from './app-auth-policy.service.js';
import { MagicLinkService } from './magic-link.service.js';
import { AppAuthService } from './app-auth.service.js';
import { TokenVerifierService } from './token-verifier.service.js';
import { BootstrapService } from './bootstrap.service.js';

import type { KeyEntry } from './auth.util.js';
import {
  loadKeyRing,
  createJwtRs256,
  fingerprintPublicKey,
} from './auth.util.js';
import type {
  AuthUser,
  JobTokenPayload,
  ServiceTokenPayload,
  AppLinkTokenPayload,
  BootstrapStatus,
} from './auth.types.js';
export type {
  AuthUser,
  JobTokenPayload,
  ServiceTokenPayload,
  AppLinkTokenPayload,
  BootstrapMode,
  BootstrapStatus,
} from './auth.types.js';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly enabled: boolean;
  /** HS256 secret for verifying Supabase tokens (set when SUPABASE_JWT_SECRET is configured) */
  private readonly supabaseSecret?: string;
  /** True when RS256 key pair is loaded — enables internal token verification and minting */
  private readonly hasInternalKeys: boolean;
  private readonly keys: KeyEntry[];
  private readonly signerKey?: KeyEntry;
  private readonly users: ReturnType<typeof userQueries>;
  private readonly identities: ReturnType<typeof identityQueries>;
  private readonly challenges: ReturnType<typeof authChallengeQueries>;
  private readonly memberships: ReturnType<typeof membershipQueries>;
  private readonly orgInvites: ReturnType<typeof orgInviteQueries>;
  private readonly servicePrincipals: ReturnType<typeof servicePrincipalQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly providerRegistry: IdentityProviderRegistry,
    private readonly magicLink: MagicLinkService,
    private readonly appAuth: AppAuthService,
    private readonly tokenVerifier: TokenVerifierService,
    private readonly bootstrap: BootstrapService,
    private readonly appAuthPolicy?: AppAuthPolicyService,
  ) {
    const config = loadConfig();
    this.enabled = config.EVE_AUTH_ENABLED;

    // Dual-mode: both RS256 and HS256 can be active simultaneously.
    // RS256 (internal) is used for Eve-minted tokens (user, job, service principal).
    // HS256 (Supabase) is used for Supabase-issued tokens (browser auth via GoTrue).
    this.supabaseSecret = config.SUPABASE_JWT_SECRET;
    this.keys = loadKeyRing(config);
    this.signerKey = this.keys.find((key) => key.privateKey);
    this.hasInternalKeys = Boolean(this.signerKey);

    if (this.enabled && !this.hasInternalKeys && !this.supabaseSecret) {
      throw new Error('EVE_AUTH_PRIVATE_KEY or SUPABASE_JWT_SECRET is required when auth is enabled');
    }

    this.users = userQueries(db);
    this.identities = identityQueries(db);
    this.challenges = authChallengeQueries(db);
    this.memberships = membershipQueries(db);
    this.orgInvites = orgInviteQueries(db);
    this.servicePrincipals = servicePrincipalQueries(db);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async verifyAuthorizationHeader(header: string): Promise<AuthUser> {
    return this.tokenVerifier.verifyAuthorizationHeader(header);
  }

  async autoApplyOrgInviteByEmail(
    userId: string,
    email: string,
  ): Promise<{ applied: boolean; org_id?: string; redirect_to?: string; app_context?: Record<string, unknown> | null; error?: string }> {
    return this.tokenVerifier.autoApplyOrgInviteByEmail(userId, email);
  }

  async resolveSupabaseTokenForExchange(token: string): Promise<AuthUser> {
    return this.tokenVerifier.resolveSupabaseTokenForExchange(token);
  }

  verifyServicePrincipalToken(token: string): AuthUser {
    return this.tokenVerifier.verifyServicePrincipalToken(token);
  }

  mintServicePrincipalToken(params: {
    principalId: string;
    orgId: string;
    scopes: string[];
    ttlHours: number;
  }): { tokenId: string; accessToken: string; expiresAt: Date } {
    if (!this.signerKey?.privateKey) {
      throw new Error('Signing key not configured');
    }

    const tokenId = generateServicePrincipalTokenId();
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = params.ttlHours * 60 * 60;
    const exp = now + ttlSeconds;
    const expiresAt = new Date(exp * 1000);

    const jwtPayload: Record<string, unknown> = {
      sub: `sp:${params.principalId}`,
      org_id: params.orgId,
      scopes: params.scopes,
      exp,
      iat: now,
      type: 'service_principal',
    };

    const accessToken = createJwtRs256(jwtPayload, this.signerKey);

    return { tokenId, accessToken, expiresAt };
  }

  getServicePrincipalQueries() {
    return this.servicePrincipals;
  }

  async generateAuthActionLink(
    type: 'invite' | 'magiclink',
    email: string,
    redirectTo?: string,
  ): Promise<string> {
    return this.magicLink.generateAuthActionLink(type, email, redirectTo);
  }

  async generateInviteLink(email: string, redirectTo?: string): Promise<string> {
    return this.magicLink.generateInviteLink(email, redirectTo);
  }

  async wrapActionLink(input: {
    gotrueActionLink: string;
    projectId?: string | null;
    orgId?: string | null;
    email: string;
    kind: MagicLinkWrapKind;
    redirectTo?: string | null;
  }): Promise<string> {
    return this.magicLink.wrapActionLink(input);
  }

  async generateWrappedInviteLink(input: {
    email: string;
    redirectTo?: string | null;
    projectId?: string | null;
    orgId?: string | null;
  }): Promise<string> {
    return this.magicLink.generateWrappedInviteLink(input);
  }

  async consumeMagicLinkWrap(id: string) {
    return this.magicLink.consumeMagicLinkWrap(id);
  }

  async inspectMagicLinkWrap(id: string) {
    return this.magicLink.inspectMagicLinkWrap(id);
  }

  async pruneExpiredMagicLinkWraps(cutoff: Date): Promise<number> {
    return this.magicLink.pruneExpiredMagicLinkWraps(cutoff);
  }

  async getAppAuthContext(projectId: string): Promise<AppAuthContextResponse> {
    return this.appAuth.getAppAuthContext(projectId);
  }

  async getAppAuthContextAdmin(projectId: string): Promise<AppAuthContextAdminResponse> {
    return this.appAuth.getAppAuthContextAdmin(projectId);
  }

  async getAppAccess(projectId: string, userId: string): Promise<AppAccessResponse> {
    if (!this.appAuthPolicy) {
      throw new BadRequestException('App auth policy service is not available');
    }
    return this.appAuthPolicy.getUserAppAccess(projectId, userId);
  }

  async createAppInvite(input: AppInviteRequest, actor: AuthUser): Promise<AppInviteResponse> {
    return this.appAuth.createAppInvite(input, actor);
  }

  async sendAppMagicLink(input: MagicLinkRequest): Promise<MagicLinkResponse> {
    return this.magicLink.sendAppMagicLink(input);
  }

  /**
   * Resolve a user's project-level role. Returns the explicit project membership
   * role, or null if the user has no project membership.
   */
  async resolveProjectRole(
    userId: string,
    projectId: string,
  ): Promise<'owner' | 'admin' | 'member' | null> {
    const membership = await this.memberships.findProjectMembership(userId, projectId);
    return (membership?.role as 'owner' | 'admin' | 'member') ?? null;
  }

  async mintUserToken(userId: string, email?: string, ttlSeconds?: number): Promise<{ access_token: string; token_type: string; expires_at: number }> {
    return this.appAuth.mintUserToken(userId, email, ttlSeconds);
  }

  async mintUserTokenForAdmin(input: {
    email: string;
    org_id?: string;
    project_id?: string;
    role?: MembershipRole;
    ttl_days?: number;
  }): Promise<{
    access_token: string;
    token_type: string;
    expires_at: number;
    user_id: string;
    created: boolean;
    org_id: string;
    project_id: string | null;
    role: MembershipRole;
  }> {
    return this.appAuth.mintUserTokenForAdmin(input);
  }

  mintJobToken(params: {
    userId: string;
    orgId: string | null;
    projectId: string;
    jobId: string;
    permissions: string[];
    scope?: AccessBindingScope;
    ttlSeconds?: number;
    agentSlug?: string;
  }): string {
    if (!this.signerKey?.privateKey) {
      throw new Error('Signing key not configured');
    }

    const now = Math.floor(Date.now() / 1000);
    const maxTtl = 24 * 60 * 60;
    const ttl = Math.min(params.ttlSeconds ?? maxTtl, maxTtl);
    const exp = now + ttl;

    const payload: Record<string, unknown> = {
      sub: params.userId,
      user_id: params.userId,
      org_id: params.orgId,
      project_id: params.projectId,
      job_id: params.jobId,
      permissions: params.permissions,
      exp,
      iat: now,
      type: 'job',
    };

    if (params.scope && Object.keys(params.scope).length > 0) {
      payload.scope = params.scope;
    }

    // Include agent identity when available — gives apps a stable agent identifier
    if (params.agentSlug) {
      payload.agent_slug = params.agentSlug;
      payload.email = `${params.agentSlug}@eve.agent`;
    }

    return createJwtRs256(payload, this.signerKey);
  }

  verifyJobToken(token: string): JobTokenPayload {
    return this.tokenVerifier.verifyJobToken(token);
  }

  mintServiceToken(params: {
    projectId: string;
    orgId: string;
    envName: string;
    serviceName: string;
    permissions: string[];
    ttlSeconds?: number;
  }): string {
    if (!this.signerKey?.privateKey) {
      throw new Error('Signing key not configured');
    }

    const now = Math.floor(Date.now() / 1000);
    const maxTtl = 90 * 24 * 60 * 60; // 90 days for deployed services
    const ttl = Math.min(params.ttlSeconds ?? maxTtl, maxTtl);
    const exp = now + ttl;

    const payload: Record<string, unknown> = {
      sub: `service:${params.serviceName}`,
      org_id: params.orgId,
      project_id: params.projectId,
      env_name: params.envName,
      service_name: params.serviceName,
      permissions: params.permissions,
      exp,
      iat: now,
      type: 'service',
    };

    return createJwtRs256(payload, this.signerKey);
  }

  verifyServiceToken(token: string): ServiceTokenPayload {
    return this.tokenVerifier.verifyServiceToken(token);
  }

  mintAppLinkToken(params: {
    subscriptionId: string;
    consumerProjectId: string;
    consumerOrgId: string;
    consumerPrincipal: string;
    consumerEnv?: string | null;
    producerProjectId: string;
    producerEnv: string;
    apiName: string;
    scopes: string[];
    ttlSeconds?: number;
  }): string {
    if (!this.signerKey?.privateKey) {
      throw new Error('Signing key not configured');
    }

    const now = Math.floor(Date.now() / 1000);
    const maxTtl = 90 * 24 * 60 * 60;
    const ttl = Math.min(params.ttlSeconds ?? maxTtl, maxTtl);
    const exp = now + ttl;
    const audience = `project:${params.producerProjectId}`;

    const payload: Record<string, unknown> = {
      sub: `app_link:${params.subscriptionId}`,
      subscription_id: params.subscriptionId,
      consumer_project_id: params.consumerProjectId,
      consumer_org_id: params.consumerOrgId,
      consumer_principal: params.consumerPrincipal,
      consumer_env: params.consumerEnv ?? null,
      producer_project_id: params.producerProjectId,
      producer_env: params.producerEnv,
      api_name: params.apiName,
      scopes: params.scopes,
      aud: audience,
      exp,
      iat: now,
      type: 'app_link',
    };

    return createJwtRs256(payload, this.signerKey);
  }

  async verifyAppLinkToken(token: string): Promise<AppLinkTokenPayload> {
    return this.appAuth.verifyAppLinkToken(token);
  }

  async getBootstrapStatus(): Promise<BootstrapStatus> {
    return this.bootstrap.getBootstrapStatus();
  }

  async bootstrapAdmin(input: { token?: string; email: string; public_key: string; display_name?: string }) {
    return this.bootstrap.bootstrapAdmin(input);
  }

  async registerIdentity(
    input: { user_id?: string; email?: string; public_key: string; label?: string },
    actor: AuthUser,
  ) {
    if (!actor?.user_id) {
      throw new UnauthorizedException('User context required');
    }

    const targetUser = input.user_id
      ? await this.users.findById(input.user_id)
      : input.email
        ? await this.users.findByEmail(input.email)
        : await this.users.findById(actor.user_id);

    if (!targetUser) {
      throw new BadRequestException('User not found');
    }

    if (!actor.is_admin && targetUser.id !== actor.user_id) {
      throw new ForbiddenException('Only admins can register identities for other users');
    }

    const fingerprint = fingerprintPublicKey(input.public_key);
    const existing = await this.identities.findByFingerprint('github_ssh', fingerprint);
    if (existing) {
      if (existing.user_id !== targetUser.id) {
        throw new ConflictException('SSH key already registered to another user');
      }
      return existing;
    }

    return this.identities.create({
      id: generateIdentityId(),
      user_id: targetUser.id,
      provider: 'github_ssh',
      public_key: input.public_key,
      fingerprint,
      label: input.label ?? null,
    });
  }

  async createChallenge(input: { provider?: string; email?: string; user_id?: string; pubkey?: string }) {
    const providerName = input.provider ?? 'github_ssh';
    const provider = this.providerRegistry.get(providerName);
    if (!provider) {
      throw new BadRequestException(`Unknown auth provider: ${providerName}`);
    }

    const config = loadConfig();
    const expiresAt = new Date(Date.now() + config.EVE_AUTH_CHALLENGE_TTL_SECONDS * 1000);

    // ---- SSH path (existing behavior, unchanged) ----
    if (providerName === 'github_ssh') {
      const user = input.user_id
        ? await this.users.findById(input.user_id)
        : input.email
          ? await this.users.findByEmail(input.email)
          : null;

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      const identities = await this.identities.listByUserAndProvider(user.id, 'github_ssh');
      if (identities.length === 0) {
        throw new BadRequestException('No GitHub SSH keys registered');
      }

      const challengeData = await provider.createChallenge({ userId: user.id });
      const challenge = await this.challenges.createWithProvider({
        userId: user.id,
        provider: providerName,
        nonce: challengeData.nonce,
        expiresAt,
      });

      return {
        challenge_id: challenge.id,
        nonce: challenge.nonce,
        expires_at: challenge.expires_at.toISOString(),
      };
    }

    // ---- Nostr path ----
    // Resolve user by email/user_id first, then fall back to pubkey fingerprint lookup
    let userId: string | null = null;

    if (input.user_id) {
      const user = await this.users.findById(input.user_id);
      if (user) userId = user.id;
    } else if (input.email) {
      const user = await this.users.findByEmail(input.email);
      if (user) userId = user.id;
    }

    // If no user found yet and pubkey provided, try fingerprint lookup
    let metadata: Record<string, unknown> | null = null;
    if (!userId && input.pubkey) {
      const fp = await provider.fingerprint(input.pubkey);
      const identity = await this.identities.findByFingerprint('nostr', fp);
      if (identity) {
        userId = identity.user_id;
      } else {
        // Store pubkey in metadata for later identity creation on verify
        metadata = { pubkey: input.pubkey };
      }
    }

    const challengeData = await provider.createChallenge({ userId: userId ?? undefined, pubkey: input.pubkey });
    const challenge = await this.challenges.createWithProvider({
      userId,
      provider: providerName,
      nonce: challengeData.nonce,
      expiresAt,
      metadata,
    });

    return {
      challenge_id: challenge.id,
      nonce: challenge.nonce,
      expires_at: challenge.expires_at.toISOString(),
    };
  }

  async verifyChallenge(input: { challenge_id: string; signature: string; ttl_days?: number; invite_code?: string }) {
    const challenge = await this.challenges.findById(input.challenge_id);
    if (!challenge) {
      throw new UnauthorizedException('Challenge not found');
    }

    if (challenge.used_at) {
      throw new UnauthorizedException('Challenge already used');
    }

    if (challenge.expires_at.getTime() < Date.now()) {
      throw new UnauthorizedException('Challenge expired');
    }

    const providerName = challenge.provider ?? 'github_ssh';
    const provider = this.providerRegistry.get(providerName);
    if (!provider) {
      throw new UnauthorizedException(`Unknown provider on challenge: ${providerName}`);
    }

    // ---- SSH path (existing behavior, unchanged) ----
    if (providerName === 'github_ssh') {
      if (!challenge.user_id) {
        throw new UnauthorizedException('Challenge has no associated user');
      }

      const identities = await this.identities.listByUserAndProvider(challenge.user_id, 'github_ssh');
      if (identities.length === 0) {
        throw new UnauthorizedException('No SSH identities configured');
      }

      const user = await this.users.findById(challenge.user_id);
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      const verified = await provider.verifyChallenge(
        challenge.nonce,
        { signature: input.signature, principal: user.id },
        identities,
      );

      if (!verified) {
        throw new UnauthorizedException('Signature verification failed');
      }

      await this.challenges.markUsed(challenge.id);
      const ttlSeconds = input.ttl_days ? input.ttl_days * 86400 : undefined;
      const token = await this.mintUserToken(user.id, user.email, ttlSeconds);
      return { ...token, user_id: user.id };
    }

    // ---- Provider-generic path (Nostr, future providers) ----

    // Gather identities for verification
    let identities: Awaited<ReturnType<typeof this.identities.listByUserAndProvider>> = [];
    if (challenge.user_id) {
      identities = await this.identities.listByUserAndProvider(challenge.user_id, providerName);
    } else if (challenge.metadata && typeof (challenge.metadata as Record<string, unknown>).pubkey === 'string') {
      // No user — search by pubkey fingerprint for possible match
      const pubkey = (challenge.metadata as Record<string, unknown>).pubkey as string;
      const fp = await provider.fingerprint(pubkey);
      identities = (await this.identities.findAllByFingerprint(fp)).filter(
        (id) => id.provider === providerName,
      );
    }

    const verified = await provider.verifyChallenge(
      challenge.nonce,
      { signature: input.signature },
      identities,
    );

    if (!verified) {
      throw new UnauthorizedException('Signature verification failed');
    }

    await this.challenges.markUsed(challenge.id);
    const ttlSeconds = input.ttl_days ? input.ttl_days * 86400 : undefined;

    // If provider resolved a known user, mint token directly
    if (verified.userId) {
      const user = await this.users.findById(verified.userId);
      if (!user) {
        throw new UnauthorizedException('User not found');
      }
      const token = await this.mintUserToken(user.id, user.email, ttlSeconds);
      return { ...token, user_id: user.id };
    }

    // Unknown identity — attempt invite-gated provisioning via resolveVerifiedIdentity
    if (input.invite_code) {
      verified.metadata = { ...verified.metadata, invite_code: input.invite_code };
    }
    const authUser = await this.resolveVerifiedIdentity(verified);
    const token = await this.mintUserToken(authUser.user_id, authUser.email, ttlSeconds);
    return { ...token, user_id: authUser.user_id };
  }

  getJwks(): { keys: Array<Record<string, unknown>> } {
    const keys = this.keys.map((entry) => {
      const jwk = entry.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      return {
        ...jwk,
        kid: entry.kid,
        use: 'sig',
        alg: 'RS256',
      };
    });
    return { keys };
  }

  /**
   * Resolve a VerifiedIdentity (from provider request auth) into an AuthUser.
   *
   * Resolution order:
   *   1. If verified.userId is already set, look up user directly.
   *   2. Search identities by fingerprint (externalId) across all providers.
   *   3. Attempt invite-gated provisioning.
   *   4. Reject if nothing matched.
   */
  async resolveVerifiedIdentity(verified: VerifiedIdentity): Promise<AuthUser> {
    // 1. Direct user ID (identity row was already resolved by the provider)
    if (verified.userId) {
      const user = await this.users.findById(verified.userId);
      if (user) {
        return this.tokenVerifier.authUserFromUser(user);
      }
    }

    // 2. Search by fingerprint across all providers
    const identities = await this.identities.findAllByFingerprint(verified.externalId);
    const match = identities.find((i) => i.provider === verified.provider);
    if (match) {
      const user = await this.users.findById(match.user_id);
      if (user) {
        return this.tokenVerifier.authUserFromUser(user);
      }
    }

    // 3. Invite-gated provisioning
    const provisioned = await this.provisionViaInvite(verified);
    if (provisioned) {
      return this.tokenVerifier.authUserFromUser(provisioned);
    }

    throw new UnauthorizedException('Identity not registered and no valid invite found');
  }

  /**
   * Attempt to provision a new user + org membership via a pending invite.
   *
   * Invite lookup:
   *   - Explicit invite_code in metadata takes priority.
   *   - Falls back to identity-hint matching (provider + externalId).
   */
  private async provisionViaInvite(verified: VerifiedIdentity): Promise<{ id: string; email: string; is_admin: boolean } | null> {
    const inviteCode = verified.metadata?.invite_code as string | undefined;

    const invite = inviteCode
      ? await this.orgInvites.findByCode(inviteCode)
      : await this.orgInvites.findByIdentityHint(verified.provider, verified.externalId);

    if (!invite) return null;

    // Validate: not used, not expired
    if (invite.used_at) return null;
    if (invite.expires_at && invite.expires_at.getTime() < Date.now()) return null;

    // Provision inside a transaction for atomicity
    const userId = generateUserId();
    const identityId = generateIdentityId();
    const syntheticEmail = `${verified.provider}:${verified.externalId.slice(0, 16)}@provision.local`;
    const role = (invite.role ?? 'member') as MembershipRole;

    const user = await this.db.begin(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const txUsers = userQueries(tx);
      const txIdentities = identityQueries(tx);
      const txMemberships = membershipQueries(tx);
      const txInvites = orgInviteQueries(tx);

      const newUser = await txUsers.create({
        id: userId,
        email: syntheticEmail,
        display_name: verified.displayName ?? null,
        is_admin: false,
      });

      await txIdentities.create({
        id: identityId,
        user_id: newUser.id,
        provider: verified.provider,
        public_key: verified.externalId,
        fingerprint: verified.externalId,
        label: 'provisioned-via-invite',
      });

      await txMemberships.upsertOrgMembership(invite.org_id, newUser.id, role);
      await txInvites.markUsed(invite.id, newUser.id);

      return newUser;
    });

    this.logger.log(`Provisioned user ${user.id} via invite ${invite.id} into org ${invite.org_id}`);
    return user;
  }
}