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
  createHash,
  createHmac,
  timingSafeEqual,
  randomBytes,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  type KeyObject,
} from 'crypto';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Track when the API started for auto-open bootstrap window
const API_START_TIME = Date.now();
import { spawnSync } from 'child_process';
import {
  loadConfig,
  generateUserId,
  generateIdentityId,
  generateServicePrincipalId,
  generateServicePrincipalTokenId,
  generateMagicLinkWrapId,
  ProjectAuthConfigSchema,
  ProjectBrandingSchema,
  AccessBindingScopeSchema,
  type AppAccessResponse,
  type AppInviteRequest,
  type AppInviteResponse,
  type AppAuthContextResponse,
  type AppAuthContextAdminResponse,
  type MagicLinkRequest,
  type MagicLinkResponse,
  type ProjectAuthConfig,
  type ProjectBranding,
  type AccessBindingScope,
} from '@eve/shared';
import {
  type Db,
  userQueries,
  identityQueries,
  authChallengeQueries,
  membershipQueries,
  projectQueries,
  appLinkSubscriptionQueries,
  orgInviteQueries,
  servicePrincipalQueries,
  magicLinkWrapQueries,
  type MagicLinkWrapKind,
  type MembershipRole,
} from '@eve/db';
import type { VerifiedIdentity } from './providers/identity-provider.interface.js';
import { IdentityProviderRegistry } from './providers/index.js';
import { MailerService } from '../mailer/mailer.service.js';
import { EmailSuppressedError } from '../mailer/errors.js';
import { renderAuthActionEmail, renderInviteEmail } from '../mailer/templates/invite.js';
import { AppAuthPolicyService } from './app-auth-policy.service.js';
import { EventsService } from '../events/events.service.js';
import { emailDomain, matchesDomainAllowlist } from './email-domain.js';

type JwtHeader = { alg?: string; kid?: string } & Record<string, unknown>;
type JwtPayload = {
  sub?: string;
  email?: string;
  role?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  type?: string;
} & Record<string, unknown>;

export type AuthUser = {
  user_id: string;
  email?: string;
  role?: string;
  is_admin?: boolean;
  org_id?: string;
  /** Set when the request was made with a job-scoped token */
  is_job_token?: boolean;
  /** The job ID from the token (only set for job tokens) */
  job_id?: string;
  /** The project ID from the token (only set for job/service tokens) */
  project_id?: string;
  /** The agent slug from the token (only set for agent job tokens) */
  agent_slug?: string;
  /** Explicit permissions from job token, service token, or service principal token */
  permissions?: string[];
  /** Optional job-token resource scope. Undefined preserves legacy unscoped job-token behavior. */
  scope?: AccessBindingScope;
  /** Set when the request was made with a service principal token */
  is_service_principal?: boolean;
  /** Set when the request was made with a deployed-service token */
  is_service_token?: boolean;
  /** Set when the request was made with a cross-project app-link token */
  is_app_link_token?: boolean;
  /** The service name from the token (only set for service tokens) */
  service_name?: string;
  /** The environment name from the token (only set for service tokens) */
  env_name?: string;
  /** App-link fields (only set for app-link tokens) */
  subscription_id?: string;
  consumer_project_id?: string;
  producer_project_id?: string;
  consumer_principal?: string;
  consumer_env?: string | null;
  producer_env?: string;
  api_name?: string;
  /** Per-org membership roles (populated for user tokens) */
  memberships?: Array<{ org_id: string; role: string; org_name?: string; org_slug?: string }>;
  /** Redirect URL from a just-applied org invite (used by SSO callback) */
  invite_redirect_to?: string;
  /** Org ID from a just-applied app-scoped invite. */
  invite_org_id?: string;
  /** App context from a just-applied org invite. */
  invite_app_context?: Record<string, unknown> | null;
};

export interface JobTokenPayload {
  sub: string;
  user_id: string;
  org_id: string | null;
  project_id: string;
  job_id: string;
  permissions: string[];
  scope?: AccessBindingScope;
  agent_slug?: string;
  email?: string;
  exp: number;
  iat: number;
  type: 'job';
}

export interface ServiceTokenPayload {
  sub: string;
  org_id: string;
  project_id: string;
  env_name: string;
  service_name: string;
  permissions: string[];
  exp: number;
  iat: number;
  type: 'service';
}

export interface AppLinkTokenPayload {
  sub: string;
  subscription_id: string;
  consumer_project_id: string;
  consumer_org_id: string;
  consumer_principal: string;
  consumer_env: string | null;
  producer_project_id: string;
  producer_env: string;
  api_name: string;
  scopes: string[];
  aud: string;
  exp: number;
  iat: number;
  type: 'app_link';
}

export type BootstrapMode = 'auto-open' | 'recovery' | 'secure' | 'closed';

export interface BootstrapStatus {
  completed: boolean;
  windowOpen: boolean;
  windowClosesAt: Date | null;
  requiresToken: boolean;
  mode: BootstrapMode;
}

type KeyEntry = {
  kid: string;
  publicKey: KeyObject;
  privateKey?: KeyObject;
};

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
  private readonly projects: ReturnType<typeof projectQueries>;
  private readonly appLinkSubscriptions: ReturnType<typeof appLinkSubscriptionQueries>;
  private readonly orgInvites: ReturnType<typeof orgInviteQueries>;
  private readonly servicePrincipals: ReturnType<typeof servicePrincipalQueries>;
  private readonly magicLinkWraps: ReturnType<typeof magicLinkWrapQueries>;
  private readonly bootstrapToken?: string;
  private readonly bootstrapTriggerFile: string;
  private readonly bootstrapWindowMinutes: number;
  private readonly userTokenTtlSeconds: number;
  private readonly orgsClaimLimit: number;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly providerRegistry: IdentityProviderRegistry,
    private readonly mailerService: MailerService,
    private readonly appAuthPolicy?: AppAuthPolicyService,
    private readonly events?: EventsService,
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
    this.projects = projectQueries(db);
    this.appLinkSubscriptions = appLinkSubscriptionQueries(db);
    this.orgInvites = orgInviteQueries(db);
    this.servicePrincipals = servicePrincipalQueries(db);
    this.magicLinkWraps = magicLinkWrapQueries(db);

    this.bootstrapToken = config.EVE_BOOTSTRAP_TOKEN;
    this.bootstrapTriggerFile = config.EVE_BOOTSTRAP_TRIGGER_FILE;
    this.bootstrapWindowMinutes = config.EVE_BOOTSTRAP_WINDOW_MINUTES;
    this.userTokenTtlSeconds = config.EVE_AUTH_TOKEN_TTL_DAYS * 24 * 60 * 60;
    this.orgsClaimLimit = config.EVE_AUTH_ORGS_CLAIM_LIMIT;
  }

  isEnabled(): boolean {
    return this.enabled;
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
        await this.emitDomainSignupEvent(
          projectId,
          'auth.domain_signup.member_attached',
          {
            org_id: invite.org_id,
            user_id: userId,
            email_domain: typeof appCtx.matched_domain === 'string' ? appCtx.matched_domain : null,
            email_hash: this.hashEmail(email),
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
    const payload = await this.verifyAppLinkToken(token);
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

  /**
   * Generate a GoTrue auth action link without sending GoTrue's built-in email.
   */
  async generateAuthActionLink(
    type: 'invite' | 'magiclink',
    email: string,
    redirectTo?: string,
  ): Promise<string> {
    const config = loadConfig();
    const authUrl = config.SUPABASE_AUTH_URL;
    const serviceKey = config.SUPABASE_AUTH_SERVICE_KEY;

    if (!authUrl || !serviceKey) {
      throw new BadRequestException(
        'Supabase Auth not configured (SUPABASE_AUTH_URL and SUPABASE_AUTH_SERVICE_KEY required)',
      );
    }

    const response = await fetch(`${authUrl}/admin/generate_link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
      body: JSON.stringify({
        type,
        email,
        ...(redirectTo ? { redirect_to: redirectTo } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.warn(`GoTrue generate_link ${type} failed for ${email}: ${response.status} ${errorText}`);
      throw new BadRequestException(`GoTrue generate_link failed (${response.status}): ${errorText}`);
    }

    const result = (await response.json()) as {
      action_link?: string;
      properties?: { action_link?: string };
    };
    const actionLink = result.action_link ?? result.properties?.action_link;
    if (!actionLink) {
      throw new BadRequestException('GoTrue generate_link did not return an action_link');
    }

    this.logger.log(`Generated GoTrue ${type} link for ${email}`);
    return actionLink;
  }

  /**
   * Generate a GoTrue invite action link without sending GoTrue's built-in email.
   *
   * Returns the *raw* GoTrue URL. Most callers should use
   * {@link generateWrappedInviteLink} instead so the URL placed in emails is
   * the scanner-safe SSO interstitial (`/m/mlw_...`) rather than the
   * single-use GoTrue verify endpoint.
   */
  async generateInviteLink(email: string, redirectTo?: string): Promise<string> {
    return this.generateAuthActionLink('invite', email, redirectTo);
  }

  /**
   * Wrap a GoTrue action link behind an SSO confirmation interstitial. The
   * raw GoTrue URL is stored server-side under a fresh opaque token; the
   * returned URL is what should be placed in user-visible emails so that
   * corporate email-security scanners cannot consume the underlying OTP by
   * GET-fetching the link.
   *
   * @see docs/plans/magic-link-confirmation-interstitial-plan.md
   */
  async wrapActionLink(input: {
    gotrueActionLink: string;
    projectId?: string | null;
    orgId?: string | null;
    email: string;
    kind: MagicLinkWrapKind;
    redirectTo?: string | null;
  }): Promise<string> {
    if (input.kind === 'magic_link' && !input.projectId) {
      throw new BadRequestException(
        'wrapActionLink: magic_link wraps require a project_id (CHECK constraint)',
      );
    }
    const config = loadConfig();
    const ssoUrl = (config.EVE_SSO_URL ?? process.env.SSO_URL ?? 'http://sso.eve.lvh.me').replace(/\/$/, '');
    const id = generateMagicLinkWrapId();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h, matches GoTrue default OTP TTL
    await this.magicLinkWraps.create({
      id,
      gotrue_action_link: input.gotrueActionLink,
      project_id: input.projectId ?? null,
      org_id: input.orgId ?? null,
      email_hash: this.hashEmail(input.email),
      kind: input.kind,
      redirect_to: input.redirectTo ?? null,
      expires_at: expiresAt,
    });
    this.logger.log(
      `[wrap.issued] mlw=${id.slice(0, 12)}... kind=${input.kind} project=${input.projectId ?? 'none'} org=${input.orgId ?? 'none'}`,
    );
    return `${ssoUrl}/m/${id}`;
  }

  /**
   * Generate a wrapped invite link suitable for placing in an email. Wraps
   * `generateInviteLink` so callers don't need to thread the wrap call
   * themselves. Use this for any Eve-rendered invite email.
   */
  async generateWrappedInviteLink(input: {
    email: string;
    redirectTo?: string | null;
    projectId?: string | null;
    orgId?: string | null;
  }): Promise<string> {
    const gotrue = await this.generateInviteLink(input.email, input.redirectTo ?? undefined);
    return this.wrapActionLink({
      gotrueActionLink: gotrue,
      projectId: input.projectId ?? null,
      orgId: input.orgId ?? null,
      email: input.email,
      kind: 'invite',
      redirectTo: input.redirectTo ?? null,
    });
  }

  /**
   * Consume a magic-link wrap. Returns the stored GoTrue action_link on
   * success; the SSO POST handler 302-redirects the browser there. Exposed
   * for internal /internal/auth/magic-link-wrap/consume.
   */
  async consumeMagicLinkWrap(id: string): Promise<
    | { status: 'ok'; gotrue_action_link: string; project_id: string | null; org_id: string | null; kind: MagicLinkWrapKind; email_hash: string; get_count: number; latency_ms: number }
    | { status: 'expired' | 'already_consumed' | 'unknown' }
  > {
    const result = await this.magicLinkWraps.consume(id);
    if (result.status !== 'ok') {
      this.logger.log(`[wrap.consume_failed] mlw=${id.slice(0, 12)}... reason=${result.status}`);
      return { status: result.status };
    }
    const latencyMs = Math.max(0, Date.now() - result.created_at.getTime());
    this.logger.log(
      `[wrap.consume] mlw=${id.slice(0, 12)}... project=${result.project_id ?? 'none'} get_count=${result.get_count} latency_ms=${latencyMs}`,
    );
    if (result.project_id) {
      void this.emitWrapRedeemedEvent(result.project_id, {
        org_id: result.org_id,
        email_hash: result.email_hash,
        kind: result.kind,
        get_count: result.get_count,
        latency_ms: latencyMs,
      });
    }
    return {
      status: 'ok',
      gotrue_action_link: result.gotrue_action_link,
      project_id: result.project_id,
      org_id: result.org_id,
      kind: result.kind,
      email_hash: result.email_hash,
      get_count: result.get_count,
      latency_ms: latencyMs,
    };
  }

  /**
   * Inspect a magic-link wrap (read with telemetry bump). Exposed for
   * internal /internal/auth/magic-link-wrap/inspect — the SSO GET/HEAD
   * handlers call this so scanner pre-fetches show up in get_count.
   */
  async inspectMagicLinkWrap(id: string) {
    return this.magicLinkWraps.inspect(id);
  }

  /**
   * Prune expired or long-consumed wraps. Called from a periodic timer in
   * AuthModule. The 24h retention window keeps recent scanner telemetry
   * inspectable without pinning bearer URLs indefinitely.
   */
  async pruneExpiredMagicLinkWraps(cutoff: Date): Promise<number> {
    return this.magicLinkWraps.pruneExpired(cutoff);
  }

  private async emitWrapRedeemedEvent(
    projectId: string,
    payload: {
      org_id: string | null;
      email_hash: string;
      kind: MagicLinkWrapKind;
      get_count: number;
      latency_ms: number;
    },
  ): Promise<void> {
    if (!this.events) return;
    try {
      await this.events.create(projectId, {
        type: 'auth.action_link.wrap_redeemed',
        source: 'auth' as never,
        actor_type: 'system' as never,
        actor_id: null,
        payload_json: payload as Record<string, unknown>,
      } as never);
    } catch (err) {
      this.logger.warn(
        `Failed to emit auth.action_link.wrap_redeemed for project=${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getAppAuthContext(projectId: string): Promise<AppAuthContextResponse> {
    const project = await this.projects.findById(projectId, { include_deleted: false });
    if (!project) {
      throw new BadRequestException(`Project not found: ${projectId}`);
    }
    const authConfig = this.parseProjectAuthConfig(project.auth_config);
    const allowedOrgIds = this.appAuthPolicy
      ? await this.appAuthPolicy.getAllowedOrgIds(project.id)
      : [project.org_id];

    const allowedRedirectOrigins = authConfig && this.appAuthPolicy
      ? await this.appAuthPolicy.getAllowedRedirectOrigins(project, authConfig, allowedOrgIds)
      : (authConfig?.allowed_redirect_origins ?? []);

    return {
      project_id: project.id,
      org_id: project.org_id,
      branding: this.parseProjectBranding(project.branding),
      auth: authConfig
        ? this.appAuthPolicy
          ? this.appAuthPolicy.toPublicAuthConfig(authConfig, allowedOrgIds, allowedRedirectOrigins)
          : this.toPublicAuthConfig(authConfig, allowedOrgIds, allowedRedirectOrigins)
        : null,
    };
  }

  /**
   * Admin-only reveal of the full app auth context, including the resolved
   * domain_signup domain list and target_org. Caller must have project-admin
   * privileges (or be a system admin). The controller is responsible for the
   * authorization check; this method just builds the payload.
   */
  async getAppAuthContextAdmin(projectId: string): Promise<AppAuthContextAdminResponse> {
    const project = await this.projects.findById(projectId, { include_deleted: false });
    if (!project) {
      throw new BadRequestException(`Project not found: ${projectId}`);
    }
    const authConfig = this.parseProjectAuthConfig(project.auth_config);
    const allowedOrgIds = this.appAuthPolicy
      ? await this.appAuthPolicy.getAllowedOrgIds(project.id)
      : [project.org_id];

    const allowedRedirectOrigins = authConfig && this.appAuthPolicy
      ? await this.appAuthPolicy.getAllowedRedirectOrigins(project, authConfig, allowedOrgIds)
      : (authConfig?.allowed_redirect_origins ?? []);

    let resolvedDomainSignupRules: Array<{ domain: string; target_org: string; role: 'member' }> | null = null;
    if (authConfig && this.appAuthPolicy) {
      resolvedDomainSignupRules = await this.appAuthPolicy.resolveDomainSignup(project, authConfig);
    }

    return {
      project_id: project.id,
      org_id: project.org_id,
      branding: this.parseProjectBranding(project.branding),
      auth: authConfig
        ? {
            login_method: authConfig.login_method,
            self_signup: authConfig.self_signup,
            invite_requires_password: authConfig.invite_requires_password,
            allowed_redirect_origins: allowedRedirectOrigins,
            org_access: {
              mode: authConfig.org_access.mode,
              allowed_orgs: allowedOrgIds,
              multi_org: allowedOrgIds.length > 1 || authConfig.org_access.mode === 'allowlist',
              invite_enabled: authConfig.org_access.invite.enabled,
              domain_signup_enabled: authConfig.org_access.domain_signup.enabled,
              domain_signup: {
                enabled: authConfig.org_access.domain_signup.enabled,
                // Resolved rules use canonical org IDs; fall back to the
                // stored shape if resolution failed so the admin can still
                // see what's wrong.
                domains: resolvedDomainSignupRules
                  ?? authConfig.org_access.domain_signup.domains.map((rule) => ({
                    domain: rule.domain,
                    target_org: rule.target_org,
                    role: rule.role,
                  })),
              },
            },
          }
        : null,
    };
  }

  async getAppAccess(projectId: string, userId: string): Promise<AppAccessResponse> {
    if (!this.appAuthPolicy) {
      throw new BadRequestException('App auth policy service is not available');
    }
    return this.appAuthPolicy.getUserAppAccess(projectId, userId);
  }

  async createAppInvite(input: AppInviteRequest, actor: AuthUser): Promise<AppInviteResponse> {
    if (!actor.user_id) {
      throw new UnauthorizedException('User context required');
    }
    if (!this.appAuthPolicy) {
      throw new BadRequestException('App auth policy service is not available');
    }

    await this.appAuthPolicy.assertCanInvite(input.project_id, input.org_id, actor.user_id);

    const project = await this.projects.findById(input.project_id, { include_deleted: false });
    if (!project) {
      throw new BadRequestException(`Project not found: ${input.project_id}`);
    }

    const email = input.email.trim().toLowerCase();
    const existingUser = await this.users.findByEmail(email);
    if (existingUser) {
      const existingMembership = await this.memberships.findOrgMembership(existingUser.id, input.org_id);
      if (existingMembership) {
        return {
          status: 'already_member',
          org_id: input.org_id,
          email,
          role: 'member',
        };
      }
    }

    const pendingInvites = await this.orgInvites.findPendingByIdentityHintForOrg('supabase', email, input.org_id);
    const pending = pendingInvites.find((invite) => (
      invite.app_context?.project_id === project.id
      && invite.app_context?.org_id === input.org_id
    ));
    const branding = this.parseProjectBranding(project.branding);

    if (pending) {
      if (input.resend) {
        await this.sendProjectInviteEmail({
          email,
          projectId: project.id,
          redirectTo: pending.redirect_to ?? input.redirect_to,
          branding,
          expiresAt: pending.expires_at,
          orgId: input.org_id,
        });
      }
      return {
        status: 'pending',
        org_id: input.org_id,
        email,
        role: 'member',
        invite_id: pending.id,
      };
    }

    const inviteCode = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const invite = await this.orgInvites.create({
      org_id: input.org_id,
      created_by: actor.user_id,
      invite_code: inviteCode,
      provider_hint: 'supabase',
      identity_hint: email,
      role: 'member',
      redirect_to: input.redirect_to ?? null,
      app_context: {
        project_id: project.id,
        org_id: input.org_id,
      },
      expires_at: expiresAt,
    });

    await this.sendProjectInviteEmail({
      email,
      projectId: project.id,
      redirectTo: input.redirect_to,
      branding,
      expiresAt,
      orgId: input.org_id,
    });

    return {
      status: 'invited',
      org_id: input.org_id,
      email,
      role: 'member',
      invite_id: invite.id,
    };
  }

  async sendAppMagicLink(input: MagicLinkRequest): Promise<MagicLinkResponse> {
    const project = await this.projects.findById(input.project_id, { include_deleted: false });
    if (!project) {
      throw new BadRequestException(`Project not found: ${input.project_id}`);
    }

    const authConfig = this.parseProjectAuthConfig(project.auth_config);
    if (!authConfig || authConfig.login_method === 'password') {
      throw new BadRequestException('Project is not configured for magic-link login');
    }

    const branding = this.parseProjectBranding(project.branding);
    const email = input.email.trim().toLowerCase();
    const user = await this.users.findByEmail(email);
    const allowedOrgIds = this.appAuthPolicy
      ? await this.appAuthPolicy.getAllowedOrgIds(project.id)
      : [project.org_id];

    // Path A: known user with allowed-org or project membership — branded send.
    if (user) {
      const [orgMemberships, projectMembership] = await Promise.all([
        Promise.all(allowedOrgIds.map((orgId) => this.memberships.findOrgMembership(user.id, orgId))),
        this.memberships.findProjectMembership(user.id, project.id),
      ]);
      if (orgMemberships.some(Boolean) || projectMembership) {
        await this.sendEligibleMagicLink(email, project.id, input.redirect_to, branding);
        return { sent: true };
      }
    }

    const pendingInvites = await this.orgInvites.findPendingByIdentityHintForOrgs(
      'supabase',
      email,
      allowedOrgIds,
    );

    // Path B: pending *explicit* invite — let the invite be the entry point.
    // We deliberately ignore prior domain_signup invites here so we always
    // re-send a fresh magic link when the user retries.
    const explicitPendingInvite = pendingInvites.find(
      (invite) =>
        invite.app_context?.project_id === project.id
        && invite.app_context?.source !== 'domain_signup',
    );
    if (explicitPendingInvite) {
      return { sent: true };
    }

    // Path C (NEW): pre-approved email-domain auto-signup. First-match on
    // the resolved rule list in declaration order — no implicit longest-
    // match. The matched rule's `target_org` becomes the invite's org_id.
    const domainSignupRules = this.appAuthPolicy
      ? await this.appAuthPolicy.resolveDomainSignup(project, authConfig)
      : null;
    const matchedRule = domainSignupRules
      ? domainSignupRules.find((rule) => matchesDomainAllowlist(email, [rule.domain]))
      : null;
    if (matchedRule) {
      const matchedDomain = emailDomain(email);
      const existingDomainInvite = pendingInvites.find(
        (invite) =>
          invite.app_context?.project_id === project.id
          && invite.app_context?.source === 'domain_signup'
          && invite.org_id === matchedRule.target_org,
      );
      if (!existingDomainInvite) {
        await this.orgInvites.create({
          org_id: matchedRule.target_org,
          created_by: null,
          invite_code: randomBytes(24).toString('base64url'),
          provider_hint: 'supabase',
          identity_hint: email,
          role: matchedRule.role,
          redirect_to: input.redirect_to ?? null,
          app_context: {
            project_id: project.id,
            org_id: matchedRule.target_org,
            source: 'domain_signup',
            matched_domain: matchedDomain,
            matched_rule: matchedRule.domain,
          },
          expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000),
        });
        await this.emitDomainSignupEvent(project.id, 'auth.domain_signup.invite_created', {
          org_id: matchedRule.target_org,
          email_domain: matchedDomain,
          matched_rule: matchedRule.domain,
          email_hash: this.hashEmail(email),
        });
      }
      await this.sendEligibleMagicLink(email, project.id, input.redirect_to, branding);
      return { sent: true };
    }

    // Path D: legacy unscoped self-signup escape hatch.
    if (authConfig.self_signup) {
      await this.sendEligibleMagicLink(email, project.id, input.redirect_to, branding);
      return { sent: true };
    }

    // Path E: generic success, no email, no invite written.
    return { sent: true };
  }

  /** Emit a domain-signup audit event through the event spine. Failures are
   *  swallowed so the magic-link send never fails on observability errors. */
  private async emitDomainSignupEvent(
    projectId: string,
    type: 'auth.domain_signup.invite_created' | 'auth.domain_signup.member_attached',
    payload: Record<string, unknown>,
    actor?: { actor_type: 'system' | 'user'; actor_id?: string },
  ): Promise<void> {
    if (!this.events) return;
    try {
      await this.events.create(projectId, {
        type,
        source: 'auth' as never,
        actor_type: (actor?.actor_type ?? 'system') as never,
        actor_id: actor?.actor_id ?? null,
        payload_json: payload as Record<string, unknown>,
      } as never);
    } catch (err) {
      this.logger.warn(
        `Failed to emit ${type} for project=${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Truncated SHA-256 of a lowercased email. Used in audit/log payloads so
   *  PII isn't broadcast at INFO level while preserving deterministic match. */
  private hashEmail(email: string): string {
    const digest = createHash('sha256').update(email.toLowerCase()).digest('hex');
    return `sha256:${digest.slice(0, 12)}`;
  }

  private async sendProjectInviteEmail(input: {
    email: string;
    projectId: string;
    redirectTo?: string | null;
    branding: ProjectBranding | null;
    expiresAt: Date | null;
    orgId?: string | null;
  }): Promise<void> {
    const ssoRedirect = this.buildSsoRedirect(input.projectId, input.redirectTo ?? undefined);
    const gotrueLink = await this.generateInviteLink(input.email, ssoRedirect);
    // Wrap the GoTrue URL so email-security scanners cannot consume the OTP
    // by pre-fetching the link. The user-visible URL is the SSO interstitial.
    const actionLink = await this.wrapActionLink({
      gotrueActionLink: gotrueLink,
      projectId: input.projectId,
      orgId: input.orgId ?? null,
      email: input.email,
      kind: 'invite',
      redirectTo: input.redirectTo ?? null,
    });
    const rendered = renderInviteEmail({
      branding: input.branding,
      actionLink,
      expiresAt: input.expiresAt,
    });
    await this.mailerService.send({
      to: input.email,
      ...rendered,
    });
  }

  private async sendEligibleMagicLink(
    email: string,
    projectId: string,
    redirectTo: string | undefined,
    branding: ProjectBranding | null,
  ): Promise<void> {
    const ssoRedirect = this.buildSsoRedirect(projectId, redirectTo);
    const gotrueLink = await this.generateAuthActionLink('magiclink', email, ssoRedirect);
    // Wrap the GoTrue URL so email-security scanners cannot consume the OTP
    // by pre-fetching the link. The user-visible URL is the SSO interstitial.
    const actionLink = await this.wrapActionLink({
      gotrueActionLink: gotrueLink,
      projectId,
      orgId: null,
      email,
      kind: 'magic_link',
      redirectTo: redirectTo ?? null,
    });
    const rendered = renderAuthActionEmail({
      kind: 'magic_link',
      branding,
      actionLink,
      expiresAt: null,
    });

    // Magic-link delivery preserves "generic success" semantics for account-enumeration defense:
    // a bounced/suppressed recipient must look identical to a successful send to the SSO UI.
    // EmailSuppressedError is swallowed and logged so platform operators can still see the drop.
    // Other auth-email callers (invites, supabase invites) re-throw — admins want to see the error.
    try {
      await this.mailerService.send({
        to: email,
        ...rendered,
      });
    } catch (err) {
      if (err instanceof EmailSuppressedError) {
        this.logger.warn(
          `mail.suppressed_drop kind=magic_link to=${err.to} reason=${err.reason} since=${err.lastUpdate}`,
        );
        return;
      }
      throw err;
    }
  }

  private buildSsoRedirect(projectId: string, redirectTo: string | undefined): string {
    const config = loadConfig();
    const ssoUrl = (config.EVE_SSO_URL ?? process.env.SSO_URL ?? 'http://sso.eve.lvh.me').replace(/\/$/, '');
    const params = new URLSearchParams({ project_id: projectId });
    if (redirectTo) {
      params.set('redirect_to', redirectTo);
    }
    return `${ssoUrl}/?${params.toString()}`;
  }

  private parseProjectBranding(value: Record<string, unknown> | null): ProjectBranding | null {
    if (!value) return null;
    const parsed = ProjectBrandingSchema.safeParse(value);
    if (!parsed.success) {
      this.logger.warn(`Ignoring invalid stored project branding: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  }

  private parseProjectAuthConfig(value: Record<string, unknown> | null): ProjectAuthConfig | null {
    if (!value) return null;
    const parsed = ProjectAuthConfigSchema.safeParse(value);
    if (!parsed.success) {
      this.logger.warn(`Ignoring invalid stored project auth config: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  }

  private toPublicAuthConfig(
    auth: ProjectAuthConfig,
    allowedOrgIds: string[],
    allowedRedirectOrigins: string[] = [],
  ) {
    const { org_access: orgAccess, allowed_redirect_origins: _explicit, ...publicAuth } = auth;
    return {
      ...publicAuth,
      org_access: {
        mode: orgAccess.mode,
        multi_org: allowedOrgIds.length > 1 || orgAccess.mode === 'allowlist',
        invite_enabled: orgAccess.invite.enabled,
        domain_signup_enabled: orgAccess.domain_signup.enabled,
      },
      allowed_redirect_origins: allowedRedirectOrigins,
    };
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
    if (!this.signerKey?.privateKey) {
      throw new Error('Signing key not configured');
    }

    const memberships = await this.memberships.listOrgMembershipsForUser(userId);
    const sortedMemberships = memberships
      .slice()
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    const orgs = sortedMemberships
      .slice(0, this.orgsClaimLimit)
      .map(m => ({ id: m.org_id, role: m.role }));

    const now = Math.floor(Date.now() / 1000);
    const exp = now + (ttlSeconds ?? this.userTokenTtlSeconds);
    const payload: Record<string, unknown> = {
      sub: userId,
      email,
      orgs,
      iat: now,
      exp,
      type: 'user',
    };

    return {
      access_token: createJwtRs256(payload, this.signerKey),
      token_type: 'bearer',
      expires_at: exp,
    };
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
    if (!input.org_id && !input.project_id) {
      throw new BadRequestException('org_id or project_id is required');
    }

    const role = input.role ?? 'member';
    let project = null;
    if (input.project_id) {
      project = await this.projects.findById(input.project_id, { include_deleted: false });
      if (!project) {
        throw new BadRequestException(`Project not found: ${input.project_id}`);
      }
    }

    const orgId = input.org_id ?? project?.org_id;
    if (!orgId) {
      throw new BadRequestException('org_id is required when project_id is not provided');
    }

    if (input.org_id && project && project.org_id !== input.org_id) {
      throw new BadRequestException('project_id does not belong to org_id');
    }

    let user = await this.users.findByEmail(input.email);
    let created = false;
    if (!user) {
      user = await this.users.create({
        id: generateUserId(),
        email: input.email,
        display_name: null,
        is_admin: false,
      });
      created = true;
    }

    await this.memberships.upsertOrgMembership(orgId, user.id, role);
    if (input.project_id) {
      await this.memberships.upsertProjectMembership(input.project_id, user.id, role);
    }

    const ttlSeconds = input.ttl_days
      ? input.ttl_days * 24 * 60 * 60
      : undefined;
    const token = await this.mintUserToken(user.id, user.email ?? undefined, ttlSeconds);
    return {
      ...token,
      user_id: user.id,
      created,
      org_id: orgId,
      project_id: input.project_id ?? null,
      role,
    };
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
    if (!this.signerKey) {
      throw new UnauthorizedException('Auth is not configured');
    }

    const payload = verifyJwtRs256(token, this.keys);
    if (payload.type !== 'app_link') {
      throw new UnauthorizedException('Invalid token type');
    }

    const sub = payload.sub as string | undefined;
    if (typeof sub !== 'string' || !sub.startsWith('app_link:')) {
      throw new UnauthorizedException('Invalid app-link token subject');
    }
    const subscriptionId = payload.subscription_id as string | undefined;
    if (typeof subscriptionId !== 'string' || sub !== `app_link:${subscriptionId}`) {
      throw new UnauthorizedException('Invalid app-link subscription claim');
    }
    if (typeof payload.consumer_project_id !== 'string') {
      throw new UnauthorizedException('App-link token missing consumer_project_id');
    }
    if (typeof payload.consumer_org_id !== 'string') {
      throw new UnauthorizedException('App-link token missing consumer_org_id');
    }
    if (typeof payload.consumer_principal !== 'string') {
      throw new UnauthorizedException('App-link token missing consumer_principal');
    }
    if (payload.consumer_env !== null && payload.consumer_env !== undefined && typeof payload.consumer_env !== 'string') {
      throw new UnauthorizedException('Invalid app-link consumer_env');
    }
    if (typeof payload.producer_project_id !== 'string') {
      throw new UnauthorizedException('App-link token missing producer_project_id');
    }
    if (typeof payload.producer_env !== 'string') {
      throw new UnauthorizedException('App-link token missing producer_env');
    }
    if (typeof payload.api_name !== 'string') {
      throw new UnauthorizedException('App-link token missing api_name');
    }
    if (payload.aud !== `project:${payload.producer_project_id}`) {
      throw new UnauthorizedException('Invalid app-link token audience');
    }

    const scopes = payload.scopes as unknown;
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string') || scopes.length === 0) {
      throw new UnauthorizedException('Invalid app-link token scopes');
    }
    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
      throw new UnauthorizedException('Invalid token timestamps');
    }

    const subscription = await this.appLinkSubscriptions.findWithGrantsById(subscriptionId);
    if (!subscription || !subscription.api_grant) {
      throw new UnauthorizedException('App-link subscription not found');
    }
    const grant = subscription.api_grant;
    if (grant.revoked_at) {
      throw new UnauthorizedException('App-link grant is revoked');
    }
    if (subscription.consumer_project_id !== payload.consumer_project_id) {
      throw new UnauthorizedException('App-link consumer mismatch');
    }
    if (grant.producer_project_id !== payload.producer_project_id) {
      throw new UnauthorizedException('App-link producer mismatch');
    }
    if (grant.export_name !== payload.api_name) {
      throw new UnauthorizedException('App-link API mismatch');
    }
    const missingScopes = (scopes as string[]).filter((scope) => !subscription.requested_scopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new UnauthorizedException('App-link token scopes exceed subscription');
    }
    if (grant.envs.length > 0 && !grant.envs.includes(payload.producer_env as string)) {
      throw new UnauthorizedException('App-link producer environment is not granted');
    }

    return {
      sub,
      subscription_id: subscriptionId,
      consumer_project_id: payload.consumer_project_id as string,
      consumer_org_id: payload.consumer_org_id as string,
      consumer_principal: payload.consumer_principal as string,
      consumer_env: (payload.consumer_env as string | null | undefined) ?? null,
      producer_project_id: payload.producer_project_id as string,
      producer_env: payload.producer_env as string,
      api_name: payload.api_name as string,
      scopes: scopes as string[],
      aud: payload.aud as string,
      exp: payload.exp,
      iat: payload.iat,
      type: 'app_link',
    };
  }

  async getBootstrapStatus(): Promise<BootstrapStatus> {
    const config = loadConfig();
    const isProduction = config.NODE_ENV === 'production';
    const existingAdmin = await this.users.findFirstAdmin();
    const completed = Boolean(existingAdmin);

    // If bootstrap already completed, return early
    if (completed) {
      return {
        completed: true,
        windowOpen: false,
        windowClosesAt: null,
        requiresToken: false,
        mode: 'closed',
      };
    }

    if (isProduction) {
      if (!this.bootstrapToken) {
        return {
          completed: false,
          windowOpen: false,
          windowClosesAt: null,
          requiresToken: true,
          mode: 'closed',
        };
      }

      return {
        completed: false,
        windowOpen: true,
        windowClosesAt: null,
        requiresToken: true,
        mode: 'secure',
      };
    }

    // Secure mode: EVE_BOOTSTRAP_TOKEN is set
    if (this.bootstrapToken) {
      return {
        completed: false,
        windowOpen: true,
        windowClosesAt: null,
        requiresToken: true,
        mode: 'secure',
      };
    }

    const windowMs = this.bootstrapWindowMinutes * 60 * 1000;

    // Check recovery mode: trigger file exists and was modified within window
    const triggerFileStatus = this.checkTriggerFile();
    if (triggerFileStatus.exists && triggerFileStatus.withinWindow) {
      const windowClosesAt = new Date(triggerFileStatus.mtime! + windowMs);
      return {
        completed: false,
        windowOpen: true,
        windowClosesAt,
        requiresToken: false,
        mode: 'recovery',
      };
    }

    // Check auto-open mode: within startup window
    const apiWindowClosesAt = new Date(API_START_TIME + windowMs);
    const withinStartupWindow = Date.now() < apiWindowClosesAt.getTime();

    if (withinStartupWindow) {
      return {
        completed: false,
        windowOpen: true,
        windowClosesAt: apiWindowClosesAt,
        requiresToken: false,
        mode: 'auto-open',
      };
    }

    // Window closed
    return {
      completed: false,
      windowOpen: false,
      windowClosesAt: null,
      requiresToken: false,
      mode: 'closed',
    };
  }

  private checkTriggerFile(): { exists: boolean; withinWindow: boolean; mtime?: number } {
    try {
      if (!existsSync(this.bootstrapTriggerFile)) {
        return { exists: false, withinWindow: false };
      }

      const stats = statSync(this.bootstrapTriggerFile);
      const mtime = stats.mtimeMs;
      const windowMs = this.bootstrapWindowMinutes * 60 * 1000;
      const withinWindow = Date.now() - mtime < windowMs;

      return { exists: true, withinWindow, mtime };
    } catch {
      return { exists: false, withinWindow: false };
    }
  }

  private cleanupTriggerFile(): void {
    try {
      if (existsSync(this.bootstrapTriggerFile)) {
        unlinkSync(this.bootstrapTriggerFile);
      }
    } catch {
      // Ignore cleanup errors - file may have been deleted or permission issues
    }
  }

  async bootstrapAdmin(input: { token?: string; email: string; public_key: string; display_name?: string }) {
    const config = loadConfig();
    const bootstrapStatus = await this.getBootstrapStatus();

    if (bootstrapStatus.completed) {
      // Non-production mode: allow re-bootstrap and return existing admin token
      if (config.NODE_ENV !== 'production') {
        const existingAdmin = await this.users.findFirstAdmin();
        if (existingAdmin) {
          const token = await this.mintUserToken(existingAdmin.id, existingAdmin.email);
          return { ...token, user_id: existingAdmin.id };
        }
      }
      throw new ForbiddenException('Bootstrap already completed');
    }

    if (bootstrapStatus.requiresToken) {
      // Secure mode - verify token
      if (!input.token || !this.bootstrapToken || !safeEqual(input.token, this.bootstrapToken)) {
        throw new UnauthorizedException('Invalid bootstrap token');
      }
    } else if (!bootstrapStatus.windowOpen) {
      if (config.NODE_ENV === 'production') {
        throw new ForbiddenException(
          'Bootstrap window closed. Set EVE_BOOTSTRAP_TOKEN to enable bootstrap.',
        );
      }
      throw new ForbiddenException(
        'Bootstrap window closed. Set EVE_BOOTSTRAP_TOKEN or create trigger file on host.',
      );
    }

    const userId = generateUserId();
    const user = await this.users.create({
      id: userId,
      email: input.email,
      display_name: input.display_name ?? null,
      is_admin: true,
    });

    const fingerprint = fingerprintPublicKey(input.public_key);
    await this.identities.create({
      id: generateIdentityId(),
      user_id: user.id,
      provider: 'github_ssh',
      public_key: input.public_key,
      fingerprint,
      label: 'bootstrap',
    });

    // Clean up trigger file if it was used (recovery mode)
    if (bootstrapStatus.mode === 'recovery') {
      this.cleanupTriggerFile();
    }

    const token = await this.mintUserToken(user.id, user.email);
    return { ...token, user_id: user.id };
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
        return this.authUserFromUser(user);
      }
    }

    // 2. Search by fingerprint across all providers
    const identities = await this.identities.findAllByFingerprint(verified.externalId);
    const match = identities.find((i) => i.provider === verified.provider);
    if (match) {
      const user = await this.users.findById(match.user_id);
      if (user) {
        return this.authUserFromUser(user);
      }
    }

    // 3. Invite-gated provisioning
    const provisioned = await this.provisionViaInvite(verified);
    if (provisioned) {
      return this.authUserFromUser(provisioned);
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

  private async authUserFromUser(user: { id: string; email: string; is_admin: boolean }): Promise<AuthUser> {
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

function loadKeyRing(config: ReturnType<typeof loadConfig>): KeyEntry[] {
  const keys: KeyEntry[] = [];
  const privateKeyPem = loadKeyValue(config.EVE_AUTH_PRIVATE_KEY);
  const publicKeyPem = loadKeyValue(config.EVE_AUTH_PUBLIC_KEY);
  const oldPublicKeyPem = loadKeyValue(config.EVE_AUTH_PUBLIC_KEY_OLD);

  if (privateKeyPem) {
    const privateKey = createPrivateKey(privateKeyPem);
    const publicKey = publicKeyPem ? createPublicKey(publicKeyPem) : createPublicKey(privateKey);
    keys.push({ kid: config.EVE_AUTH_KEY_ID, privateKey, publicKey });
  } else if (publicKeyPem) {
    keys.push({ kid: config.EVE_AUTH_KEY_ID, publicKey: createPublicKey(publicKeyPem) });
  }

  if (oldPublicKeyPem) {
    keys.push({ kid: config.EVE_AUTH_KEY_ID_OLD, publicKey: createPublicKey(oldPublicKeyPem) });
  }

  return keys;
}

function loadKeyValue(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.includes('-----BEGIN')) return value;
  if (existsSync(value)) {
    return readFileSync(value, 'utf8');
  }
  return value;
}

function createJwtRs256(payload: Record<string, unknown>, key: KeyEntry): string {
  const header: JwtHeader = { alg: 'RS256', typ: 'JWT', kid: key.kid };
  const encodedHeader = encodeJwtSegment(header);
  const encodedPayload = encodeJwtSegment(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key.privateKey as KeyObject).toString('base64url');
  return `${signingInput}.${signature}`;
}

function verifyJwtRs256(token: string, keys: KeyEntry[]): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new UnauthorizedException('Invalid token format');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtSegment<JwtHeader>(encodedHeader, 'Invalid token header');
  if (header.alg !== 'RS256') {
    throw new UnauthorizedException('Unsupported token algorithm');
  }

  const candidates = header.kid
    ? keys.filter((key) => key.kid === header.kid)
    : keys;

  if (candidates.length === 0) {
    throw new UnauthorizedException('No matching key for token');
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = Buffer.from(encodedSignature, 'base64url');

  let verified = false;
  for (const candidate of candidates) {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    verifier.end();
    if (verifier.verify(candidate.publicKey, signature)) {
      verified = true;
      break;
    }
  }

  if (!verified) {
    throw new UnauthorizedException('Invalid token signature');
  }

  const payload = decodeJwtSegment<JwtPayload>(encodedPayload, 'Invalid token payload');
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw new UnauthorizedException('Token expired');
  }

  if (typeof payload.nbf === 'number' && payload.nbf > now) {
    throw new UnauthorizedException('Token not active');
  }

  return payload;
}

function verifyJwtHs256(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new UnauthorizedException('Invalid token format');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtSegment<JwtHeader>(encodedHeader, 'Invalid token header');
  if (header.alg !== 'HS256') {
    throw new UnauthorizedException('Unsupported token algorithm');
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');

  if (!safeEqual(encodedSignature, expectedSignature)) {
    throw new UnauthorizedException('Invalid token signature');
  }

  const payload = decodeJwtSegment<JwtPayload>(encodedPayload, 'Invalid token payload');
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw new UnauthorizedException('Token expired');
  }

  if (typeof payload.nbf === 'number' && payload.nbf > now) {
    throw new UnauthorizedException('Token not active');
  }

  return payload;
}

function encodeJwtSegment(value: Record<string, unknown>): string {
  const json = JSON.stringify(value);
  return Buffer.from(json, 'utf8').toString('base64url');
}

function decodeJwtSegment<T>(segment: string, errorMessage: string): T {
  try {
    return JSON.parse(base64UrlDecode(segment)) as T;
  } catch {
    throw new UnauthorizedException(errorMessage);
  }
}

/** Decode JWT payload without signature verification — used only to peek at token type. */
function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as JwtPayload;
  } catch {
    return null;
  }
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function fingerprintPublicKey(publicKey: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'eve-auth-'));
  const keyPath = join(tmpDir, 'key.pub');
  try {
    writeFileSync(keyPath, publicKey, { mode: 0o600 });
    const result = spawnSync('ssh-keygen', ['-lf', keyPath], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) {
      throw new Error(`ssh-keygen failed: ${result.stderr || 'unknown error'}`);
    }
    const parts = result.stdout.trim().split(' ');
    if (parts.length < 2) {
      throw new Error('Failed to parse ssh-keygen output');
    }
    return parts[1];
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function verifySshSignature(publicKey: string, nonce: string, signature: string, principal: string): boolean {
  const tmpDir = mkdtempSync(join(tmpdir(), 'eve-ssh-'));
  const allowedSignersPath = join(tmpDir, 'allowed_signers');
  const signaturePath = join(tmpDir, 'signature');

  try {
    writeFileSync(allowedSignersPath, `${principal} ${publicKey}\n`, { mode: 0o600 });
    writeFileSync(signaturePath, signature, { mode: 0o600 });

    // ssh-keygen -Y verify reads the message from stdin, not as a positional argument
    const result = spawnSync(
      'ssh-keygen',
      ['-Y', 'verify', '-f', allowedSignersPath, '-I', principal, '-n', 'eve-auth', '-s', signaturePath],
      { input: nonce, encoding: 'utf8' },
    );

    return result.status === 0;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
