import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from './auth.types.js';

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
