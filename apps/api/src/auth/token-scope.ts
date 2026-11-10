import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  clampJobTokenPermissions,
  hasUserActor,
  isOrgManagementPermission,
  isUserActorOnlyPermission,
  splitNoActorJobPermissions,
} from '@eve/shared';
import type { AuthUser } from './auth.types.js';
import type { AccessService } from './access.service.js';

/** Resolves the project and org references a route names (RbacService implements it). */
export interface TokenScopeResolver {
  /** A project id or slug, as the project's id and owning org. */
  getProjectScope(projectInput: string): Promise<{ id: string; org_id: string }>;
  /** An org id or slug, as the org's id. */
  getOrgScopeId(orgInput: string): Promise<string>;
}

/**
 * Job, service and service-principal tokens carry explicit permissions and are
 * minted for one scope: job and service tokens for one project (and its org),
 * service principals for one org.
 */
export function isScopedToken(user: AuthUser): boolean {
  return Boolean(user.is_job_token || user.is_service_token || user.is_service_principal);
}

/**
 * A scoped token may address its own project. A token with an org but no
 * project may address any project in that org. A token with neither may
 * address no project.
 */
export async function tokenMayAddressProject(
  user: AuthUser,
  projectInput: string,
  scopes: TokenScopeResolver,
): Promise<boolean> {
  if (user.project_id) {
    if (projectInput === user.project_id) {
      return true;
    }
    return (await scopes.getProjectScope(projectInput)).id === user.project_id;
  }
  if (user.org_id) {
    return (await scopes.getProjectScope(projectInput)).org_id === user.org_id;
  }
  return false;
}

/**
 * A scoped token may address only its own org: its `org_id`, or for a token
 * that carries only a project, that project's org.
 */
export async function tokenMayAddressOrg(
  user: AuthUser,
  orgInput: string,
  scopes: TokenScopeResolver,
): Promise<boolean> {
  const tokenOrgId = user.org_id
    ?? (user.project_id ? (await scopes.getProjectScope(user.project_id)).org_id : undefined);
  if (!tokenOrgId) {
    return false;
  }
  if (orgInput === tokenOrgId) {
    return true;
  }
  return (await scopes.getOrgScopeId(orgInput)) === tokenOrgId;
}

/**
 * Hold the org and project filters of a flat listing (a route with no project
 * or org in its path) to a scoped token's own scope. A filter naming another
 * org or project is a 403. The result never spans more than the token's own
 * project, or for an org-only token its org (and the requested project in it).
 */
export async function scopeListFiltersToToken(
  user: AuthUser,
  filters: { org_id?: string; project_id?: string },
  scopes: TokenScopeResolver,
): Promise<{ org_id?: string; project_id?: string }> {
  if (filters.org_id && !(await tokenMayAddressOrg(user, filters.org_id, scopes))) {
    throw new ForbiddenException('Token is not scoped to this org');
  }
  if (filters.project_id && !(await tokenMayAddressProject(user, filters.project_id, scopes))) {
    throw new ForbiddenException('Token is not scoped to this project');
  }
  if (user.project_id) {
    return { project_id: user.project_id };
  }
  if (user.org_id) {
    const project = filters.project_id ? await scopes.getProjectScope(filters.project_id) : undefined;
    return { org_id: user.org_id, project_id: project?.id };
  }
  throw new ForbiddenException('Token carries no project or org scope');
}

/**
 * The scope a caller is held to on routes and flat listings, if any: a job,
 * service or service-principal token itself, or for an org-bound user token
 * an org-only principal of its bound org. Undefined for an unrestricted caller.
 */
export function heldScope(user: AuthUser): AuthUser | undefined {
  if (isScopedToken(user)) {
    return user;
  }
  if (user.bound_org_id) {
    return { user_id: user.user_id, org_id: user.bound_org_id };
  }
  return undefined;
}

/**
 * The permissions a job token is signed with. Never platform permissions.
 * Permissions that need a user (org management, org data admin) only for a job
 * a user started, and only those that user holds: org management at org level
 * (org role or org bindings), org data admin for the job's project (built-in
 * project role, custom role bindings and org role). Step ceilings already judge
 * declared step permissions; this also covers permissions from agent config.
 */
export async function jobTokenPermissionsFor(
  access: Pick<AccessService, 'can'>,
  actorUserId: string | null,
  orgId: string,
  projectId: string,
  requested: readonly string[],
  options: WorkStartOptions = {},
): Promise<string[]> {
  const hasActor = hasUserActor(actorUserId);
  const permissions = clampJobTokenPermissions(requested, { hasActor, userSecretsExcluded: options.userSecretsExcluded });
  if (!hasActor) {
    return permissions;
  }
  const kept: string[] = [];
  for (const permission of permissions) {
    if (isUserActorOnlyPermission(permission)) {
      const { allowed } = await access.can({
        org_id: orgId,
        principal_type: 'user',
        principal_id: actorUserId,
        project_id: isOrgManagementPermission(permission) ? undefined : projectId,
        permission,
      });
      if (!allowed) continue;
    }
    kept.push(permission);
  }
  return kept;
}

/** How work a caller starts treats the actor's user-scope secrets. */
export interface WorkStartOptions {
  /** True for work started with an org-bound token: never resolve the actor's user-scope secrets. */
  userSecretsExcluded?: boolean;
}

/**
 * Work started with an org-bound user token (a bot), or by a job token for
 * such work, records the bot as its actor, so step ceilings judge it and the
 * work stays attributed, but is marked to resolve no user-scope secrets: a
 * person who later adopts the account must not leak secrets through it.
 */
export function workStartOptions(caller: AuthUser | undefined): Required<WorkStartOptions> {
  return { userSecretsExcluded: Boolean(caller?.bound_org_id || caller?.user_secrets_excluded) };
}

/**
 * Org-wide settings (org secrets, cloud-fs mounts) and org file sharing and
 * publishing are changed by people and org-level service principals, never by
 * a token minted for one project (job and service tokens), whatever
 * permissions that token carries. Reads are unaffected.
 */
export function refuseProjectTokens(caller: AuthUser | undefined, what: string): void {
  if (caller && isScopedToken(caller) && caller.project_id) {
    throw new ForbiddenException(`Tokens minted for a project may not change ${what}`);
  }
}

/**
 * Refuse (400) unless `userId` could grant every permission in `permissions`
 * to a job token in this project: org management judged on the user's org
 * role alone, everything else on the user's permissions for the project. With
 * no user, permissions that need one (and platform permissions) are refused.
 */
export async function assertCanGrantJobPermissions(
  access: Pick<AccessService, 'can'>,
  params: { orgId: string; projectId: string; userId: string | undefined; permissions: readonly string[] | null; context: string },
): Promise<void> {
  const { orgId, projectId, userId, permissions, context } = params;
  if (!permissions || permissions.length === 0) {
    return;
  }
  if (!hasUserActor(userId)) {
    const { withheld } = splitNoActorJobPermissions(permissions);
    if (withheld.length > 0) {
      throw new BadRequestException(`${context} carries ${withheld.join(', ')}, which need a user who started the work`);
    }
    return;
  }
  for (const permission of permissions) {
    const result = await access.can({
      org_id: orgId,
      principal_type: 'user',
      principal_id: userId,
      project_id: isOrgManagementPermission(permission) ? undefined : projectId,
      permission,
    });
    if (!result.allowed) {
      throw new BadRequestException(`${context} requests permission "${permission}" that the invoking actor does not hold`);
    }
  }
}
