import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  loadConfig,
  generateUserId,
  type AppInviteRequest,
  type AppInviteResponse,
  type AppAuthContextResponse,
  type AppAuthContextAdminResponse,
  type ProjectAuthConfig,
} from '@eve/shared';
import {
  type Db,
  userQueries,
  membershipQueries,
  projectQueries,
  appLinkSubscriptionQueries,
  orgInviteQueries,
  type MembershipRole,
} from '@eve/db';
import { AppAuthPolicyService } from './app-auth-policy.service.js';
import { MagicLinkService } from './magic-link.service.js';
import {
  type KeyEntry,
  loadKeyRing,
  createJwtRs256,
  verifyJwtRs256,
  parseProjectAuthConfig,
  parseProjectBranding,
} from './auth.util.js';
import type { AuthUser, AppLinkTokenPayload } from './auth.types.js';

/**
 * App-facing auth context, app invites, user-token minting, and app-link
 * token verification. Extracted verbatim from AuthService (refactor batch
 * R-C3); AuthService delegates here.
 */
@Injectable()
export class AppAuthService {
  private readonly logger = new Logger(AppAuthService.name);
  private readonly keys: KeyEntry[];
  private readonly signerKey?: KeyEntry;
  private readonly users: ReturnType<typeof userQueries>;
  private readonly memberships: ReturnType<typeof membershipQueries>;
  private readonly projects: ReturnType<typeof projectQueries>;
  private readonly appLinkSubscriptions: ReturnType<typeof appLinkSubscriptionQueries>;
  private readonly orgInvites: ReturnType<typeof orgInviteQueries>;
  private readonly userTokenTtlSeconds: number;
  private readonly orgsClaimLimit: number;

  constructor(
    @Inject('DB') db: Db,
    private readonly magicLink: MagicLinkService,
    private readonly appAuthPolicy?: AppAuthPolicyService,
  ) {
    const config = loadConfig();
    this.keys = loadKeyRing(config);
    this.signerKey = this.keys.find((key) => key.privateKey);
    this.users = userQueries(db);
    this.memberships = membershipQueries(db);
    this.projects = projectQueries(db);
    this.appLinkSubscriptions = appLinkSubscriptionQueries(db);
    this.orgInvites = orgInviteQueries(db);
    this.userTokenTtlSeconds = config.EVE_AUTH_TOKEN_TTL_DAYS * 24 * 60 * 60;
    this.orgsClaimLimit = config.EVE_AUTH_ORGS_CLAIM_LIMIT;
  }

  async getAppAuthContext(projectId: string): Promise<AppAuthContextResponse> {
    const project = await this.projects.findById(projectId, { include_deleted: false });
    if (!project) {
      throw new BadRequestException(`Project not found: ${projectId}`);
    }
    const authConfig = parseProjectAuthConfig(this.logger, project.auth_config);
    const allowedOrgIds = this.appAuthPolicy
      ? await this.appAuthPolicy.getAllowedOrgIds(project.id)
      : [project.org_id];

    const allowedRedirectOrigins = authConfig && this.appAuthPolicy
      ? await this.appAuthPolicy.getAllowedRedirectOrigins(project, authConfig, allowedOrgIds)
      : (authConfig?.allowed_redirect_origins ?? []);

    return {
      project_id: project.id,
      org_id: project.org_id,
      branding: parseProjectBranding(this.logger, project.branding),
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
    const authConfig = parseProjectAuthConfig(this.logger, project.auth_config);
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
      branding: parseProjectBranding(this.logger, project.branding),
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
    const branding = parseProjectBranding(this.logger, project.branding);

    if (pending) {
      if (input.resend) {
        await this.magicLink.sendProjectInviteEmail({
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

    await this.magicLink.sendProjectInviteEmail({
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
    const role = input.role ?? 'member';
    const orgId = await this.resolveMintTargetOrg(input);
    const { user, created } = await this.findOrCreateUser(input.email);
    await this.resolveMembership(orgId, user.id, role, input.project_id);

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

  /** Validate the org/project pair for an admin token mint and resolve the target org. */
  private async resolveMintTargetOrg(input: { org_id?: string; project_id?: string }): Promise<string> {
    if (!input.org_id && !input.project_id) {
      throw new BadRequestException('org_id or project_id is required');
    }

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

    return orgId;
  }

  /** Find the user by email or create a non-admin account for them. */
  private async findOrCreateUser(email: string) {
    let user = await this.users.findByEmail(email);
    let created = false;
    if (!user) {
      user = await this.users.create({
        id: generateUserId(),
        email,
        display_name: null,
        is_admin: false,
      });
      created = true;
    }
    return { user, created };
  }

  /** Upsert the org membership (and project membership when scoped to a project). */
  private async resolveMembership(
    orgId: string,
    userId: string,
    role: MembershipRole,
    projectId?: string,
  ): Promise<void> {
    await this.memberships.upsertOrgMembership(orgId, userId, role);
    if (projectId) {
      await this.memberships.upsertProjectMembership(projectId, userId, role);
    }
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
}
