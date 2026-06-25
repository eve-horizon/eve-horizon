import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import type { Db, Project, MembershipRole } from '@eve/db';
import { customDomainQueries, membershipQueries, orgQueries, projectQueries } from '@eve/db';
import {
  ProjectAuthConfigSchema,
  type AppAccessResponse,
  type ProjectAuthConfig,
} from '@eve/shared';

type OrgRow = {
  id: string;
  name: string;
  slug: string;
};

@Injectable()
export class AppAuthPolicyService {
  private readonly logger = new Logger(AppAuthPolicyService.name);
  private readonly projects: ReturnType<typeof projectQueries>;
  private readonly orgs: ReturnType<typeof orgQueries>;
  private readonly memberships: ReturnType<typeof membershipQueries>;
  private readonly customDomains: ReturnType<typeof customDomainQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.projects = projectQueries(db);
    this.orgs = orgQueries(db);
    this.memberships = membershipQueries(db);
    this.customDomains = customDomainQueries(db);
  }

  async getProjectPolicy(projectId: string): Promise<{
    project: Project;
    auth: ProjectAuthConfig;
    allowedOrgIds: string[];
  }> {
    const project = await this.projects.findById(projectId, { include_deleted: false });
    if (!project) {
      throw new BadRequestException(`Project not found: ${projectId}`);
    }

    const auth = this.parseAuthConfig(project.auth_config) ?? ProjectAuthConfigSchema.parse({});
    const allowedOrgIds = await this.resolveAllowedOrgIds(project, auth);
    return { project, auth, allowedOrgIds };
  }

  async getAllowedOrgIds(projectId: string): Promise<string[]> {
    const policy = await this.getProjectPolicy(projectId);
    return policy.allowedOrgIds;
  }

  async isOrgAllowed(projectId: string, orgId: string): Promise<boolean> {
    const allowedOrgIds = await this.getAllowedOrgIds(projectId);
    return allowedOrgIds.includes(orgId);
  }

  async getUserAppAccess(projectId: string, userId: string): Promise<AppAccessResponse> {
    const policy = await this.getProjectPolicy(projectId);
    const allowed = new Set(policy.allowedOrgIds);
    const memberships = await this.memberships.listOrgMembershipsForUser(userId);
    const usableMemberships = memberships.filter((membership) => allowed.has(membership.org_id));
    const orgRows = await this.loadOrgRows(usableMemberships.map((membership) => membership.org_id));
    const orgById = new Map(orgRows.map((org) => [org.id, org]));

    const orgs = usableMemberships
      .map((membership) => {
        const org = orgById.get(membership.org_id);
        if (!org) return null;
        const inviteMembers = this.roleCanInvite(policy.auth, membership.role);
        return {
          id: org.id,
          slug: org.slug,
          name: org.name,
          role: membership.role,
          capabilities: {
            enter_app: true,
            invite_members: inviteMembers,
          },
        };
      })
      .filter((org): org is AppAccessResponse['orgs'][number] => Boolean(org));

    const adminOrgs = orgs
      .filter((org) => org.capabilities.invite_members)
      .map(({ capabilities: _capabilities, ...org }) => org);

    return {
      project_id: policy.project.id,
      orgs,
      admin_orgs: adminOrgs,
    };
  }

  async assertCanInvite(projectId: string, orgId: string, userId: string): Promise<void> {
    const policy = await this.getProjectPolicy(projectId);
    if (!policy.allowedOrgIds.includes(orgId)) {
      throw new ForbiddenException('App is not enabled for this org');
    }
    if (!policy.auth.org_access.invite.enabled) {
      throw new ForbiddenException('App invites are not enabled for this project');
    }

    const membership = await this.memberships.findOrgMembership(userId, orgId);
    if (!membership) {
      throw new ForbiddenException('User is not a member of this org');
    }
    if (!this.roleCanInvite(policy.auth, membership.role)) {
      throw new ForbiddenException('User cannot invite members for this app/org');
    }
  }

  toPublicAuthConfig(
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
        // Expose the bool but NEVER the domain list — that would be an
        // enumeration oracle for which companies use which apps.
        domain_signup_enabled: orgAccess.domain_signup.enabled,
      },
      allowed_redirect_origins: allowedRedirectOrigins,
    };
  }

  /**
   * Resolve the effective `domain_signup` rule list for a project. Returns
   * the normalized rule array (each rule has a canonical org_id `target_org`
   * inside the project's `allowed_orgs`) or `null` when domain_signup is
   * disabled, empty, or any rule fails to resolve.
   *
   * Never throws — magic-link send must stay account-enumeration-safe; if
   * the stored policy can't be resolved we log and return null so the
   * caller falls through to generic success.
   *
   * Stored manifests should already have canonical org IDs (manifest sync
   * normalises slug → id), so this is mostly a safety re-check.
   */
  async resolveDomainSignup(
    project: Project,
    auth: ProjectAuthConfig,
  ): Promise<Array<{ domain: string; target_org: string; role: 'member' }> | null> {
    const ds = auth.org_access.domain_signup;
    if (!ds.enabled || ds.domains.length === 0) return null;

    const allowedOrgIds = await this.getAllowedOrgIds(project.id);

    const out: Array<{ domain: string; target_org: string; role: 'member' }> = [];
    for (const rule of ds.domains) {
      let orgId = rule.target_org;
      if (!orgId.startsWith('org_')) {
        try {
          orgId = (await this.resolveOrgRef(orgId)).id;
        } catch {
          this.logger.warn(
            `domain_signup rule for "${rule.domain}" target_org=${rule.target_org} did not resolve for project=${project.id}`,
          );
          return null;
        }
      }
      if (!allowedOrgIds.includes(orgId)) {
        this.logger.warn(
          `domain_signup rule for "${rule.domain}" target_org=${orgId} not in allowed_orgs for project=${project.id}`,
        );
        return null;
      }
      out.push({ domain: rule.domain, target_org: orgId, role: rule.role });
    }
    return out;
  }

  /**
   * Build the complete redirect-origin allowlist for a project. Combines:
   *   - explicit manifest `auth.allowed_redirect_origins`
   *   - eligible custom domains owned by this project
   *   - eligible custom domains owned by any project in `allowed_orgs` (one hop)
   *
   * Returns a deduped, normalized list of origins (scheme://host[:port]).
   */
  async getAllowedRedirectOrigins(
    project: Project,
    auth: ProjectAuthConfig,
    allowedOrgIds: string[],
  ): Promise<string[]> {
    const origins = new Set<string>();
    for (const origin of auth.allowed_redirect_origins ?? []) {
      origins.add(origin);
    }

    const ownDomains = await this.customDomains.findRedirectEligibleByProjectIds([project.id]);
    for (const domain of ownDomains) {
      origins.add(`https://${domain.hostname}`);
    }

    if (auth.org_access.mode === 'allowlist' && allowedOrgIds.length > 0) {
      const crossOrgDomains = await this.customDomains.findRedirectEligibleByOrgIds(allowedOrgIds);
      for (const domain of crossOrgDomains) {
        origins.add(`https://${domain.hostname}`);
      }
    }

    return Array.from(origins);
  }

  private parseAuthConfig(value: Record<string, unknown> | null): ProjectAuthConfig | null {
    if (!value) return null;
    const parsed = ProjectAuthConfigSchema.safeParse(value);
    if (!parsed.success) {
      this.logger.warn(`Ignoring invalid stored project auth config: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  }

  private async resolveAllowedOrgIds(project: Project, auth: ProjectAuthConfig): Promise<string[]> {
    const orgAccess = auth.org_access;
    if (orgAccess.mode === 'project_org') {
      return [project.org_id];
    }

    const resolved: string[] = [];
    for (const ref of orgAccess.allowed_orgs) {
      const org = await this.resolveOrgRef(ref);
      if (!resolved.includes(org.id)) {
        resolved.push(org.id);
      }
    }
    return resolved;
  }

  private roleCanInvite(auth: ProjectAuthConfig, role: MembershipRole): boolean {
    const invite = auth.org_access.invite;
    return invite.enabled && invite.admin_roles.includes(role as 'admin' | 'owner');
  }

  private async resolveOrgRef(ref: string): Promise<OrgRow> {
    const trimmed = ref.trim();
    const org = trimmed.startsWith('org_')
      ? await this.orgs.findById(trimmed, { include_deleted: false })
      : await this.orgs.findBySlug(trimmed, { include_deleted: false });
    if (!org) {
      throw new NotFoundException(`Allowed org not found: ${ref}`);
    }
    return org;
  }

  private async loadOrgRows(orgIds: string[]): Promise<OrgRow[]> {
    if (orgIds.length === 0) return [];
    return this.db<OrgRow[]>`
      SELECT id, name, slug
      FROM orgs
      WHERE id = ANY(${orgIds}) AND deleted_at IS NULL
    `;
  }
}
