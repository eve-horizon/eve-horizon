import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import {
  type Db,
  accessRoleQueries,
  accessGroupQueries,
  type AccessRole,
  type AccessBindingWithRole,
} from '@eve/db';
import {
  generateAccessRoleId,
  generateAccessBindingId,
  CreateAccessRoleRequestSchema,
  UpdateAccessRoleRequestSchema,
  type CreateAccessRoleRequest,
  type UpdateAccessRoleRequest,
  CreateAccessBindingRequestSchema,
  type CreateAccessBindingRequest,
  type AccessRoleResponse,
  type AccessBindingResponse,
  type AccessRoleListResponse,
  type AccessBindingListResponse,
  type AccessBindingScope,
  AccessRoleListResponseSchema,
  AccessBindingListResponseSchema,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { RequirePermission } from './permission.decorator.js';
import { RbacService } from './rbac.service.js';
import type { AuthUser } from './auth.service.js';
import { allPermissions } from './permissions.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { CurrentUser } from '../common/request-decorators.js';

function toRoleResponse(role: AccessRole): AccessRoleResponse {
  return {
    id: role.id,
    org_id: role.org_id,
    name: role.name,
    scope: role.scope,
    permissions: role.permissions,
    description: role.description,
    created_by: role.created_by,
    created_at: role.created_at.toISOString(),
    updated_at: role.updated_at.toISOString(),
  };
}

function toBindingResponse(binding: AccessBindingWithRole): AccessBindingResponse {
  return {
    id: binding.id,
    role_id: binding.role_id,
    role_name: binding.role_name,
    principal_type: binding.principal_type,
    principal_id: binding.principal_id,
    project_id: binding.project_id,
    scope_json: binding.scope_json ?? null,
    created_by: binding.created_by,
    created_at: binding.created_at.toISOString(),
  };
}

@ApiTags('access-roles')
@ApiBearerAuth()
@Controller('orgs/:org_id/access')
export class AccessRolesController {
  private readonly roleQueries: ReturnType<typeof accessRoleQueries>;
  private readonly groupQueries: ReturnType<typeof accessGroupQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly rbacService: RbacService,
  ) {
    this.roleQueries = accessRoleQueries(db);
    this.groupQueries = accessGroupQueries(db);
  }

  // ── Roles CRUD ──────────────────────────────────────────────────────────

  @Post('roles')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Create a custom access role' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  async createRole(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(CreateAccessRoleRequestSchema)) body: CreateAccessRoleRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<AccessRoleResponse> {
    const user = this.requireAuth(caller);

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    // Validate all permissions are from the known catalog
    this.validatePermissions(body.permissions);

    // Block system:* permissions for non-system-admins
    this.blockSystemPermissions(body.permissions, user);

    const id = generateAccessRoleId();
    const role = await this.roleQueries.createRole(
      id,
      orgId,
      body.name,
      body.scope,
      body.permissions,
      body.description ?? null,
      user.is_service_principal ? null : user.user_id,
    );

    return toRoleResponse(role);
  }

  @Get('roles')
  @RequirePermission('orgs:read')
  @ApiOperation({ summary: 'List custom access roles for an org' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiOkResponse({
    description: 'Custom access role list',
    schema: zodSchemaToOpenApi(AccessRoleListResponseSchema, 'AccessRoleListResponse'),
  })
  async listRoles(
    @Param('org_id') orgId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<AccessRoleListResponse> {
    const user = this.requireAuth(caller);

    if (!user.is_admin && !user.is_service_principal) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'member');
    }

    const roles = await this.roleQueries.listRoles(orgId);
    return { data: roles.map(toRoleResponse) };
  }

  @Get('roles/:role_id')
  @RequirePermission('orgs:read')
  @ApiOperation({ summary: 'Get a custom access role' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'role_id', description: 'Role ID' })
  async getRole(
    @Param('org_id') orgId: string,
    @Param('role_id') roleId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<AccessRoleResponse> {
    const user = this.requireAuth(caller);

    if (!user.is_admin && !user.is_service_principal) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'member');
    }

    const role = await this.roleQueries.getRole(orgId, roleId);
    if (!role) {
      throw new NotFoundException('Access role not found');
    }

    return toRoleResponse(role);
  }

  @Patch('roles/:role_id')
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Update a custom access role' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'role_id', description: 'Role ID' })
  async updateRole(
    @Param('org_id') orgId: string,
    @Param('role_id') roleId: string,
    @Body(new ZodValidationPipe(UpdateAccessRoleRequestSchema)) body: UpdateAccessRoleRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<AccessRoleResponse> {
    const user = this.requireAuth(caller);

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    if (body.permissions) {
      this.validatePermissions(body.permissions);
      this.blockSystemPermissions(body.permissions, user);
    }

    const updated = await this.roleQueries.updateRole(orgId, roleId, {
      permissions: body.permissions,
      description: body.description !== undefined ? (body.description ?? null) : undefined,
    });

    if (!updated) {
      throw new NotFoundException('Access role not found');
    }

    return toRoleResponse(updated);
  }

  @Delete('roles/:role_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Delete a custom access role' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'role_id', description: 'Role ID' })
  async deleteRole(
    @Param('org_id') orgId: string,
    @Param('role_id') roleId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<void> {
    const user = this.requireAuth(caller);

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    const deleted = await this.roleQueries.deleteRole(orgId, roleId);
    if (!deleted) {
      throw new NotFoundException('Access role not found');
    }
  }

  // ── Bindings CRUD ───────────────────────────────────────────────────────

  @Post('bindings')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Create an access binding (assign a custom role to a principal)' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  async createBinding(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(CreateAccessBindingRequestSchema)) body: CreateAccessBindingRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<AccessBindingResponse> {
    const user = this.requireAuth(caller);

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    // Resolve role by name
    const role = await this.roleQueries.getRoleByName(orgId, body.role_name);
    if (!role) {
      throw new NotFoundException(`Access role '${body.role_name}' not found in this org`);
    }

    // Validate scope: project-scoped roles require a project_id
    if (role.scope === 'project' && !body.project_id) {
      throw new BadRequestException(
        `Role '${role.name}' is project-scoped — project_id is required when creating a binding`,
      );
    }

    if (body.principal_type === 'group') {
      const group = await this.groupQueries.findGroupById(orgId, body.principal_id);
      if (!group) {
        throw new NotFoundException(`Access group '${body.principal_id}' not found in this org`);
      }
    }

    this.validateBindingScopeForRole(role.name, role.permissions, body.scope_json);

    // Callers cannot bind roles with permissions they don't themselves hold
    // (unless they are system admins)
    if (!user.is_admin) {
      const callerPermissions = await this.rbacService.getEffectivePermissions(
        user.user_id, orgId, body.project_id,
      );
      const unauthorizedPerms = role.permissions.filter((p) => !callerPermissions.has(p));
      if (unauthorizedPerms.length > 0) {
        throw new ForbiddenException(
          `Cannot bind role '${role.name}': you do not hold permissions: ${unauthorizedPerms.join(', ')}`,
        );
      }
    }

    const id = generateAccessBindingId();
    const binding = await this.roleQueries.createBinding(
      id,
      role.id,
      body.principal_type,
      body.principal_id,
      body.project_id ?? null,
      body.scope_json ?? null,
      user.is_service_principal ? null : user.user_id,
    );

    return {
      id: binding.id,
      role_id: binding.role_id,
      role_name: role.name,
      principal_type: binding.principal_type,
      principal_id: binding.principal_id,
      project_id: binding.project_id,
      scope_json: binding.scope_json ?? null,
      created_by: binding.created_by,
      created_at: binding.created_at.toISOString(),
    };
  }

  @Get('bindings')
  @RequirePermission('orgs:read')
  @ApiOperation({ summary: 'List access bindings' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiQuery({ name: 'project_id', required: false, description: 'Filter by project' })
  @ApiQuery({ name: 'principal_type', required: false, description: 'Filter by principal type' })
  @ApiQuery({ name: 'principal_id', required: false, description: 'Filter by principal ID' })
  @ApiOkResponse({
    description: 'Access binding list',
    schema: zodSchemaToOpenApi(AccessBindingListResponseSchema, 'AccessBindingListResponse'),
  })
  async listBindings(
    @Param('org_id') orgId: string,
    @Query('project_id') projectId?: string,
    @Query('principal_type') principalType?: string,
    @Query('principal_id') principalId?: string,
    @CurrentUser() caller?: AuthUser,
  ): Promise<AccessBindingListResponse> {
    const user = this.requireAuth(caller);

    if (!user.is_admin && !user.is_service_principal) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'member');
    }

    const bindings = await this.roleQueries.listBindings({
      orgId,
      projectId: projectId || undefined,
      principalType: principalType || undefined,
      principalId: principalId || undefined,
    });

    return { data: bindings.map(toBindingResponse) };
  }

  @Delete('bindings/:bind_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Delete an access binding' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'bind_id', description: 'Binding ID' })
  async deleteBinding(
    @Param('org_id') orgId: string,
    @Param('bind_id') bindId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<void> {
    const user = this.requireAuth(caller);

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    const deleted = await this.roleQueries.deleteBinding(bindId);
    if (!deleted) {
      throw new NotFoundException('Access binding not found');
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private requireAuth(caller: AuthUser | undefined): AuthUser {
    if (!caller?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }
    return caller;
  }

  private validatePermissions(permissions: string[]): void {
    const known = new Set<string>(allPermissions());
    const invalid = permissions.filter((p) => !known.has(p));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Unknown permissions: ${invalid.join(', ')}. Valid: ${allPermissions().join(', ')}`,
      );
    }
  }

  private blockSystemPermissions(permissions: string[], user: AuthUser): void {
    const systemPerms = permissions.filter((p) => p.startsWith('system:'));
    if (systemPerms.length > 0 && !user.is_admin) {
      throw new ForbiddenException(
        'Only system admins can create roles containing system:* permissions',
      );
    }
  }

  private validateBindingScopeForRole(
    roleName: string,
    permissions: string[],
    scopeJson: AccessBindingScope | undefined,
  ): void {
    const requiresOrgFs = permissions.some((permission) => permission.startsWith('orgfs:'));
    const requiresOrgDocs = permissions.some((permission) => permission.startsWith('orgdocs:'));
    const requiresEnvDb = permissions.some((permission) => permission.startsWith('envdb:'));

    const requiresOrgFsWritable = permissions.includes('orgfs:write') || permissions.includes('orgfs:admin');
    const requiresOrgDocsWritable = permissions.includes('orgdocs:write') || permissions.includes('orgdocs:admin');

    const orgFsAllow = scopeJson?.orgfs?.allow_prefixes?.length ?? 0;
    const orgFsReadOnly = scopeJson?.orgfs?.read_only_prefixes?.length ?? 0;
    const orgDocsAllow = scopeJson?.orgdocs?.allow_prefixes?.length ?? 0;
    const orgDocsReadOnly = scopeJson?.orgdocs?.read_only_prefixes?.length ?? 0;
    const envDbSchemas = scopeJson?.envdb?.schemas?.length ?? 0;
    const envDbTables = scopeJson?.envdb?.tables?.length ?? 0;

    if (requiresOrgFs && orgFsAllow === 0 && orgFsReadOnly === 0) {
      throw new BadRequestException(
        `Role '${roleName}' includes orgfs permissions but binding scope_json.orgfs prefixes are missing`,
      );
    }
    if (requiresOrgFsWritable && orgFsAllow === 0) {
      throw new BadRequestException(
        `Role '${roleName}' includes orgfs write/admin permissions but scope_json.orgfs.allow_prefixes is missing`,
      );
    }

    if (requiresOrgDocs && orgDocsAllow === 0 && orgDocsReadOnly === 0) {
      throw new BadRequestException(
        `Role '${roleName}' includes orgdocs permissions but binding scope_json.orgdocs prefixes are missing`,
      );
    }
    if (requiresOrgDocsWritable && orgDocsAllow === 0) {
      throw new BadRequestException(
        `Role '${roleName}' includes orgdocs write/admin permissions but scope_json.orgdocs.allow_prefixes is missing`,
      );
    }

    if (requiresEnvDb && envDbSchemas === 0 && envDbTables === 0) {
      throw new BadRequestException(
        `Role '${roleName}' includes envdb permissions but binding scope_json.envdb.schemas/tables is missing`,
      );
    }
  }
}
