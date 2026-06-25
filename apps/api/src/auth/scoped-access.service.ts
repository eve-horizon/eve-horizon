import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthUser } from './auth.service.js';
import { AuthService } from './auth.service.js';
import { AccessService } from './access.service.js';
import { buildApiError } from '../system/api-errors.js';

export type ScopedResourceContext = {
  type: 'orgfs' | 'orgdocs' | 'envdb' | 'cloud_fs';
  id: string;
  action: 'read' | 'write' | 'admin';
};

type AccessPrincipal = {
  principal_type: 'user' | 'service_principal';
  principal_id: string;
};

@Injectable()
export class ScopedAccessService {
  constructor(
    private readonly authService: AuthService,
    private readonly accessService: AccessService,
  ) {}

  async can(params: {
    org_id: string;
    permission: string;
    user?: AuthUser;
    project_id?: string;
    resource?: ScopedResourceContext;
  }): Promise<boolean> {
    // Job tokens carry explicit permissions — check those directly
    // rather than going through access groups (job principals aren't org members)
    if (params.user?.is_job_token && params.user.permissions) {
      if (!params.user.permissions.includes(params.permission)) {
        return false;
      }
      if (!params.user.scope) {
        return true;
      }
      const scopeEval = this.accessService.evaluateScope(
        params.user.scope,
        params.permission,
        params.resource,
      );
      return !scopeEval.scope_required || scopeEval.scope_matched;
    }

    const principal = this.resolvePrincipal(params.user);
    if (!principal) {
      return true;
    }

    const result = await this.accessService.can({
      org_id: params.org_id,
      principal_type: principal.principal_type,
      principal_id: principal.principal_id,
      project_id: params.project_id,
      permission: params.permission,
      resource: params.resource,
    });

    return result.allowed;
  }

  async assert(params: {
    org_id: string;
    permission: string;
    user?: AuthUser;
    project_id?: string;
    resource?: ScopedResourceContext;
    request_id?: string;
  }): Promise<void> {
    const allowed = await this.can(params);
    if (allowed) {
      return;
    }

    throw buildApiError(
      403,
      'resource_access_denied',
      params.resource
        ? `Access denied for resource: ${params.resource.type}:${params.resource.id}`
        : `Access denied for permission: ${params.permission}`,
      {
        requestId: params.request_id,
        details: {
          permission: params.permission,
          resource: params.resource ?? null,
        },
      },
    );
  }

  private resolvePrincipal(user?: AuthUser): AccessPrincipal | null {
    if (!this.authService.isEnabled()) {
      return null;
    }

    if (!user?.user_id) {
      throw new UnauthorizedException('Missing user context');
    }

    return {
      principal_type: user.is_service_principal ? 'service_principal' : 'user',
      principal_id: user.user_id,
    };
  }
}
