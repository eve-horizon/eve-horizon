import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import {
  type Db,
  accessGroupQueries,
  accessRoleQueries,
  membershipQueries,
  servicePrincipalQueries,
  userQueries,
  type AccessGroup,
  type AccessGroupMember,
} from '@eve/db';
import {
  generateAccessGroupId,
  CreateAccessGroupRequestSchema,
  UpdateAccessGroupRequestSchema,
  CreateAccessGroupMemberRequestSchema,
  type CreateAccessGroupRequest,
  type UpdateAccessGroupRequest,
  type CreateAccessGroupMemberRequest,
  type AccessGroupResponse,
  type AccessGroupListResponse,
  type AccessGroupMemberResponse,
  type AccessGroupMemberListResponse,
  AccessGroupListResponseSchema,
  AccessGroupMemberListResponseSchema,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { RequirePermission } from './permission.decorator.js';
import { RbacService } from './rbac.service.js';
import type { AuthUser } from './auth.service.js';
import { zodSchemaToOpenApi } from '../openapi.js';

function toGroupResponse(group: AccessGroup): AccessGroupResponse {
  return {
    id: group.id,
    org_id: group.org_id,
    name: group.name,
    slug: group.slug,
    description: group.description,
    created_by: group.created_by,
    created_at: group.created_at.toISOString(),
    updated_at: group.updated_at.toISOString(),
  };
}

function toGroupMemberResponse(member: AccessGroupMember): AccessGroupMemberResponse {
  return {
    group_id: member.group_id,
    principal_type: member.principal_type,
    principal_id: member.principal_id,
    added_by: member.added_by,
    created_at: member.created_at.toISOString(),
  };
}

@ApiTags('access-groups')
@ApiBearerAuth()
@Controller('orgs/:org_id/access/groups')
export class AccessGroupsController {
  private readonly groups: ReturnType<typeof accessGroupQueries>;
  private readonly accessRoles: ReturnType<typeof accessRoleQueries>;
  private readonly memberships: ReturnType<typeof membershipQueries>;
  private readonly users: ReturnType<typeof userQueries>;
  private readonly servicePrincipals: ReturnType<typeof servicePrincipalQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly rbacService: RbacService,
  ) {
    this.groups = accessGroupQueries(db);
    this.accessRoles = accessRoleQueries(db);
    this.memberships = membershipQueries(db);
    this.users = userQueries(db);
    this.servicePrincipals = servicePrincipalQueries(db);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Create an access group' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  async create(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(CreateAccessGroupRequestSchema)) body: CreateAccessGroupRequest,
    @Req() request: { user?: AuthUser },
  ): Promise<AccessGroupResponse> {
    const user = this.requireAuth(request);

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    const slug = body.slug ?? this.toSlug(body.name);
    await this.ensureSlugAvailable(orgId, slug);

    const group = await this.groups.createGroup(
      generateAccessGroupId(),
      orgId,
      body.name,
      slug,
      body.description ?? null,
      user.is_service_principal ? null : user.user_id,
    );

    return toGroupResponse(group);
  }

  @Get()
  @RequirePermission('orgs:read')
  @ApiOperation({ summary: 'List access groups for an org' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiOkResponse({
    description: 'Access group list',
    schema: zodSchemaToOpenApi(AccessGroupListResponseSchema, 'AccessGroupListResponse'),
  })
  async list(
    @Param('org_id') orgId: string,
    @Req() request: { user?: AuthUser },
  ): Promise<AccessGroupListResponse> {
    const user = this.requireAuth(request);
    if (!user.is_admin && !user.is_service_principal) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'member');
    }

    const groups = await this.groups.listGroups(orgId);
    return { data: groups.map(toGroupResponse) };
  }

  @Get(':group_id')
  @RequirePermission('orgs:read')
  @ApiOperation({ summary: 'Get an access group by ID or slug' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'group_id', description: 'Group ID (grp_...) or slug' })
  async get(
    @Param('org_id') orgId: string,
    @Param('group_id') groupInput: string,
    @Req() request: { user?: AuthUser },
  ): Promise<AccessGroupResponse> {
    const user = this.requireAuth(request);
    if (!user.is_admin && !user.is_service_principal) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'member');
    }

    const group = await this.resolveGroup(orgId, groupInput);
    return toGroupResponse(group);
  }

  @Patch(':group_id')
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Update an access group by ID or slug' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'group_id', description: 'Group ID (grp_...) or slug' })
  async update(
    @Param('org_id') orgId: string,
    @Param('group_id') groupInput: string,
    @Body(new ZodValidationPipe(UpdateAccessGroupRequestSchema)) body: UpdateAccessGroupRequest,
    @Req() request: { user?: AuthUser },
  ): Promise<AccessGroupResponse> {
    const user = this.requireAuth(request);

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    const current = await this.resolveGroup(orgId, groupInput);

    if (body.slug && body.slug !== current.slug) {
      await this.ensureSlugAvailable(orgId, body.slug);
    }

    const updated = await this.groups.updateGroup(orgId, current.id, {
      name: body.name,
      slug: body.slug,
      description: body.description,
    });

    if (!updated) {
      throw new NotFoundException('Access group not found');
    }

    return toGroupResponse(updated);
  }

  @Delete(':group_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Delete an access group by ID or slug' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'group_id', description: 'Group ID (grp_...) or slug' })
  async delete(
    @Param('org_id') orgId: string,
    @Param('group_id') groupInput: string,
    @Req() request: { user?: AuthUser },
  ): Promise<void> {
    const user = this.requireAuth(request);

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    const group = await this.resolveGroup(orgId, groupInput);
    await this.accessRoles.deleteBindingsForPrincipal(orgId, 'group', group.id);

    const deleted = await this.groups.deleteGroup(orgId, group.id);
    if (!deleted) {
      throw new NotFoundException('Access group not found');
    }
  }

  @Post(':group_id/members')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Add a member principal to an access group' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'group_id', description: 'Group ID (grp_...) or slug' })
  async addMember(
    @Param('org_id') orgId: string,
    @Param('group_id') groupInput: string,
    @Body(new ZodValidationPipe(CreateAccessGroupMemberRequestSchema)) body: CreateAccessGroupMemberRequest,
    @Req() request: { user?: AuthUser },
  ): Promise<AccessGroupMemberResponse> {
    const user = this.requireAuth(request);

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    const group = await this.resolveGroup(orgId, groupInput);
    await this.ensurePrincipalExistsInOrg(orgId, body.principal_type, body.principal_id);

    const member = await this.groups.addMember(
      group.id,
      body.principal_type,
      body.principal_id,
      user.is_service_principal ? null : user.user_id,
    );

    return toGroupMemberResponse(member);
  }

  @Get(':group_id/members')
  @RequirePermission('orgs:read')
  @ApiOperation({ summary: 'List members of an access group' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'group_id', description: 'Group ID (grp_...) or slug' })
  @ApiOkResponse({
    description: 'Access group member list',
    schema: zodSchemaToOpenApi(AccessGroupMemberListResponseSchema, 'AccessGroupMemberListResponse'),
  })
  async listMembers(
    @Param('org_id') orgId: string,
    @Param('group_id') groupInput: string,
    @Req() request: { user?: AuthUser },
  ): Promise<AccessGroupMemberListResponse> {
    const user = this.requireAuth(request);
    if (!user.is_admin && !user.is_service_principal) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'member');
    }

    const group = await this.resolveGroup(orgId, groupInput);
    const members = await this.groups.listMembers(group.id);
    return { data: members.map(toGroupMemberResponse) };
  }

  @Delete(':group_id/members/:principal_type/:principal_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Remove a member principal from an access group' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'group_id', description: 'Group ID (grp_...) or slug' })
  @ApiParam({ name: 'principal_type', enum: ['user', 'service_principal'] })
  @ApiParam({ name: 'principal_id', description: 'Principal ID' })
  async removeMember(
    @Param('org_id') orgId: string,
    @Param('group_id') groupInput: string,
    @Param('principal_type') principalType: string,
    @Param('principal_id') principalId: string,
    @Req() request: { user?: AuthUser },
  ): Promise<void> {
    const user = this.requireAuth(request);

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    if (principalType !== 'user' && principalType !== 'service_principal') {
      throw new BadRequestException(
        `Invalid principal_type: ${principalType}. Must be 'user' or 'service_principal'.`,
      );
    }

    const group = await this.resolveGroup(orgId, groupInput);
    const removed = await this.groups.removeMember(group.id, principalType, principalId);
    if (!removed) {
      throw new NotFoundException(
        `Group member not found: ${principalType}/${principalId} in group ${group.slug}`,
      );
    }
  }

  private requireAuth(request: { user?: AuthUser }): AuthUser {
    if (!request.user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }
    return request.user;
  }

  private async resolveGroup(orgId: string, groupInput: string): Promise<AccessGroup> {
    const byId = await this.groups.findGroupById(orgId, groupInput);
    if (byId) return byId;

    const bySlug = await this.groups.findGroupBySlug(orgId, groupInput);
    if (bySlug) return bySlug;

    throw new NotFoundException(`Access group not found: ${groupInput}`);
  }

  private async ensureSlugAvailable(orgId: string, slug: string): Promise<void> {
    const existing = await this.groups.findGroupBySlug(orgId, slug);
    if (existing) {
      throw new ConflictException(`Access group slug '${slug}' already exists in this org`);
    }
  }

  private async ensurePrincipalExistsInOrg(
    orgId: string,
    principalType: 'user' | 'service_principal',
    principalId: string,
  ): Promise<void> {
    if (principalType === 'service_principal') {
      const sp = await this.servicePrincipals.getServicePrincipal(orgId, principalId);
      if (!sp) {
        throw new NotFoundException(`Service principal '${principalId}' not found in org '${orgId}'`);
      }
      return;
    }

    const user = await this.users.findById(principalId);
    if (!user) {
      throw new NotFoundException(`User '${principalId}' not found`);
    }

    const membership = await this.memberships.findOrgMembership(principalId, orgId);
    if (!membership) {
      throw new NotFoundException(
        `User '${principalId}' is not an org member for '${orgId}'`,
      );
    }
  }

  private toSlug(name: string): string {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
    if (!slug) {
      throw new BadRequestException(
        `Cannot generate a slug from name '${name}'. Provide a slug explicitly.`,
      );
    }
    return slug;
  }
}
