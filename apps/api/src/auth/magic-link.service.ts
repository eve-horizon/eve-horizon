import {
  Injectable,
  Logger,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  loadConfig,
  generateMagicLinkWrapId,
  type MagicLinkRequest,
  type MagicLinkResponse,
  type ProjectBranding,
} from '@eve/shared';
import {
  type Db,
  userQueries,
  membershipQueries,
  projectQueries,
  orgInviteQueries,
  magicLinkWrapQueries,
  type MagicLinkWrapKind,
} from '@eve/db';
import { MailerService } from '../mailer/mailer.service.js';
import { EmailSuppressedError } from '../mailer/errors.js';
import { renderAuthActionEmail, renderInviteEmail } from '../mailer/templates/invite.js';
import { AppAuthPolicyService } from './app-auth-policy.service.js';
import { EventsService } from '../events/events.service.js';
import { emailDomain, matchesDomainAllowlist } from './email-domain.js';
import { hashEmail, parseProjectAuthConfig, parseProjectBranding } from './auth.util.js';

/**
 * GoTrue action-link generation, scanner-safe magic-link wraps, and app
 * magic-link / invite email delivery. Extracted verbatim from AuthService
 * (refactor batch R-C3); AuthService delegates here.
 */
@Injectable()
export class MagicLinkService {
  private readonly logger = new Logger(MagicLinkService.name);
  private readonly users: ReturnType<typeof userQueries>;
  private readonly memberships: ReturnType<typeof membershipQueries>;
  private readonly projects: ReturnType<typeof projectQueries>;
  private readonly orgInvites: ReturnType<typeof orgInviteQueries>;
  private readonly magicLinkWraps: ReturnType<typeof magicLinkWrapQueries>;

  constructor(
    @Inject('DB') db: Db,
    private readonly mailerService: MailerService,
    private readonly appAuthPolicy?: AppAuthPolicyService,
    private readonly events?: EventsService,
  ) {
    this.users = userQueries(db);
    this.memberships = membershipQueries(db);
    this.projects = projectQueries(db);
    this.orgInvites = orgInviteQueries(db);
    this.magicLinkWraps = magicLinkWrapQueries(db);
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
      email_hash: hashEmail(input.email),
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

  async sendAppMagicLink(input: MagicLinkRequest): Promise<MagicLinkResponse> {
    const project = await this.projects.findById(input.project_id, { include_deleted: false });
    if (!project) {
      throw new BadRequestException(`Project not found: ${input.project_id}`);
    }

    const authConfig = parseProjectAuthConfig(this.logger, project.auth_config);
    if (!authConfig || authConfig.login_method === 'password') {
      throw new BadRequestException('Project is not configured for magic-link login');
    }

    const branding = parseProjectBranding(this.logger, project.branding);
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
          email_hash: hashEmail(email),
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
  async emitDomainSignupEvent(
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

  async sendProjectInviteEmail(input: {
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
}
