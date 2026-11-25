import { Injectable, ForbiddenException, NotFoundException, Inject } from '@nestjs/common';
import type { Db } from '@eve/db';
import { membershipQueries, projectQueries, accessRoleQueries, accessGroupQueries, type MembershipRole } from '@eve/db';
import { expandPermissions, type Permission } from './permissions.js';
import { allPermissions, MEMBER_OPERATOR_PERMISSIONS, OPERATOR_RIGHT_IMPLIED_BY, type OperatorRight } from '@eve/shared';
import type { AuthUser } from './auth.service.js';
import { isScopedToken, tokenMayAddressProject, type TokenScopeResolver } from './token-scope.js';
import { SecurityService } from '../security/security.service.js';

/** An org member reached a project only through the org member role (P1-5). */
export const IMPLICIT_PROJECT_RULE = 'access.implicit_project';
/** Permissions were asked for a project that could not be looked up (P1-5). */
export const UNRESOLVED_PROJECT_RULE = 'access.unresolved_project';
/** A chat sender with no Eve user, or no `jobs:write` on the project, started agent work (P1-5). */
export const CHAT_SENDER_RULE = 'chat.sender_rights';
/** An org-addressed route reached a project resource the caller holds no right to there (P1-5). */
export const ORG_ROUTE_PROJECT_RULE = 'access.org_route_project';
/**
 * Where the operator rights come from (P2-7): outside `strict` a read right
 * stands for `secrets:use` or `envdb:export`, and the member role carries
 * `jobs:harness_override`; under `strict` neither holds.
 */
export const OPERATOR_RIGHTS_RULE = 'access.operator_rights';
/** Starting work bound to a secret beyond its harness credential needs `secrets:use` (P2-7). */
export const SECRETS_USE_RULE = 'secrets.use';
/** A database snapshot download needs `envdb:export` (P2-7). */
export const ENVDB_EXPORT_RULE = 'envdb.export';

/** A test the caller's permissions must pass; used to tell whether a request depends on a grant. */
export type PermissionNeed = (permissions: ReadonlySet<string>) => boolean;

/**
 * A user's permissions in an org, or in a project of it, split by source.
 * `implicit` is the org member role's set when it reaches a project the user
 * holds no membership on; under a strict project it grants nothing there.
 */
interface PermissionSources {
  explicit: Set<string>;
  implicit: ReadonlySet<string>;
  /**
   * {@link MEMBER_OPERATOR_PERMISSIONS} the user holds only through the
   * member role: a strict project withholds them (rule access.operator_rights).
   */
  memberOperator: ReadonlySet<string>;
  /** The project's id, when the context named a project that exists. */
  projectId?: string;
}

export const ROLE_RANK: Record<MembershipRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

/** Project-owned resources that flat `/<kind>/:id/...` routes address by id. */
export type OwnedResourceKind = 'job' | 'pipeline_run' | 'build' | 'thread';

const OWNED_RESOURCE_LABELS: Record<OwnedResourceKind, string> = {
  job: 'Job',
  pipeline_run: 'Pipeline run',
  build: 'Build',
  thread: 'Thread',
};

@Injectable()
export class RbacService implements TokenScopeResolver {
  private memberships: ReturnType<typeof membershipQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private accessRoles: ReturnType<typeof accessRoleQueries>;
  private accessGroups: ReturnType<typeof accessGroupQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly security?: SecurityService,
  ) {
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

    // The org role decides. Owners and admins outrank the member role, so a
    // pass that needed only `member` may rest on the org member role alone.
    if (ROLE_RANK[required] === ROLE_RANK.member) {
      const orgMembership = await this.memberships.findOrgMembership(userId, project.org_id);
      if (orgMembership?.role === 'member') {
        await this.security?.gate(
          IMPLICIT_PROJECT_RULE,
          { governing: 'project', projectId: project.id, orgId: project.org_id, actor: { user_id: userId }, detail: { org_role: 'member' } },
          'Org members need a project membership or binding to use this project',
        );
      }
    }
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
   *
   * In a project the user holds no membership on, the org member role is an
   * implicit grant: a strict project withholds it, an audit project records
   * it. Pass `need` when the caller only tests the set, so a request that
   * does not depend on the implicit grant is neither judged nor recorded.
   */
  async getEffectivePermissions(
    userId: string,
    orgId: string,
    projectId?: string,
    options: { actor?: AuthUser; need?: PermissionNeed } = {},
  ): Promise<Set<string>> {
    const sources = await this.permissionSources(userId, orgId, projectId);
    if (await this.withholdsMemberOperatorRights(sources, orgId, userId, options)) {
      for (const permission of sources.memberOperator) sources.explicit.delete(permission);
      sources.implicit = new Set([...sources.implicit].filter((permission) => !sources.memberOperator.has(permission)));
    }
    const all = new Set<string>([...sources.explicit, ...sources.implicit]);
    if (all.size === sources.explicit.size) {
      return all;
    }
    // The outcome is the same whatever the profile: nothing to decide or record.
    if (options.need && (options.need(sources.explicit) || !options.need(all))) {
      return all;
    }
    const profile = await this.security?.decide(IMPLICIT_PROJECT_RULE, {
      governing: 'project',
      projectId: sources.projectId,
      orgId,
      actor: options.actor ?? { user_id: userId },
      detail: { org_role: 'member' },
    });
    return profile === 'strict' ? sources.explicit : all;
  }

  /**
   * Rule access.operator_rights: whether a strict project takes the member
   * role's operator permissions (jobs:harness_override) away from this user.
   * With `need`, the rule is decided, and recorded, only when the request
   * depends on them; without, the profile is read and nothing is recorded.
   */
  private async withholdsMemberOperatorRights(
    sources: PermissionSources,
    orgId: string,
    userId: string,
    options: { actor?: AuthUser; need?: PermissionNeed },
  ): Promise<boolean> {
    if (sources.memberOperator.size === 0 || !this.security) return false;
    const scope = { orgId, projectId: sources.projectId };
    if (!options.need) {
      return (await this.security.effectiveProfile(scope, 'project', OPERATOR_RIGHTS_RULE)) === 'strict';
    }
    const all = new Set<string>([...sources.explicit, ...sources.implicit]);
    const without = new Set([...all].filter((permission) => !sources.memberOperator.has(permission)));
    if (options.need(without) || !options.need(all)) return false;
    const profile = await this.security.decide(OPERATOR_RIGHTS_RULE, {
      ...scope,
      governing: 'project',
      actor: options.actor ?? { user_id: userId },
      detail: { permission: [...sources.memberOperator].join(','), source: 'member_role' },
    });
    return profile === 'strict';
  }

  private async permissionSources(userId: string, orgId: string, projectInput?: string): Promise<PermissionSources> {
    let project: { id: string; org_id: string } | null = null;
    if (projectInput) {
      try {
        project = await this.resolveProject(projectInput);
      } catch (error) {
        if (!(error instanceof NotFoundException)) {
          throw error;
        }
      }
    }

    // Project membership takes priority over org membership.
    const projectMembership = project ? await this.memberships.findProjectMembership(userId, project.id) : null;
    const orgMembership = projectMembership ? null : await this.memberships.findOrgMembership(userId, orgId);
    const baseRole = projectMembership?.role ?? orgMembership?.role ?? null;
    const implicit = Boolean(projectInput) && !projectMembership && orgMembership?.role === 'member';
    const basePermissions = baseRole ? expandPermissions(baseRole) : new Set<Permission>();

    // Custom role grants: org-wide bindings, and bindings on the project by its id.
    const customPermissions = await this.accessRoles.getEffectiveCustomPermissions(
      'user', userId, orgId, project?.id,
    );

    const explicit = new Set<string>(implicit ? [] : (basePermissions as ReadonlySet<string>));
    for (const perm of customPermissions) {
      explicit.add(perm);
    }
    const custom = new Set<string>(customPermissions);

    return {
      explicit,
      implicit: implicit ? (basePermissions as ReadonlySet<string>) : new Set<string>(),
      memberOperator: new Set(baseRole === 'member'
        ? MEMBER_OPERATOR_PERMISSIONS.filter((permission) => !custom.has(permission))
        : []),
      projectId: project?.id,
    };
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
    need?: PermissionNeed,
  ): Promise<ReadonlySet<string>> {
    if (user.is_admin) return new Set<string>(allPermissions());
    if (isScopedToken(user)) {
      // A scoped token holds no permissions in a project outside its own scope.
      if (projectInput && !(await tokenMayAddressProject(user, projectInput, this))) {
        return new Set<string>();
      }
      return new Set(user.permissions ?? []);
    }

    // An org-bound user token holds no permissions in a project outside its org.
    if (
      user.bound_org_id
      && projectInput
      && !(await tokenMayAddressProject({ user_id: user.user_id, org_id: user.bound_org_id }, projectInput, this))
    ) {
      return new Set<string>();
    }

    if (projectInput) {
      let orgId: string;
      try {
        orgId = await this.getProjectOrgId(projectInput);
      } catch (error) {
        // Only a project that is not there falls back; any other failure
        // (a lookup or profile error) is an error, never the member set.
        if (!(error instanceof NotFoundException)) throw error;
        // A project id the instance still holds (a deleted project) is judged
        // under that project's profile; otherwise the instance profile governs.
        const profile = await this.security?.decide(UNRESOLVED_PROJECT_RULE, {
          governing: 'project',
          projectId: projectInput.startsWith('proj_') ? projectInput : undefined,
          actor: user,
          detail: { project: projectInput },
        });
        return profile === 'strict' ? new Set<string>() : expandPermissions('member');
      }
      return this.getEffectivePermissions(user.user_id, orgId, projectInput, { actor: user, need });
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
    const effective = await this.resolveEffectivePermissions(
      user,
      projectInput,
      (permissions) => required.every((perm) => permissions.has(perm)),
    );
    for (const perm of required) {
      if (!effective.has(perm)) {
        throw new ForbiddenException(`Missing required permission: ${perm}`);
      }
    }
  }

  /**
   * Hold a caller to an operator right (`secrets:use`, `envdb:export`) in a
   * project, for a use governed by `rule` (secrets.use, envdb.export). The
   * right itself passes. Outside a strict project the read right that stands
   * for it passes too, and `audit` records the use (access.operator_rights).
   * Anyone else breaks `rule`: `legacy` allows, `audit` records and allows,
   * `strict` records and refuses (403). A null caller is no one (a chat
   * sender with no Eve user). System admins pass.
   */
  async requireOperatorRight(
    caller: AuthUser | null,
    projectInput: string,
    right: OperatorRight,
    rule: string,
    detail: Record<string, string | number | boolean | null> = {},
  ): Promise<void> {
    if (caller?.is_admin || !this.security) return;
    const project = await this.getProjectScope(projectInput);
    const impliedBy = OPERATOR_RIGHT_IMPLIED_BY[right];
    const held = caller
      ? await this.resolveEffectivePermissions(caller, project.id, (set) => set.has(right) || set.has(impliedBy))
      : new Set<string>();
    if (held.has(right)) return;
    const scope = { governing: 'project' as const, projectId: project.id, orgId: project.org_id, actor: caller };
    if (held.has(impliedBy)) {
      const profile = await this.security.effectiveProfile(scope, 'project', OPERATOR_RIGHTS_RULE);
      if (profile === 'legacy') return;
      if (profile === 'audit') {
        await this.security.decide(OPERATOR_RIGHTS_RULE, { ...scope, detail: { ...detail, permission: right, implied_by: impliedBy } });
        return;
      }
    }
    await this.security.gate(rule, { ...scope, detail: { ...detail, permission: right } }, `Missing required permission: ${right}`);
  }

  /**
   * An org-addressed route (org threads, resource resolution, org search)
   * that reaches a resource of a project holds the caller to the rights a
   * project route would need there, under the project's profile: `legacy`
   * does not look, `audit` records a refusal and allows, `strict` refuses
   * (403). System admins pass.
   */
  async requireProjectAccessFromOrgRoute(
    user: AuthUser | undefined,
    projectId: string,
    required: readonly Permission[],
    detail: Record<string, string> = {},
  ): Promise<void> {
    if (!user || user.is_admin || !this.security) return;
    const profile = await this.security.effectiveProfile({ projectId }, 'project');
    if (profile === 'legacy') return;
    try {
      await this.requirePermissions(user, projectId, required);
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      await this.security.gate(
        ORG_ROUTE_PROJECT_RULE,
        { governing: 'project', projectId, actor: user, detail: { ...detail, permission: required.join(',') } },
        'This resource belongs to a project you have no access to',
      );
    }
  }

  /** {@link requireProjectAccessFromOrgRoute} as a test: false where it would refuse. */
  async mayReachProjectFromOrgRoute(
    user: AuthUser | undefined,
    projectId: string,
    required: readonly Permission[],
    detail: Record<string, string> = {},
  ): Promise<boolean> {
    try {
      await this.requireProjectAccessFromOrgRoute(user, projectId, required, detail);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  /**
   * Whether chat may start agent work in a project for this sender: the
   * person the message came from, mapped to an Eve user, must hold
   * `jobs:write` there. Governed by the project's profile: `strict` refuses
   * (returns false), `audit` records, `legacy` does not look.
   */
  async chatSenderMayStartWork(
    projectId: string,
    sender: AuthUser | undefined,
    detail: Record<string, string> = {},
  ): Promise<boolean> {
    const profile = await this.security?.effectiveProfile({ projectId }, 'project');
    if (!profile || profile === 'legacy') {
      return true;
    }
    if (sender) {
      const permissions = await this.resolveEffectivePermissions(sender, projectId, (set) => set.has('jobs:write'));
      if (permissions.has('jobs:write')) {
        return true;
      }
    }
    const decided = await this.security!.decide(CHAT_SENDER_RULE, {
      governing: 'project',
      projectId,
      actor: sender ?? null,
      detail: { ...detail, sender: sender ? 'no_jobs_write' : 'unmapped' },
    });
    return decided !== 'strict';
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

  /**
   * Resolve a project identifier (slug or proj_xxx ID) to the project's id and
   * org for a token scope comparison. A slug held by more than one project
   * (deleted ones included, since some lookups do not skip them) is refused,
   * so the comparison can never be made against a different project than the
   * one the handler goes on to load. Throws NotFoundException when the project
   * does not exist.
   */
  async getProjectScope(projectInput: string): Promise<{ id: string; org_id: string }> {
    if (projectInput.startsWith('proj_')) {
      const project = await this.resolveProject(projectInput);
      return { id: project.id, org_id: project.org_id };
    }

    const rows = await this.db<{ id: string; org_id: string; deleted_at: Date | null }[]>`
      SELECT id, org_id, deleted_at FROM projects WHERE slug = ${projectInput} LIMIT 2
    `;
    if (rows.length > 1) {
      throw new ForbiddenException('Project slug is not unique; address the project by id');
    }
    const [row] = rows;
    if (!row || row.deleted_at) {
      throw new NotFoundException('Project not found');
    }
    return { id: row.id, org_id: row.org_id };
  }

  /**
   * Resolve an org identifier (org_xxx ID or slug; org routes accept either)
   * to the org's id for a token scope comparison. Throws NotFoundException
   * when the org does not exist.
   */
  async getOrgScopeId(orgInput: string): Promise<string> {
    const rows = await this.db<{ id: string }[]>`
      SELECT id FROM orgs WHERE (id = ${orgInput} OR slug = ${orgInput}) AND deleted_at IS NULL LIMIT 2
    `;
    if (rows.length !== 1) {
      throw new NotFoundException('Org not found');
    }
    return rows[0].id;
  }

  /**
   * Resolve the project and owning org for a job id. Kept for callers that
   * predate {@link getResourceProjectContext}.
   */
  async getJobProjectContext(jobId: string): Promise<{ project_id: string; org_id: string }> {
    return this.getResourceProjectContext('job', jobId);
  }

  /**
   * Resolve the project and owning org for a project-owned resource addressed
   * by id on a route that carries no project or org parameter (jobs, pipeline
   * runs, builds, threads). The permission guard uses this so such routes are
   * authorized against the owning project rather than a context-free baseline.
   * Throws NotFoundException when the resource does not exist.
   */
  async getResourceProjectContext(
    kind: OwnedResourceKind,
    id: string,
  ): Promise<{ project_id: string; org_id: string }> {
    let rows: { project_id: string; org_id: string }[];
    switch (kind) {
      case 'job':
        rows = await this.db<{ project_id: string; org_id: string }[]>`
          SELECT r.project_id, p.org_id FROM jobs r JOIN projects p ON p.id = r.project_id WHERE r.id = ${id} LIMIT 1
        `;
        break;
      case 'pipeline_run':
        rows = await this.db<{ project_id: string; org_id: string }[]>`
          SELECT r.project_id, p.org_id FROM pipeline_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ${id} LIMIT 1
        `;
        break;
      case 'build':
        rows = await this.db<{ project_id: string; org_id: string }[]>`
          SELECT r.project_id, p.org_id FROM build_specs r JOIN projects p ON p.id = r.project_id WHERE r.id = ${id} LIMIT 1
        `;
        break;
      case 'thread':
        rows = await this.db<{ project_id: string; org_id: string }[]>`
          SELECT r.project_id, p.org_id FROM threads r JOIN projects p ON p.id = r.project_id WHERE r.id = ${id} LIMIT 1
        `;
        break;
    }
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(`${OWNED_RESOURCE_LABELS[kind]} not found`);
    }
    return row;
  }

  /** The pipeline run a job is a step of, or null. */
  async getJobPipelineRunId(jobId: string): Promise<string | null> {
    const rows = await this.db<{ run_id: string | null }[]>`
      SELECT run_id FROM jobs WHERE id = ${jobId} LIMIT 1
    `;
    return rows[0]?.run_id ?? null;
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
