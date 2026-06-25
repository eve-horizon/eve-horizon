import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import type {
  AccessCanResponse,
  AccessExplainResponse,
  AccessPrincipalMembershipsResponse,
} from '@eve/shared';
import { RequirePermission } from './permission.decorator.js';
import { RbacService } from './rbac.service.js';
import { AccessService } from './access.service.js';
import type { AuthUser } from './auth.service.js';

@ApiTags('access')
@ApiBearerAuth()
@Controller('orgs/:org_id/access')
export class AccessController {
  constructor(
    private readonly accessService: AccessService,
    private readonly rbacService: RbacService,
  ) {}

  @Get('can')
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Check if a principal can perform an action' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiQuery({ name: 'principal_type', enum: ['user', 'service_principal', 'group'], required: true })
  @ApiQuery({ name: 'principal_id', required: true, description: 'User ID or Service Principal ID' })
  @ApiQuery({ name: 'project_id', required: false, description: 'Optional project scope' })
  @ApiQuery({ name: 'permission', required: true, description: 'Permission to check' })
  @ApiQuery({ name: 'resource_type', enum: ['orgfs', 'orgdocs', 'envdb'], required: false })
  @ApiQuery({ name: 'resource_id', required: false, description: 'Resource path or table identifier' })
  @ApiQuery({ name: 'action', enum: ['read', 'write', 'admin'], required: false })
  async can(
    @Param('org_id') orgId: string,
    @Query('principal_type') principalType: string,
    @Query('principal_id') principalId: string,
    @Query('project_id') projectId: string | undefined,
    @Query('permission') permission: string,
    @Query('resource_type') resourceType: string | undefined,
    @Query('resource_id') resourceId: string | undefined,
    @Query('action') action: string | undefined,
    @Req() request: { user?: AuthUser },
  ): Promise<AccessCanResponse> {
    const user = request.user;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    // Require org admin (beyond the decorator check, enforce for non-system-admins)
    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    this.validatePrincipalType(principalType);
    this.validateRequired('principal_id', principalId);
    this.validateRequired('permission', permission);
    const resource = this.parseResourceContext(resourceType, resourceId, action, permission);

    return this.accessService.can({
      org_id: orgId,
      principal_type: principalType as 'user' | 'service_principal' | 'group',
      principal_id: principalId,
      project_id: projectId || undefined,
      permission,
      resource,
    });
  }

  @Get('explain')
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Explain permission resolution chain for a principal' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiQuery({ name: 'principal_type', enum: ['user', 'service_principal', 'group'], required: true })
  @ApiQuery({ name: 'principal_id', required: true, description: 'User ID or Service Principal ID' })
  @ApiQuery({ name: 'project_id', required: false, description: 'Optional project scope' })
  @ApiQuery({ name: 'permission', required: true, description: 'Permission to explain' })
  @ApiQuery({ name: 'resource_type', enum: ['orgfs', 'orgdocs', 'envdb'], required: false })
  @ApiQuery({ name: 'resource_id', required: false, description: 'Resource path or table identifier' })
  @ApiQuery({ name: 'action', enum: ['read', 'write', 'admin'], required: false })
  async explain(
    @Param('org_id') orgId: string,
    @Query('principal_type') principalType: string,
    @Query('principal_id') principalId: string,
    @Query('project_id') projectId: string | undefined,
    @Query('permission') permission: string,
    @Query('resource_type') resourceType: string | undefined,
    @Query('resource_id') resourceId: string | undefined,
    @Query('action') action: string | undefined,
    @Req() request: { user?: AuthUser },
  ): Promise<AccessExplainResponse> {
    const user = request.user;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    this.validatePrincipalType(principalType);
    this.validateRequired('principal_id', principalId);
    this.validateRequired('permission', permission);
    const resource = this.parseResourceContext(resourceType, resourceId, action, permission);

    return this.accessService.explain({
      org_id: orgId,
      principal_type: principalType as 'user' | 'service_principal' | 'group',
      principal_id: principalId,
      project_id: projectId || undefined,
      permission,
      resource,
    });
  }

  @Get('principals/:principal_type/:principal_id/memberships')
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Inspect memberships/bindings/effective scopes for a principal' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'principal_type', enum: ['user', 'service_principal', 'group'] })
  @ApiParam({ name: 'principal_id', description: 'Principal ID' })
  async memberships(
    @Param('org_id') orgId: string,
    @Param('principal_type') principalType: string,
    @Param('principal_id') principalId: string,
    @Req() request: { user?: AuthUser },
  ): Promise<AccessPrincipalMembershipsResponse> {
    const user = request.user;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    this.validatePrincipalType(principalType);
    this.validateRequired('principal_id', principalId);

    return this.accessService.memberships({
      org_id: orgId,
      principal_type: principalType as 'user' | 'service_principal' | 'group',
      principal_id: principalId,
    });
  }

  private validatePrincipalType(type: string): void {
    if (type !== 'user' && type !== 'service_principal' && type !== 'group') {
      throw new BadRequestException(
        `Invalid principal_type: ${type}. Must be 'user', 'service_principal', or 'group'.`,
      );
    }
  }

  private validateRequired(name: string, value: string | undefined): void {
    if (!value || value.trim().length === 0) {
      throw new BadRequestException(`${name} is required`);
    }
  }

  private parseResourceContext(
    resourceType: string | undefined,
    resourceId: string | undefined,
    action: string | undefined,
    permission: string,
  ): { type: 'orgfs' | 'orgdocs' | 'envdb'; id: string; action: 'read' | 'write' | 'admin' } | undefined {
    if (!resourceType && !resourceId && !action) {
      return undefined;
    }

    if (!resourceType) {
      throw new BadRequestException('resource_type is required when resource context is provided');
    }
    if (resourceType !== 'orgfs' && resourceType !== 'orgdocs' && resourceType !== 'envdb') {
      throw new BadRequestException(
        `Invalid resource_type: ${resourceType}. Must be 'orgfs', 'orgdocs', or 'envdb'.`,
      );
    }
    if (!resourceId || resourceId.trim().length === 0) {
      throw new BadRequestException('resource_id is required when resource_type is provided');
    }

    const normalizedAction = action ?? this.defaultActionForPermission(permission);
    if (normalizedAction !== 'read' && normalizedAction !== 'write' && normalizedAction !== 'admin') {
      throw new BadRequestException(
        `Invalid action: ${normalizedAction}. Must be 'read', 'write', or 'admin'.`,
      );
    }

    return {
      type: resourceType,
      id: resourceId,
      action: normalizedAction,
    };
  }

  private defaultActionForPermission(permission: string): 'read' | 'write' | 'admin' {
    if (permission.endsWith(':admin')) return 'admin';
    if (permission.endsWith(':write')) return 'write';
    return 'read';
  }
}
