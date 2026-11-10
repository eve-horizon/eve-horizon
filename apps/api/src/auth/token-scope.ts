import { ForbiddenException } from '@nestjs/common';
import { clampJobTokenPermissions, hasUserActor, isOrgManagementPermission } from '@eve/shared';
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
 * The permissions a job token is signed with. Never platform permissions;
 * org-management permissions only for a job a user started, and only those
 * that user holds at org level (org role or org bindings). Step ceilings
 * already judge declared step permissions; this also covers permissions that
 * come from agent config.
 */
export async function jobTokenPermissionsFor(
  access: Pick<AccessService, 'can'>,
  actorUserId: string | null,
  orgId: string,
  requested: readonly string[],
): Promise<string[]> {
  const hasActor = hasUserActor(actorUserId);
  const permissions = clampJobTokenPermissions(requested, { hasActor });
  if (!hasActor) {
    return permissions;
  }
  const kept: string[] = [];
  for (const permission of permissions) {
    if (isOrgManagementPermission(permission)) {
      const { allowed } = await access.can({
        org_id: orgId,
        principal_type: 'user',
        principal_id: actorUserId,
        permission,
      });
      if (!allowed) continue;
    }
    kept.push(permission);
  }
  return kept;
}

/**
 * The user to record as the actor of work a caller starts (jobs, workflows,
 * pipeline runs, deploys). An org-bound user token acts as an org-level
 * principal, not as the person behind the account, so work it starts has no
 * user actor and never resolves that user's private secrets or bindings.
 */
export function actorUserId(caller: AuthUser | undefined): string | undefined {
  return caller && !caller.bound_org_id ? caller.user_id : undefined;
}

/**
 * Org-wide settings (org secrets, cloud-fs mounts) are changed by people and
 * org-level service principals, never by a token minted for one project (job
 * and service tokens), whatever permissions that token carries. Reads are
 * unaffected.
 */
export function refuseProjectTokens(caller: AuthUser | undefined, what: string): void {
  if (caller && isScopedToken(caller) && caller.project_id) {
    throw new ForbiddenException(`Tokens minted for a project may not change ${what}`);
  }
}
