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
import { RbacService } from './rbac.service.js';
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
   *   - `/projects/:project_id/...` → the project's owning org. A `body.org_id`
   *     is ignored here so the request body cannot steer resolution to another org.
   *   - `/jobs/:job_id/...`          → the job's project and that project's org.
   *   - `/orgs/:org_id/...`          → that org.
   *   - otherwise                    → `body.org_id` when present (e.g. POST /projects),
   *     else no context (member baseline).
   */
  private async resolvePermissions(
    user: AuthUser,
    request: any,
  ): Promise<ReadonlySet<string>> {
    const projectId = extractProjectId(request);
    const jobId = projectId ? undefined : extractJobId(request);

    // Job, service, and service principal tokens carry explicit permissions,
    // but may only address jobs owned by the project (or org) they were minted for.
    if (user.is_job_token || user.is_service_token || user.is_service_principal) {
      if (jobId) {
        await this.assertTokenMayAddressJob(user, jobId);
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
    } else if (jobId) {
      // Throws 404 if the job doesn't exist.
      const job = await this.rbacService.getJobProjectContext(jobId);
      orgId = job.org_id;
      contextProjectId = job.project_id;
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
   * A job/service/service-principal token may only address a job that belongs
   * to its own scope: the job it was minted for (or that job's subtree), then
   * its project, then its org.
   */
  private async assertTokenMayAddressJob(user: AuthUser, jobId: string): Promise<void> {
    if (user.job_id && (jobId === user.job_id || jobId.startsWith(`${user.job_id}.`))) {
      return;
    }

    // Throws 404 if the job doesn't exist.
    const job = await this.rbacService.getJobProjectContext(jobId);

    if (user.project_id) {
      if (user.project_id !== job.project_id) {
        throw new ForbiddenException('Token is not scoped to the project that owns this job');
      }
      return;
    }

    if (user.org_id) {
      if (user.org_id !== job.org_id) {
        throw new ForbiddenException('Token is not scoped to the org that owns this job');
      }
      return;
    }

    throw new ForbiddenException('Token carries no project or org scope for this job');
  }
}

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

function extractJobId(request: { params?: Record<string, string> }): string | undefined {
  const params = request.params ?? {};
  return params.job_id || undefined;
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
