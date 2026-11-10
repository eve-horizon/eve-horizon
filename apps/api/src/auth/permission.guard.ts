import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './auth.decorator.js';
import { AuthService, type AuthUser } from './auth.service.js';
import { RbacService, type OwnedResourceKind } from './rbac.service.js';
import { PERMISSION_KEY, SCOPE_NARROWED_KEY } from './permission.decorator.js';
import { expandPermissions, hasAnyPermission, type Permission } from './permissions.js';
import { isScopedToken, tokenMayAddressOrg, tokenMayAddressProject } from './token-scope.js';

/** Permissions that act on the account rather than an org's data; org-bound tokens never hold them. */
const ACCOUNT_LEVEL_PERMISSIONS: ReadonlySet<string> = new Set(['orgs:create']);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly rbacService: RbacService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.authService.isEnabled()) {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request?.user as AuthUser | undefined;
    if (!user?.user_id) {
      throw new UnauthorizedException('Missing user context');
    }

    // System admins bypass all permission checks
    if (user.is_admin) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const scopeNarrowed = this.reflector.getAllAndOverride<boolean>(SCOPE_NARROWED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? false;

    // No @RequirePermission decorator:
    // - User tokens pass (backwards-compat during migration)
    // - Job, service, and service principal tokens are blocked (they must have explicit permissions)
    // - Org-bound user tokens are blocked: these are identity and account routes
    //   (login keys, minting, user secrets), unless the handler narrows itself
    if (!required || required.length === 0) {
      if (user.bound_org_id && !scopeNarrowed) {
        throw new ForbiddenException('Org-bound tokens may not use identity or account endpoints');
      }
      if (user.is_job_token) {
        throw new ForbiddenException('Job tokens require explicit permission grants for this endpoint');
      }
      if (user.is_service_token) {
        throw new ForbiddenException('Service tokens require explicit permission grants for this endpoint');
      }
      if (user.is_service_principal) {
        throw new ForbiddenException('Service principal tokens require explicit permission grants for this endpoint');
      }
      return true;
    }

    // Resolve effective permissions
    const effective = await this.resolvePermissions(user, request, scopeNarrowed);

    if (!hasAnyPermission(effective, required)) {
      throw new ForbiddenException(
        `Missing required permission: ${required.join(' or ')}`,
      );
    }

    return true;
  }

  /**
   * Resolve the permission context for a request.
   *
   * The resource addressed by the route is authoritative:
   *   - `/projects/:project_id/...`  → the project's owning org. A `body.org_id`
   *     is ignored here so the request body cannot steer resolution to another org.
   *   - `/jobs/:job_id/...`, `/pipeline-runs/:runId/...`, `/builds/:build_id/...`,
   *     `/threads/:thread_id/...`    → the resource's project and that project's org.
   *   - `/orgs/:org_id/...`          → that org.
   *   - otherwise                    → `body.org_id` when present (e.g. POST /projects),
   *     else no context (member baseline).
   *
   * Job, service and service-principal tokens carry their own permissions; the
   * same context decides only whether the token may address the route at all.
   */
  private async resolvePermissions(
    user: AuthUser,
    request: any,
    scopeNarrowed: boolean,
  ): Promise<ReadonlySet<string>> {
    const projectId = extractProjectId(request);
    const resource = projectId ? undefined : extractResourceRef(request);

    if (isScopedToken(user)) {
      await this.assertTokenMayAddressRoute(user, request, projectId, resource);
      return new Set(user.permissions ?? []);
    }

    // An org-bound user token is held to its org like an org-only principal,
    // and needs that org (or something in it) as the route's context.
    const boundOrgId = user.bound_org_id;
    if (boundOrgId) {
      await this.assertTokenMayAddressRoute({ user_id: user.user_id, org_id: boundOrgId }, request, projectId, resource);
      const hasContext = Boolean(projectId || resource || extractPathOrgId(request) || extractBodyOrgId(request));
      if (!hasContext && !scopeNarrowed) {
        throw new ForbiddenException('Org-bound tokens may only address their own org');
      }
    }

    // User tokens: resolve effective permissions (base role + custom roles)
    let orgId: string | undefined;
    let contextProjectId = projectId;

    if (projectId) {
      // Throws 404 if the project doesn't exist (instead of silently falling
      // to member baseline).
      orgId = await this.rbacService.getProjectOrgId(projectId);
    } else if (resource) {
      // Throws 404 if the resource doesn't exist.
      const owner = await this.rbacService.getResourceProjectContext(resource.kind, resource.id);
      orgId = owner.org_id;
      contextProjectId = owner.project_id;
    } else {
      orgId = extractPathOrgId(request) ?? extractBodyOrgId(request);
    }

    // An org-bound token holds only the user's permissions in its org, and
    // never the account-level ones (creating orgs).
    if (boundOrgId) {
      const inOrg = await this.rbacService.getEffectivePermissions(user.user_id, orgId ?? boundOrgId, contextProjectId);
      return new Set([...inOrg].filter((permission) => !ACCOUNT_LEVEL_PERMISSIONS.has(permission)));
    }

    if (orgId) {
      return this.rbacService.getEffectivePermissions(user.user_id, orgId, contextProjectId);
    }

    // No org, project, or job context — use member baseline
    return expandPermissions('member');
  }

  /**
   * A job, service or service-principal token may only address its own scope.
   * A project in the path must be the token's project (for an org-only token,
   * a project in its org). An org in the path must be the token's org, and so
   * must `body.org_id` on a route with no project, resource or org in its path.
   * A flat resource route must name a resource in the token's scope.
   */
  private async assertTokenMayAddressRoute(
    user: AuthUser,
    request: any,
    projectId: string | undefined,
    resource: ResourceRef | undefined,
  ): Promise<void> {
    if (projectId && !(await tokenMayAddressProject(user, projectId, this.rbacService))) {
      throw new ForbiddenException('Token is not scoped to this project');
    }

    if (resource) {
      await this.assertTokenMayAddressResource(user, resource);
    }

    const orgId = extractPathOrgId(request)
      ?? (projectId || resource ? undefined : extractBodyOrgId(request));
    if (orgId && !(await tokenMayAddressOrg(user, orgId, this.rbacService))) {
      throw new ForbiddenException('Token is not scoped to this org');
    }
  }

  /**
   * A job/service/service-principal token may only address a resource that
   * belongs to its own scope: for jobs, the job it was minted for (or that
   * job's subtree); otherwise its project, then its org.
   */
  private async assertTokenMayAddressResource(user: AuthUser, resource: ResourceRef): Promise<void> {
    if (
      resource.kind === 'job'
      && user.job_id
      && (resource.id === user.job_id || resource.id.startsWith(`${user.job_id}.`))
    ) {
      return;
    }

    // Throws 404 if the resource doesn't exist.
    const owner = await this.rbacService.getResourceProjectContext(resource.kind, resource.id);

    if (user.project_id) {
      if (user.project_id !== owner.project_id) {
        throw new ForbiddenException('Token is not scoped to the project that owns this resource');
      }
      return;
    }

    if (user.org_id) {
      if (user.org_id !== owner.org_id) {
        throw new ForbiddenException('Token is not scoped to the org that owns this resource');
      }
      return;
    }

    throw new ForbiddenException('Token carries no project or org scope for this resource');
  }
}

type ResourceRef = { kind: OwnedResourceKind; id: string };

function extractProjectId(request: { params?: Record<string, string>; routeOptions?: { url?: string }; url?: string }): string | undefined {
  const params = request.params ?? {};
  if (params.project_id) return params.project_id;

  if (params.id) {
    const path = request.routeOptions?.url ?? request.url ?? '';
    if (path.startsWith('/projects/')) {
      return params.id;
    }
  }

  return undefined;
}

/**
 * Identify a project-owned resource addressed by id on a route that has no
 * project parameter. Path prefixes keep precedence sane: `/orgs/:org_id/threads/:thread_id`
 * resolves through the org param, not through the thread.
 */
function extractResourceRef(request: { params?: Record<string, string>; routeOptions?: { url?: string }; url?: string }): ResourceRef | undefined {
  const params = request.params ?? {};
  const path = request.routeOptions?.url ?? request.url ?? '';
  if (params.job_id) return { kind: 'job', id: params.job_id };
  if (params.runId && path.startsWith('/pipeline-runs/')) return { kind: 'pipeline_run', id: params.runId };
  if (params.build_id && path.startsWith('/builds/')) return { kind: 'build', id: params.build_id };
  if (params.thread_id && path.startsWith('/threads/')) return { kind: 'thread', id: params.thread_id };
  return undefined;
}

function extractPathOrgId(request: { params?: Record<string, string>; routeOptions?: { url?: string }; url?: string }): string | undefined {
  const params = request.params ?? {};
  if (params.org_id) return params.org_id;

  if (params.id) {
    const path = request.routeOptions?.url ?? request.url ?? '';
    if (path.startsWith('/orgs/')) {
      return params.id;
    }
  }

  return undefined;
}

/** Only consulted for routes that carry no project, resource or org in their path. */
function extractBodyOrgId(request: { body?: any }): string | undefined {
  return request.body?.org_id ? (request.body.org_id as string) : undefined;
}
