import { Injectable, Inject, BadRequestException, NotFoundException, ConflictException, ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { resolveWorkerUrl } from '../common/worker-url';
import { randomBytes } from 'crypto';
import type { Db } from '@eve/db';
import { orgQueries, type Org, membershipQueries, userQueries, agentQueries, spendQueries, projectQueries, environmentQueries, orgInviteQueries } from '@eve/db';
import {
  generateOrgId,
  generateUserId,
  OrgSlugSchema,
  type CreateOrgRequest,
  type OrgListResponse,
  type OrgResponse,
  type OrgSpendResponse,
  type UpdateOrgRequest,
  type OrgAgentDirectoryResponse,
  type OrgMemberRequest,
  type OrgMemberResponse,
  type OrgMemberListResponse,
  type OrgInviteResponse,
  type OrgInviteListResponse,
  ProjectBrandingSchema,
  type ProjectBranding,
} from '@eve/shared';
import { AuthService } from '../auth/auth.service.js';
import { MailerService } from '../mailer/mailer.service.js';
import { renderInviteEmail } from '../mailer/templates/invite.js';

@Injectable()
export class OrgsService {
  private readonly logger = new Logger(OrgsService.name);
  private orgs: ReturnType<typeof orgQueries>;
  private memberships: ReturnType<typeof membershipQueries>;
  private users: ReturnType<typeof userQueries>;
  private agents: ReturnType<typeof agentQueries>;
  private spend: ReturnType<typeof spendQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private envs: ReturnType<typeof environmentQueries>;
  private orgInvites: ReturnType<typeof orgInviteQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly authService: AuthService,
    private readonly mailerService: MailerService,
  ) {
    this.orgs = orgQueries(db);
    this.memberships = membershipQueries(db);
    this.users = userQueries(db);
    this.agents = agentQueries(db);
    this.spend = spendQueries(db);
    this.projects = projectQueries(db);
    this.envs = environmentQueries(db);
    this.orgInvites = orgInviteQueries(db);
  }

  private normalizeSlugBase(name: string): string {
    const alphanumeric = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!/^[a-z]/.test(alphanumeric) || alphanumeric.length < 2) {
      throw new BadRequestException(
        `Cannot generate slug from name "${name}". Name must contain at least 2 alphanumeric characters starting with a letter. Provide a custom slug instead.`
      );
    }

    return alphanumeric;
  }

  private buildSlug(base: string, suffix?: string): string {
    const suffixText = suffix ? suffix.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    const maxBaseLength = Math.max(2, 12 - suffixText.length);
    const slug = suffixText ? `${base.slice(0, maxBaseLength)}${suffixText}` : base.slice(0, 12);
    const parsed = OrgSlugSchema.safeParse(slug);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    return slug;
  }

  private async generateUniqueSlug(name: string): Promise<string> {
    const base = this.normalizeSlugBase(name);
    let candidate = this.buildSlug(base);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await this.orgs.findBySlug(candidate, { include_deleted: true });
      if (!existing) {
        return candidate;
      }

      const suffixLength = Math.min(4, 2 + attempt);
      const suffix = Math.random().toString(36).slice(2, 2 + suffixLength);
      candidate = this.buildSlug(base, suffix);
    }

    throw new ConflictException(
      `Organization slug generated from name "${name}" already exists. Provide a custom slug instead.`
    );
  }

  async create(data: CreateOrgRequest, actorUserId?: string): Promise<OrgResponse> {
    const id = data.id ?? generateOrgId();
    let slug = data.slug ?? await this.generateUniqueSlug(data.name);
    let org: Org;
    try {
      org = await this.orgs.create({ id, name: data.name, slug });
    } catch (error) {
      if (!data.slug && isUniqueViolation(error)) {
        slug = await this.generateUniqueSlug(data.name);
        org = await this.orgs.create({ id, name: data.name, slug });
      } else {
        throw error;
      }
    }

    await this.assignOwner(org.id, data.owner_user_id, actorUserId);
    return this.toResponse(org);
  }

  async ensure(data: CreateOrgRequest, actorUserId?: string): Promise<OrgResponse> {
    const hasSlug = typeof data.slug === 'string' && data.slug.length > 0;
    let slug = hasSlug ? data.slug! : await this.generateUniqueSlug(data.name);

    // Phase 1: Try to find an existing org that matches
    const existing = await this.findMatchingOrg(data, slug, hasSlug);
    if (existing) {
      return this.restoreOrReturn(existing);
    }

    // Phase 2: Create new org with owner membership
    const id = data.id ?? generateOrgId();
    try {
      const org = await this.orgs.create({ id, name: data.name, slug });
      await this.assignOwner(org.id, data.owner_user_id, actorUserId);
      return this.toResponse(org);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Race condition — another request created a conflicting org.
      // Re-run lookup to find the winner.
      const raced = await this.findMatchingOrg(data, slug, hasSlug);
      if (raced) {
        return this.restoreOrReturn(raced);
      }

      // Slug collision (not our org) — retry with a generated slug
      if (!hasSlug) {
        slug = await this.generateUniqueSlug(data.name);
        const org = await this.orgs.create({ id, name: data.name, slug });
        await this.assignOwner(org.id, data.owner_user_id, actorUserId);
        return this.toResponse(org);
      }

      throw error;
    }
  }

  /**
   * Look up an existing org by slug, id, or name (in priority order).
   * Validates compatibility with the requested data, throwing ConflictException if mismatched.
   */
  private async findMatchingOrg(
    data: CreateOrgRequest,
    slug: string,
    hasSlug: boolean,
  ): Promise<Org | null> {
    if (hasSlug) {
      const bySlug = await this.orgs.findBySlug(slug, { include_deleted: true });
      if (bySlug) {
        if (data.id && bySlug.id !== data.id) {
          throw new ConflictException(`Organization slug ${slug} already exists`);
        }
        if (!isSameOrgName(bySlug.name, data.name)) {
          throw new ConflictException(`Organization slug ${slug} already exists with a different name`);
        }
        return bySlug;
      }
    }

    if (data.id) {
      const byId = await this.orgs.findById(data.id, { include_deleted: true });
      if (byId) {
        if (!isSameOrgName(byId.name, data.name)) {
          throw new ConflictException(`Organization ${data.id} already exists with a different name`);
        }
        if (hasSlug && byId.slug && byId.slug !== slug) {
          throw new ConflictException(`Organization ${data.id} already exists with a different slug`);
        }
        return byId;
      }
    }

    const byName = await this.orgs.findByName(data.name, { include_deleted: true });
    if (byName) {
      if (data.id && byName.id !== data.id) {
        throw new ConflictException(`Organization name ${data.name} already exists`);
      }
      if (hasSlug && byName.slug && byName.slug !== slug) {
        throw new ConflictException(`Organization name ${data.name} already exists with a different slug`);
      }
      return byName;
    }

    return null;
  }

  private async restoreOrReturn(org: Org): Promise<OrgResponse> {
    if (org.deleted_at !== null) {
      const restored = await this.orgs.update(org.id, { deleted: false });
      if (!restored) {
        throw new NotFoundException(`Organization ${org.id} not found`);
      }
      return this.toResponse(restored);
    }
    return this.toResponse(org);
  }

  private async assignOwner(
    orgId: string,
    ownerUserId: string | undefined,
    actorUserId: string | undefined,
  ): Promise<void> {
    const targetUserId = ownerUserId ?? actorUserId;
    if (!targetUserId) return;
    const user = await this.users.findById(targetUserId);
    if (user) {
      await this.memberships.upsertOrgMembership(orgId, targetUserId, 'owner');
    }
  }

  async getSpend(
    orgId: string,
    options: { since?: Date; until?: Date; currency?: string },
  ): Promise<OrgSpendResponse> {
    const org = await this.orgs.findById(orgId, { include_deleted: false });
    if (!org) {
      throw new NotFoundException(`Organization ${orgId} not found`);
    }

    const summary = await this.spend.sumOrgSpend(org.id, {
      since: options.since,
      until: options.until,
      billed_currency: options.currency,
    });

    return {
      org_id: org.id,
      summary: {
        since: summary.since,
        until: summary.until,
        base_total_usd: summary.base_total_usd,
        billed_total: summary.billed_total,
        billed_currency: summary.billed_currency,
        attempts: summary.attempts,
      },
    };
  }

  async list(options: {
    limit: number;
    offset: number;
    include_deleted: boolean;
    name?: string;
    user_id?: string;
  }): Promise<OrgListResponse> {
    const orgs = options.user_id
      ? await this.memberships.listOrgsForUser(options.user_id, {
          limit: options.limit,
          offset: options.offset,
          include_deleted: options.include_deleted,
        })
      : await this.orgs.list({
          limit: options.limit,
          offset: options.offset,
          include_deleted: options.include_deleted,
          name: options.name,
        });

    return {
      data: orgs.map((org) => this.toResponse(org)),
      pagination: {
        limit: options.limit,
        offset: options.offset,
        count: orgs.length,
      },
    };
  }

  async findById(id: string, includeDeleted = false): Promise<OrgResponse | null> {
    const org = await this.orgs.findById(id, { include_deleted: includeDeleted });
    return org ? this.toResponse(org) : null;
  }

  async update(id: string, updates: UpdateOrgRequest): Promise<OrgResponse> {
    if (
      updates.name === undefined
      && updates.deleted === undefined
      && updates.default_agent_slug === undefined
      && updates.billing_config === undefined
    ) {
      throw new BadRequestException('No updates provided');
    }

    let defaultAgentSlug = updates.default_agent_slug;
    if (defaultAgentSlug !== undefined) {
      if (defaultAgentSlug === null) {
        // allow clearing
      } else {
        defaultAgentSlug = defaultAgentSlug.trim().toLowerCase();
        if (defaultAgentSlug.length === 0) {
          defaultAgentSlug = null;
        } else {
          const agent = await this.agents.findByOrgAndSlug(id, defaultAgentSlug);
          if (!agent) {
            throw new BadRequestException(`Agent slug ${defaultAgentSlug} not found in org`);
          }
        }
      }
    }

    const updated = await this.orgs.update(id, {
      name: updates.name,
      deleted: updates.deleted,
      default_agent_slug: defaultAgentSlug === undefined ? undefined : defaultAgentSlug,
      billing_config: updates.billing_config,
    });
    if (!updated) {
      throw new NotFoundException(`Organization ${id} not found`);
    }
    return this.toResponse(updated);
  }

  async listAgentDirectory(orgId: string, options?: { client?: string }): Promise<OrgAgentDirectoryResponse> {
    const org = await this.orgs.findById(orgId);
    if (!org) {
      throw new NotFoundException(`Organization ${orgId} not found`);
    }

    const allAgents = await this.agents.listDirectoryByOrg(orgId);

    // Filter out agents with gateway_policy = 'none' (hidden from directory)
    let visible = allAgents.filter(
      (agent) => agent.gateway_policy !== 'none',
    );

    // Optionally filter by client restriction
    if (options?.client) {
      visible = visible.filter(
        (agent) =>
          agent.gateway_clients === null ||
          agent.gateway_clients.includes(options.client!),
      );
    }

    return {
      org_id: orgId,
      default_agent_slug: org.default_agent_slug ?? null,
      agents: visible.map((agent) => ({
        project_id: agent.project_id,
        project_slug: agent.project_slug,
        project_name: agent.project_name,
        agent_id: agent.agent_id,
        agent_slug: agent.agent_slug,
        agent_alias: agent.agent_alias,
        agent_name: agent.agent_name,
        agent_description: agent.agent_description,
        role: agent.role,
        workflow: agent.workflow,
        gateway_policy: agent.gateway_policy as 'discoverable' | 'routable',
      })),
    };
  }

  async addMember(orgId: string, input: OrgMemberRequest): Promise<OrgMemberResponse> {
    let user = input.user_id
      ? await this.users.findById(input.user_id)
      : input.email
        ? await this.users.findByEmail(input.email)
        : null;

    if (!user) {
      if (!input.email) {
        throw new NotFoundException('User not found');
      }

      user = await this.users.create({
        id: generateUserId(),
        email: input.email,
        display_name: null,
        is_admin: false,
      });
    }

    const membership = await this.memberships.upsertOrgMembership(orgId, user.id, input.role);
    return this.toMemberResponse({ ...membership, email: user.email, display_name: user.display_name });
  }

  async listMembers(orgId: string): Promise<OrgMemberListResponse> {
    const members = await this.memberships.listOrgMembers(orgId);
    return { data: members.map((member) => this.toMemberResponse(member)) };
  }

  async searchMembers(orgId: string, query: string): Promise<OrgMemberListResponse> {
    const members = await this.memberships.searchOrgMembers(orgId, query);
    return { data: members.map((member) => this.toMemberResponse(member)) };
  }

  async removeMember(orgId: string, userId: string): Promise<void> {
    // Prevent removing the last owner
    const members = await this.memberships.listOrgMembers(orgId);
    const owners = members.filter((m) => m.role === 'owner');
    const isOwner = owners.some((m) => m.user_id === userId);
    if (isOwner && owners.length <= 1) {
      throw new ForbiddenException('Cannot remove the last owner of an organization');
    }

    const removed = await this.memberships.removeOrgMembership(orgId, userId);
    if (!removed) {
      throw new NotFoundException(`Member ${userId} not found in org ${orgId}`);
    }
  }

  // ── Org-Scoped Invites ───────────────────────────────────────────────

  async createOrgInvite(
    orgId: string,
    createdBy: string,
    body: {
      email: string;
      role?: 'owner' | 'admin' | 'member';
      send_email?: boolean;
      redirect_to?: string;
      app_context?: Record<string, unknown>;
      project_id?: string;
    },
  ): Promise<OrgInviteResponse> {
    const inviteCode = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 3 days
    let branding: ProjectBranding | null = null;

    if (body.project_id) {
      const project = await this.projects.findById(body.project_id);
      if (!project || project.org_id !== orgId) {
        throw new BadRequestException(`Project ${body.project_id} not found in org ${orgId}`);
      }

      if (project.branding) {
        const parsed = ProjectBrandingSchema.safeParse(project.branding);
        if (parsed.success) {
          branding = parsed.data;
        } else {
          this.logger.warn(`Ignoring invalid branding stored for project ${project.id}: ${parsed.error.message}`);
        }
      }
    }

    const invite = await this.orgInvites.create({
      org_id: orgId,
      created_by: createdBy,
      invite_code: inviteCode,
      provider_hint: 'supabase',
      identity_hint: body.email,
      role: body.role ?? 'member',
      redirect_to: body.redirect_to ?? null,
      app_context: body.project_id
        ? { ...(body.app_context ?? {}), project_id: body.project_id }
        : body.app_context ?? null,
      expires_at: expiresAt,
    });

    if (body.send_email !== false) {
      // Build the redirect chain: GoTrue → SSO callback → target app
      const finalRedirect = body.redirect_to ?? '';
      const ssoParams = new URLSearchParams();
      if (body.project_id) ssoParams.set('project_id', body.project_id);
      if (finalRedirect) ssoParams.set('redirect_to', finalRedirect);
      const ssoQuery = ssoParams.toString();
      const ssoRedirect = ssoQuery ? `${this.getSsoUrl()}/?${ssoQuery}` : undefined;
      const actionLink = await this.authService.generateWrappedInviteLink({
        email: body.email,
        redirectTo: ssoRedirect ?? null,
        projectId: body.project_id ?? null,
        orgId,
      });
      const email = renderInviteEmail({
        branding,
        actionLink,
        expiresAt: invite.expires_at,
      });
      await this.mailerService.send({
        to: body.email,
        ...email,
      });
    }

    return {
      id: invite.id,
      org_id: invite.org_id,
      invite_code: invite.invite_code,
      provider_hint: invite.provider_hint,
      identity_hint: invite.identity_hint,
      role: invite.role,
      redirect_to: invite.redirect_to,
      app_context: invite.app_context,
      expires_at: invite.expires_at?.toISOString() ?? null,
      used_at: invite.used_at?.toISOString() ?? null,
      created_at: invite.created_at.toISOString(),
    };
  }

  async listOrgInvites(orgId: string): Promise<OrgInviteListResponse> {
    const invites = await this.orgInvites.listByOrg(orgId, { includeUsed: true });
    return {
      data: invites.map((inv) => ({
        id: inv.id,
        org_id: inv.org_id,
        invite_code: inv.invite_code,
        provider_hint: inv.provider_hint,
        identity_hint: inv.identity_hint,
        role: inv.role,
        redirect_to: inv.redirect_to,
        app_context: inv.app_context,
        expires_at: inv.expires_at?.toISOString() ?? null,
        used_at: inv.used_at?.toISOString() ?? null,
        created_at: inv.created_at.toISOString(),
      })),
    };
  }

  private getSsoUrl(): string {
    return process.env.EVE_SSO_URL ?? process.env.SSO_URL ?? 'http://sso.eve.lvh.me';
  }

  async deleteOrg(orgId: string, options: { hard?: boolean; force?: boolean } = {}): Promise<void> {
    const org = await this.orgs.findById(orgId, { include_deleted: true });
    if (!org) {
      throw new NotFoundException(`Organization ${orgId} not found`);
    }

    // List all projects in this org (including soft-deleted) and delete them
    const projects = await this.projects.list({ org_id: orgId, include_deleted: true, limit: 10000 });
    for (const project of projects) {
      try {
        // Teardown K8s deployments for each project's environments
        const envs = await this.envs.listByProject(project.id);
        for (const env of envs) {
          try {
            await this.teardownEnvironmentDeployment(env.id, options.force);
          } catch (error) {
            if (!options.force) throw error;
            this.logger.warn(`[org-delete] Env teardown failed (force=true) for env ${env.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        if (options.hard) {
          // Delete environment records first (handles FK constraints)
          for (const env of envs) {
            await this.envs.delete(env.id);
          }
          await this.projects.hardDelete(project.id);
        } else {
          await this.projects.update(project.id, { deleted: true });
        }
      } catch (error) {
        if (!options.force) throw error;
        this.logger.warn(`[org-delete] Project delete failed (force=true) for project ${project.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (options.hard) {
      await this.orgs.hardDelete(orgId);
      this.logger.log(`[org-delete] Hard-deleted org ${orgId}`);
    } else {
      await this.orgs.update(orgId, { deleted: true });
      this.logger.log(`[org-delete] Soft-deleted org ${orgId}`);
    }
  }

  // ── Environment teardown helpers (for org delete) ───────────────

  private async teardownEnvironmentDeployment(
    envId: string,
    force = false,
  ): Promise<void> {
    let workerUrl: string;
    try {
      workerUrl = resolveWorkerUrl('delete environment deployments');
    } catch {
      this.logger.warn(`[org-delete] Worker URL unavailable, skipping deployment teardown for env ${envId}`);
      return;
    }

    try {
      const response = await fetch(`${workerUrl}/environments/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env_id: envId }),
      });

      if (response.ok) {
        return;
      }

      const text = await response.text();
      const lower = `${response.status} ${text}`.toLowerCase();
      if (response.status === 404 || lower.includes('not found')) {
        this.logger.log(`[org-delete] Deployment namespace already absent for env ${envId}`);
        return;
      }

      if (force) {
        this.logger.warn(`[org-delete] Worker delete failed (force=true) for env ${envId}: ${response.status} ${text || response.statusText}`);
        return;
      }

      throw new ServiceUnavailableException(
        `Worker environment delete failed (${response.status}): ${text || response.statusText}`,
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        if (force) {
          this.logger.warn(`[org-delete] Worker delete failed (force=true) for env ${envId}: ${(error as Error).message}`);
          return;
        }
        throw error;
      }
      if (force) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[org-delete] Worker delete failed (force=true) for env ${envId}: ${message}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException(`Failed to teardown environment deployment: ${message}`);
    }
  }

  private toResponse(org: Org): OrgResponse {
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      default_agent_slug: org.default_agent_slug ?? null,
      billing_config: org.billing_config ?? null,
      deleted: org.deleted_at !== null,  // Convert timestamp to boolean
      created_at: org.created_at.toISOString(),
      updated_at: org.updated_at.toISOString(),
    };
  }

  private toMemberResponse(member: { org_id: string; user_id: string; email: string; display_name: string | null; role: string; created_at: Date; updated_at: Date }): OrgMemberResponse {
    return {
      org_id: member.org_id,
      user_id: member.user_id,
      email: member.email,
      display_name: member.display_name,
      role: member.role as OrgMemberResponse['role'],
      created_at: member.created_at.toISOString(),
      updated_at: member.updated_at.toISOString(),
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string } | null | undefined;
  return candidate?.code === '23505';
}

function isSameOrgName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
