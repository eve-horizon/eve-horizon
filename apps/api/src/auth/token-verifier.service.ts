import {
  Injectable,
  Logger,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import {
  loadConfig,
  generateUserId,
  generateIdentityId,
  AccessBindingScopeSchema,
  type AccessBindingScope,
} from '@eve/shared';
import {
  type Db,
  userQueries,
  identityQueries,
  membershipQueries,
  orgInviteQueries,
  type MembershipRole,
} from '@eve/db';
import { AppAuthService } from './app-auth.service.js';
import { MagicLinkService } from './magic-link.service.js';
import {
  type JwtPayload,
  type KeyEntry,
  loadKeyRing,
  verifyJwtRs256,
  verifyJwtHs256,
  decodeJwtPayload,
  hashEmail,
} from './auth.util.js';
import type { AuthUser, JobTokenPayload, ServiceTokenPayload } from './auth.types.js';

/**
 * Bearer-token verification for the auth hot path: routes job / service /
 * app-link / service-principal / user / Supabase tokens to their verifiers
 * and resolves them into AuthUsers. Extracted verbatim from AuthService
 * (refactor batch R-C3); AuthService and AuthGuard delegate here.
 */
@Injectable()
export class TokenVerifierService {
  private readonly logger = new Logger(TokenVerifierService.name);
  private readonly enabled: boolean;
  /** HS256 secret for verifying Supabase tokens (set when SUPABASE_JWT_SECRET is configured) */
  private readonly supabaseSecret?: string;
  /** True when RS256 key pair is loaded — enables internal token verification and minting */
  private readonly hasInternalKeys: boolean;
  private readonly keys: KeyEntry[];
  private readonly signerKey?: KeyEntry;
  private readonly users: ReturnType<typeof userQueries>;
  private readonly identities: ReturnType<typeof identityQueries>;
  private readonly memberships: ReturnType<typeof membershipQueries>;
  private readonly orgInvites: ReturnType<typeof orgInviteQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly appAuth: AppAuthService,
    private readonly magicLink: MagicLinkService,
  ) {
    const config = loadConfig();
    this.enabled = config.EVE_AUTH_ENABLED;
    this.supabaseSecret = config.SUPABASE_JWT_SECRET;
    this.keys = loadKeyRing(config);
    this.signerKey = this.keys.find((key) => key.privateKey);
    this.hasInternalKeys = Boolean(this.signerKey);
    this.users = userQueries(db);
    this.identities = identityQueries(db);
    this.memberships = membershipQueries(db);
    this.orgInvites = orgInviteQueries(db);
  }

  async verifyAuthorizationHeader(header: string): Promise<AuthUser> {
    if (!this.enabled) {
      throw new UnauthorizedException('Auth is disabled');
    }

    const token = this.extractBearerToken(header);

    // Peek at the token payload without verification to route special token types.
    // Job, service, and service principal tokens are always RS256-signed by Eve API.
    const rawPayload = decodeJwtPayload(token);
    if (rawPayload?.type === 'job') {
      return this.resolveJobTokenAuth(token);
    }
    if (rawPayload?.type === 'service') {
      return this.resolveServiceTokenAuth(token);
    }
    if (rawPayload?.type === 'app_link') {
      return this.resolveAppLinkTokenAuth(token);
    }
    if (rawPayload?.type === 'service_principal') {
      return this.resolveServicePrincipalTokenAuth(token);
    }

    // Dual-mode verification: try RS256 (internal Eve token) first, then HS256 (Supabase).
    // RS256 is tried first because it's the "native" Eve token format and avoids
    // an unnecessary DB lookup when the caller already has an Eve token.
    if (this.hasInternalKeys) {
      try {
        return await this.resolveInternalUserToken(token);
      } catch {
        // Not a valid RS256 token — fall through to Supabase verification
      }
    }

    // Try HS256 (Supabase token)
    if (this.supabaseSecret) {
      return await this.resolveSupabaseToken(token);
    }

    throw new UnauthorizedException('No valid token verification method available');
  }

  /**
   * Resolve an RS256-signed Eve user token into an AuthUser.
   * Uses live DB memberships (not stale JWT claims) so that role/org
   * changes made after token issuance are reflected immediately.
   */
  private async resolveInternalUserToken(token: string): Promise<AuthUser> {
    const claims = this.verifyUserToken(token);
    if (!claims.sub) {
      throw new UnauthorizedException('Token subject missing');
    }

    const user = await this.users.findById(claims.sub);
    if (!user) {
      throw new UnauthorizedException('User not found for token');
    }

    return this.authUserFromUser(user);
  }

  /**
   * Resolve an HS256 Supabase token into an AuthUser.
   *
   * Identity linking strategy:
   *   1. Look up by Supabase identity link (fingerprint = Supabase UUID).
   *   2. Match by email (first login after invite — creates the identity link).
   *   3. Auto-provision a new Eve user (dev/test convenience).
   */
  private async resolveSupabaseToken(token: string): Promise<AuthUser> {
    const claims = this.verifySupabaseToken(token);
    const supabaseUuid = claims.sub;
    if (!supabaseUuid) {
      throw new UnauthorizedException('Supabase token missing sub claim');
    }

    // 1. Direct identity link lookup — fastest path for returning users
    const identity = await this.identities.findByFingerprint('supabase', supabaseUuid);
    if (identity) {
      const user = await this.users.findById(identity.user_id);
      if (user) {
        return this.attachPendingSupabaseInvite(user, claims.email);
      }
    }

    // 2. Email-based linking (first Supabase login for an invited user)
    if (claims.email) {
      const user = await this.users.findByEmail(claims.email);
      if (user) {
        await this.identities.create({
          id: generateIdentityId(),
          user_id: user.id,
          provider: 'supabase',
          public_key: supabaseUuid,
          fingerprint: supabaseUuid,
          label: 'supabase-auto-linked',
        });
        this.logger.log(`Linked Supabase UUID ${supabaseUuid} to Eve user ${user.id} via email match`);
        return this.attachPendingSupabaseInvite(user, claims.email);
      }
    }

    // 3. Auto-provision new Eve user
    return this.autoProvisionSupabaseUser(claims, supabaseUuid);
  }

  /**
   * Apply any pending Supabase-provider org invite for this user's email and
   * surface the invite_redirect_to / org / app_context on the AuthUser. Safe
   * to call for newly-provisioned and returning users alike.
   */
  private async attachPendingSupabaseInvite(
    user: Awaited<ReturnType<typeof this.users.findById>> & object,
    email: string | undefined,
  ): Promise<AuthUser> {
    const authUser = await this.authUserFromUser(user);
    if (!email) return authUser;
    const inviteResult = await this.autoApplyOrgInviteByEmail(user.id, email);
    if (inviteResult.error) {
      this.logger.error(`Failed to apply org invite for ${email}: ${inviteResult.error}`);
    }
    if (inviteResult.applied) {
      // Refresh memberships in the AuthUser so callers (SSO callback) see
      // the org membership that was just upserted.
      const refreshed = await this.authUserFromUser(user);
      Object.assign(authUser, refreshed);
    }
    if (inviteResult.redirect_to) authUser.invite_redirect_to = inviteResult.redirect_to;
    if (inviteResult.org_id) authUser.invite_org_id = inviteResult.org_id;
    if (inviteResult.app_context !== undefined) authUser.invite_app_context = inviteResult.app_context;
    return authUser;
  }

  /**
   * Auto-provision a new Eve user from Supabase claims.
   * Creates the user with an Eve TypeID, links the Supabase UUID as an identity,
   * and applies any pending org invite matching the email.
   */
  private async autoProvisionSupabaseUser(claims: JwtPayload, supabaseUuid: string): Promise<AuthUser> {
    const userId = generateUserId();
    const email = claims.email ?? `${supabaseUuid}@supabase.local`;
    const displayName = (claims.user_metadata as Record<string, unknown> | undefined)?.name as string | undefined;

    const user = await this.users.create({
      id: userId,
      email,
      display_name: displayName ?? null,
      is_admin: false,
    });

    await this.identities.create({
      id: generateIdentityId(),
      user_id: user.id,
      provider: 'supabase',
      public_key: supabaseUuid,
      fingerprint: supabaseUuid,
      label: 'supabase-auto-provisioned',
    });

    // Auto-apply pending org invite by email
    let inviteRedirectTo: string | undefined;
    let inviteOrgId: string | undefined;
    let inviteAppContext: Record<string, unknown> | null | undefined;
    if (claims.email) {
      const inviteResult = await this.autoApplyOrgInviteByEmail(user.id, claims.email);
      if (inviteResult.error) {
        this.logger.error(`Failed to apply org invite for ${claims.email}: ${inviteResult.error}`);
      }
      if (inviteResult.redirect_to) {
        inviteRedirectTo = inviteResult.redirect_to;
      }
      if (inviteResult.org_id) {
        inviteOrgId = inviteResult.org_id;
      }
      if (inviteResult.app_context !== undefined) {
        inviteAppContext = inviteResult.app_context;
      }
    }

    this.logger.log(`Auto-provisioned Eve user ${user.id} for Supabase UUID ${supabaseUuid}`);
    const authUser = await this.authUserFromUser(user);
    if (inviteRedirectTo) {
      authUser.invite_redirect_to = inviteRedirectTo;
    }
    if (inviteOrgId) {
      authUser.invite_org_id = inviteOrgId;
    }
    if (inviteAppContext !== undefined) {
      authUser.invite_app_context = inviteAppContext;
    }
    return authUser;
  }

  /**
   * If a pending org invite exists for this email, apply it automatically.
   * This handles the case where an admin invited a user by email before
   * the user signed up through Supabase Auth.
   *
   * Returns a result object so callers can see whether the invite was applied
   * and surface errors rather than swallowing them silently.
   */
  async autoApplyOrgInviteByEmail(
    userId: string,
    email: string,
  ): Promise<{ applied: boolean; org_id?: string; redirect_to?: string; app_context?: Record<string, unknown> | null; error?: string }> {
    try {
      const invite = await this.orgInvites.findByIdentityHint('supabase', email);
      if (!invite || invite.used_at || (invite.expires_at && invite.expires_at.getTime() < Date.now())) {
        return { applied: false };
      }
      const role = (invite.role ?? 'member') as MembershipRole;
      await this.memberships.upsertOrgMembership(invite.org_id, userId, role);
      await this.orgInvites.markUsed(invite.id, userId);
      this.logger.log(`Auto-applied org invite ${invite.id} for user ${userId} into org ${invite.org_id}`);

      // Audit event for domain-signup attachments. Distinct from explicit
      // invites so operators can see who joined via policy vs admin action.
      const appCtx = invite.app_context ?? {};
      const projectId = typeof appCtx.project_id === 'string' ? appCtx.project_id : null;
      if (projectId && appCtx.source === 'domain_signup') {
        await this.magicLink.emitDomainSignupEvent(
          projectId,
          'auth.domain_signup.member_attached',
          {
            org_id: invite.org_id,
            user_id: userId,
            email_domain: typeof appCtx.matched_domain === 'string' ? appCtx.matched_domain : null,
            email_hash: hashEmail(email),
          },
          { actor_type: 'user', actor_id: userId },
        );
      }

      return {
        applied: true,
        org_id: invite.org_id,
        redirect_to: invite.redirect_to ?? undefined,
        app_context: invite.app_context,
      };
    } catch (err) {
      this.logger.error(`Failed to auto-apply org invite for ${email}: ${err instanceof Error ? err.message : String(err)}`);
      return { applied: false, error: String(err) };
    }
  }

  /**
   * Resolve a Supabase token specifically for the token exchange endpoint.
   * Same linking logic as resolveSupabaseToken but takes a raw token string
   * (the exchange endpoint handles its own Bearer extraction).
   */
  async resolveSupabaseTokenForExchange(token: string): Promise<AuthUser> {
    if (!this.supabaseSecret) {
      throw new UnauthorizedException('Supabase JWT secret not configured');
    }
    return this.resolveSupabaseToken(token);
  }

  private resolveJobTokenAuth(token: string): AuthUser {
    const payload = this.verifyJobToken(token);
    return {
      user_id: payload.user_id,
      role: 'member',
      is_admin: false,
      org_id: payload.org_id ?? undefined,
      is_job_token: true,
      job_id: payload.job_id,
      project_id: payload.project_id,
      permissions: payload.permissions,
      ...(payload.scope ? { scope: payload.scope } : {}),
      ...(payload.agent_slug ? { agent_slug: payload.agent_slug } : {}),
      ...(payload.email ? { email: payload.email } : {}),
    };
  }

  private resolveServiceTokenAuth(token: string): AuthUser {
    const payload = this.verifyServiceToken(token);
    return {
      user_id: payload.sub,
      role: 'member',
      is_admin: false,
      org_id: payload.org_id,
      project_id: payload.project_id,
      is_service_token: true,
      service_name: payload.service_name,
      env_name: payload.env_name,
      permissions: payload.permissions,
    };
  }

  private async resolveAppLinkTokenAuth(token: string): Promise<AuthUser> {
    const payload = await this.appAuth.verifyAppLinkToken(token);
    return {
      user_id: payload.sub,
      role: 'member',
      is_admin: false,
      org_id: payload.consumer_org_id,
      project_id: payload.producer_project_id,
      is_app_link_token: true,
      subscription_id: payload.subscription_id,
      consumer_project_id: payload.consumer_project_id,
      producer_project_id: payload.producer_project_id,
      consumer_principal: payload.consumer_principal,
      consumer_env: payload.consumer_env,
      producer_env: payload.producer_env,
      api_name: payload.api_name,
      permissions: payload.scopes,
    };
  }

  private resolveServicePrincipalTokenAuth(token: string): AuthUser {
    const payload = this.verifyServicePrincipalToken(token);
    return payload;
  }

  verifyServicePrincipalToken(token: string): AuthUser {
    if (!this.signerKey) {
      throw new UnauthorizedException('Auth is not configured');
    }

    const payload = verifyJwtRs256(token, this.keys);

    if (payload.type !== 'service_principal') {
      throw new UnauthorizedException('Invalid token type');
    }

    const sub = payload.sub as string | undefined;
    if (typeof sub !== 'string' || !sub.startsWith('sp:')) {
      throw new UnauthorizedException('Invalid service principal token subject');
    }

    const principalId = sub.slice(3); // Remove 'sp:' prefix
    const orgId = payload.org_id as string | undefined;
    if (typeof orgId !== 'string') {
      throw new UnauthorizedException('Service principal token missing org_id');
    }

    const scopes = (payload.scopes ?? payload.permissions) as unknown;
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')) {
      throw new UnauthorizedException('Invalid service principal token scopes');
    }

    return {
      user_id: principalId,
      org_id: orgId,
      role: 'member',
      is_admin: false,
      is_service_principal: true,
      permissions: scopes as string[],
    };
  }

  verifyJobToken(token: string): JobTokenPayload {
    if (!this.signerKey) {
      throw new UnauthorizedException('Auth is not configured');
    }

    const payload = verifyJwtRs256(token, this.keys);

    if (payload.type !== 'job') {
      throw new UnauthorizedException('Invalid token type');
    }

    const userId = (payload.user_id ?? payload.sub) as string | undefined;
    if (typeof userId !== 'string') {
      throw new UnauthorizedException('Token user_id missing');
    }

    if (payload.org_id !== null && typeof payload.org_id !== 'string') {
      throw new UnauthorizedException('Invalid token org_id');
    }

    if (typeof payload.project_id !== 'string') {
      throw new UnauthorizedException('Token project_id missing');
    }

    if (typeof payload.job_id !== 'string') {
      throw new UnauthorizedException('Token job_id missing');
    }

    // Support both 'permissions' (new) and 'scopes' (legacy) claim names
    const perms = (payload.permissions ?? payload.scopes) as unknown;
    if (!Array.isArray(perms) || !perms.every((s) => typeof s === 'string')) {
      throw new UnauthorizedException('Invalid token permissions');
    }

    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
      throw new UnauthorizedException('Invalid token timestamps');
    }

    let scope: AccessBindingScope | undefined;
    if (payload.scope !== undefined) {
      const parsedScope = AccessBindingScopeSchema.safeParse(payload.scope);
      if (!parsedScope.success) {
        throw new UnauthorizedException('Invalid token scope');
      }
      scope = parsedScope.data;
    }

    return {
      sub: userId,
      user_id: userId,
      org_id: payload.org_id as string | null,
      project_id: payload.project_id as string,
      job_id: payload.job_id as string,
      permissions: perms as string[],
      ...(scope ? { scope } : {}),
      ...(typeof payload.agent_slug === 'string' ? { agent_slug: payload.agent_slug } : {}),
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      exp: payload.exp,
      iat: payload.iat,
      type: 'job',
    };
  }

  verifyServiceToken(token: string): ServiceTokenPayload {
    if (!this.signerKey) {
      throw new UnauthorizedException('Auth is not configured');
    }

    const payload = verifyJwtRs256(token, this.keys);

    if (payload.type !== 'service') {
      throw new UnauthorizedException('Invalid token type');
    }

    const sub = payload.sub as string | undefined;
    if (typeof sub !== 'string' || !sub.startsWith('service:')) {
      throw new UnauthorizedException('Invalid service token subject');
    }

    if (typeof payload.org_id !== 'string') {
      throw new UnauthorizedException('Service token missing org_id');
    }

    if (typeof payload.project_id !== 'string') {
      throw new UnauthorizedException('Service token missing project_id');
    }

    if (typeof payload.env_name !== 'string') {
      throw new UnauthorizedException('Service token missing env_name');
    }

    if (typeof payload.service_name !== 'string') {
      throw new UnauthorizedException('Service token missing service_name');
    }

    const perms = payload.permissions as unknown;
    if (!Array.isArray(perms) || !perms.every((s) => typeof s === 'string')) {
      throw new UnauthorizedException('Invalid service token permissions');
    }

    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
      throw new UnauthorizedException('Invalid token timestamps');
    }

    return {
      sub,
      org_id: payload.org_id as string,
      project_id: payload.project_id as string,
      env_name: payload.env_name as string,
      service_name: payload.service_name as string,
      permissions: perms as string[],
      exp: payload.exp,
      iat: payload.iat,
      type: 'service',
    };
  }

  async authUserFromUser(user: { id: string; email: string; is_admin: boolean }): Promise<AuthUser> {
    const memberships = await this.memberships.listOrgMembershipsForUser(user.id);
    // Enrich memberships with org name/slug for the dashboard org switcher
    const orgIds = memberships.map(m => m.org_id);
    const orgRows = orgIds.length
      ? await this.db<Array<{ id: string; name: string; slug: string }>>`
          SELECT id, name, slug FROM orgs WHERE id = ANY(${orgIds}) AND deleted_at IS NULL
        `
      : [];
    const orgMap = new Map(orgRows.map(o => [o.id, o]));
    const orgRoles = memberships.map(m => {
      const org = orgMap.get(m.org_id);
      return { org_id: m.org_id, role: m.role, org_name: org?.name, org_slug: org?.slug };
    });
    const inferredOrg = memberships.length === 1 ? memberships[0].org_id : undefined;
    const inferredRole = memberships.length === 1 ? memberships[0].role : undefined;
    const role = user.is_admin ? 'system_admin' : inferredRole;

    return {
      user_id: user.id,
      email: user.email,
      role,
      is_admin: user.is_admin,
      org_id: inferredOrg,
      memberships: orgRoles,
    };
  }

  private verifyUserToken(token: string): JwtPayload {
    return verifyJwtRs256(token, this.keys);
  }

  private verifySupabaseToken(token: string): JwtPayload {
    const secret = this.supabaseSecret ?? loadConfig().EVE_AUTH_JWT_SECRET;
    if (!secret) {
      throw new UnauthorizedException('Supabase JWT secret not configured');
    }
    return verifyJwtHs256(token, secret);
  }

  private extractBearerToken(header: string): string {
    const [scheme, token] = header.split(' ');
    if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Authorization header must be a Bearer token');
    }
    return token;
  }
}
