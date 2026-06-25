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

  private async resolvePermissions(
    user: AuthUser,
    request: any,
  ): Promise<ReadonlySet<string>> {
    // Job, service, and service principal tokens carry explicit permissions
    if (user.is_job_token || user.is_service_token || user.is_service_principal) {
      return new Set(user.permissions ?? []);
    }

    // User tokens: resolve effective permissions (base role + custom roles)
    let orgId = extractOrgId(request);
    const projectId = extractProjectId(request);

    // Derive org context from the project when no explicit org is in the request.
    // This lets endpoints like POST /projects/:slug/manifest resolve permissions
    // through the project's owning org. Throws 404 if the project doesn't exist
    // (instead of silently falling to member baseline).
    if (!orgId && projectId) {
      orgId = await this.rbacService.getProjectOrgId(projectId);
    }

    if (orgId) {
      return this.rbacService.getEffectivePermissions(user.user_id, orgId, projectId);
    }

    // No org or project context — use member baseline
    return expandPermissions('member');
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

function extractOrgId(request: { params?: Record<string, string>; routeOptions?: { url?: string }; url?: string; body?: any }): string | undefined {
  const params = request.params ?? {};
  if (params.org_id) return params.org_id;

  if (params.id) {
    const path = request.routeOptions?.url ?? request.url ?? '';
    if (path.startsWith('/orgs/')) {
      return params.id;
    }
  }

  if (request.body?.org_id) {
    return request.body.org_id as string;
  }

  return undefined;
}
