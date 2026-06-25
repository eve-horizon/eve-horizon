import { Injectable, ForbiddenException, NotFoundException, Inject } from '@nestjs/common';
import type { Db } from '@eve/db';
import { membershipQueries, projectQueries, accessRoleQueries, accessGroupQueries, type MembershipRole } from '@eve/db';
import { expandPermissions, type Permission } from './permissions.js';
import { allPermissions } from '@eve/shared';
import type { AuthUser } from './auth.service.js';

const ROLE_RANK: Record<MembershipRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

@Injectable()
export class RbacService {
  private memberships: ReturnType<typeof membershipQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private accessRoles: ReturnType<typeof accessRoleQueries>;
  private accessGroups: ReturnType<typeof accessGroupQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.memberships = membershipQueries(db);
    this.projects = projectQueries(db);
    this.accessRoles = accessRoleQueries(db);
    this.accessGroups = accessGroupQueries(db);
  }

  async requireOrgRole(userId: string, orgId: string, required: MembershipRole): Promise<void> {
    const membership = await this.memberships.findOrgMembership(userId, orgId);
    if (!membership) {
      throw new ForbiddenException('User is not a member of this org');
    }

    if (ROLE_RANK[membership.role] < ROLE_RANK[required]) {
      throw new ForbiddenException('Insufficient org permissions');
    }
  }

  async requireProjectRole(userId: string, projectInput: string, required: MembershipRole): Promise<void> {
    const project = await this.resolveProject(projectInput);

    const projectMembership = await this.memberships.findProjectMembership(userId, project.id);
    if (projectMembership) {
      if (ROLE_RANK[projectMembership.role] < ROLE_RANK[required]) {
        throw new ForbiddenException('Insufficient project permissions');
      }
      return;
    }

    await this.requireOrgRole(userId, project.org_id, required);
  }

  async listOrgsForUser(userId: string, options: { limit: number; offset: number; include_deleted: boolean }) {
    return this.memberships.listOrgsForUser(userId, options);
  }

  async listProjectsForUser(userId: string, options: { limit: number; offset: number; include_deleted: boolean; org_id?: string }) {
    return this.memberships.listProjectsForUser(userId, options);
  }

  /**
   * Resolve the full effective permission set for a user, combining
   * base role permissions with any custom role grants.
   */
  async getEffectivePermissions(
    userId: string,
    orgId: string,
    projectId?: string,
  ): Promise<Set<string>> {
    // 1. Get base role (project membership takes priority over org membership)
    let baseRole: MembershipRole | null = null;

    if (projectId) {
      let project: { id: string; org_id: string } | null;
      try {
        project = await this.resolveProject(projectId);
      } catch (error) {
        if (error instanceof NotFoundException) {
          project = null;
        } else {
          throw error;
        }
      }

      if (project) {
        const projectMembership = await this.memberships.findProjectMembership(userId, project.id);
        if (projectMembership) {
          baseRole = projectMembership.role;
        }
      }
    }

    if (!baseRole) {
      const orgMembership = await this.memberships.findOrgMembership(userId, orgId);
      baseRole = orgMembership?.role ?? null;
    }

    const basePermissions = baseRole ? expandPermissions(baseRole) : new Set<Permission>();

    // 2. Get custom role permissions
    const customPermissions = await this.accessRoles.getEffectiveCustomPermissions(
      'user', userId, orgId, projectId,
    );

    // 3. Union
    const effective = new Set<string>(basePermissions as ReadonlySet<string>);
    for (const perm of customPermissions) {
      effective.add(perm);
    }

    return effective;
  }

  /**
   * Resolve the effective permission set for any authenticated principal
   * (admin / job token / service token / service principal / user) in the
   * context of an optional project. Mirrors the permission guard's resolution
   * and is used by controllers that conditionally require extra permissions
   * depending on the request body (e.g. `jobs:harness_override`).
   */
  async resolveEffectivePermissions(
    user: AuthUser,
    projectInput?: string,
  ): Promise<ReadonlySet<string>> {
    if (user.is_admin) return new Set<string>(allPermissions());
    if (user.is_job_token || user.is_service_token || user.is_service_principal) {
      return new Set(user.permissions ?? []);
    }

    if (projectInput) {
      try {
        const orgId = await this.getProjectOrgId(projectInput);
        return this.getEffectivePermissions(user.user_id, orgId, projectInput);
      } catch {
        // fall through to member baseline
      }
    }
    return expandPermissions('member');
  }

  /**
   * Throw ForbiddenException if the caller is missing any of the required
   * permissions. Caller order matters only for the error message.
   */
  async requirePermissions(
    user: AuthUser,
    projectInput: string | undefined,
    required: readonly Permission[],
  ): Promise<void> {
    const effective = await this.resolveEffectivePermissions(user, projectInput);
    for (const perm of required) {
      if (!effective.has(perm)) {
        throw new ForbiddenException(`Missing required permission: ${perm}`);
      }
    }
  }

  async getPrincipalGroupIds(
    orgId: string,
    principalType: 'user' | 'service_principal',
    principalId: string,
  ): Promise<string[]> {
    return this.accessGroups.listGroupIdsForPrincipal(orgId, principalType, principalId);
  }

  /**
   * Resolve a project identifier (slug or proj_xxx ID) and return the org_id.
   * Throws NotFoundException when the project does not exist.
   */
  async getProjectOrgId(projectInput: string): Promise<string> {
    const project = await this.resolveProject(projectInput);
    return project.org_id;
  }

  private async resolveProject(projectInput: string) {
    if (projectInput.startsWith('proj_')) {
      const project = await this.projects.findById(projectInput, { include_deleted: false });
      if (!project) {
        throw new NotFoundException('Project not found');
      }
      return project;
    }

    const [row] = await this.db<{ id: string; org_id: string }[]>`
      SELECT id, org_id FROM projects WHERE slug = ${projectInput} AND deleted_at IS NULL LIMIT 1
    `;
    if (!row) {
      throw new NotFoundException('Project not found');
    }
    return row;
  }
}
