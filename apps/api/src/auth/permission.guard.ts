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
import { PERMISSION_KEY } from './permission.decorator.js';
import { expandPermissions, hasAnyPermission, type Permission } from './permissions.js';

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

    // No @RequirePermission decorator:
    // - User tokens pass (backwards-compat during migration)
    // - Job, service, and service principal tokens are blocked (they must have explicit permissions)
    if (!required || required.length === 0) {
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
    const effective = await this.resolvePermissions(user, request);

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
   */
  private async resolvePermissions(
    user: AuthUser,
    request: any,
  ): Promise<ReadonlySet<string>> {
    const projectId = extractProjectId(request);
    const resource = projectId ? undefined : extractResourceRef(request);

    // Job, service, and service principal tokens carry explicit permissions,
    // but may only address resources owned by the project (or org) they were minted for.
    if (user.is_job_token || user.is_service_token || user.is_service_principal) {
      if (resource) {
        await this.assertTokenMayAddressResource(user, resource);
      }
      return new Set(user.permissions ?? []);
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
      orgId = extractOrgId(request);
    }

    if (orgId) {
      return this.rbacService.getEffectivePermissions(user.user_id, orgId, contextProjectId);
    }

    // No org, project, or job context — use member baseline
    return expandPermissions('member');
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

function extractOrgId(request: { params?: Record<string, string>; routeOptions?: { url?: string }; url?: string; body?: any }): string | undefined {
  const params = request.params ?? {};
  if (params.org_id) return params.org_id;

  if (params.id) {
    const path = request.routeOptions?.url ?? request.url ?? '';
    if (path.startsWith('/orgs/')) {
      return params.id;
    }
  }

  // Only consulted for routes that carry no project or job context.
  if (request.body?.org_id) {
    return request.body.org_id as string;
  }

  return undefined;
}
