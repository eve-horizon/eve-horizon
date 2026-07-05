import {
  Controller,
  Body,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { parseBoolean, parseOptionalDate } from '../common/query-params.js';
import { ApiTags, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { OrgsService } from './orgs.service.js';
import {
  CreateOrgRequestSchema,
  UpdateOrgRequestSchema,
  OrgScopedInviteRequestSchema,
  type CreateOrgRequest,
  type UpdateOrgRequest,
  type OrgListResponse,
  type OrgResponse,
  type OrgMemberRequest,
  type OrgMemberResponse,
  type OrgMemberListResponse,
  type OrgAgentDirectoryResponse,
  type OrgSpendResponse,
  type OrgScopedInviteRequest,
  type OrgInviteResponse,
  type OrgInviteListResponse,
  OrgListResponseSchema,
  OrgResponseSchema,
  OrgMemberRequestSchema,
  OrgMemberResponseSchema,
  OrgMemberListResponseSchema,
  OrgAgentDirectoryResponseSchema,
  OrgSpendResponseSchema,
  OrgInviteResponseSchema,
  OrgInviteListResponseSchema,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { Endpoint } from '../common/endpoint.decorator.js';
import { CurrentUser } from '../common/request-decorators.js';
import type { AuthUser } from '../auth/auth.types.js';


@ApiTags('orgs')
@ApiBearerAuth()
@Controller('orgs')
export class OrgsController {
  constructor(private readonly orgsService: OrgsService) {}

  @Endpoint({
    method: 'POST',
    permission: 'orgs:create',
    status: HttpStatus.CREATED,
    summary: 'Create an org',
    body: CreateOrgRequestSchema,
    bodyName: 'CreateOrgRequest',
    response: OrgResponseSchema,
    responseName: 'OrgResponse',
  })
  async create(
    @Body(new ZodValidationPipe(CreateOrgRequestSchema)) body: CreateOrgRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<OrgResponse> {
    if (body.owner_user_id && !caller?.is_admin) {
      throw new ForbiddenException('Only admins can set owner_user_id');
    }
    return this.orgsService.create(body, caller?.user_id);
  }

  @Endpoint({
    method: 'POST',
    path: 'ensure',
    permission: 'orgs:create',
    status: HttpStatus.OK,
    summary: 'Ensure an org exists by id or name (case-insensitive unique name)',
    body: CreateOrgRequestSchema,
    bodyName: 'CreateOrgRequest',
    response: OrgResponseSchema,
    responseName: 'OrgResponse',
  })
  async ensure(
    @Body(new ZodValidationPipe(CreateOrgRequestSchema)) body: CreateOrgRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<OrgResponse> {
    if (body.owner_user_id && !caller?.is_admin) {
      throw new ForbiddenException('Only admins can set owner_user_id');
    }
    return this.orgsService.ensure(body, caller?.user_id);
  }

  @Endpoint({
    method: 'GET',
    permission: 'orgs:read',
    summary: 'List orgs',
    extraDecorators: [
      ApiQuery({ name: 'limit', required: false }),
      ApiQuery({ name: 'offset', required: false }),
      ApiQuery({ name: 'include_deleted', required: false }),
      ApiQuery({ name: 'name', required: false }),
    ],
    response: OrgListResponseSchema,
    responseName: 'OrgListResponse',
  })
  async list(
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() caller: AuthUser | undefined,
    @Query('include_deleted') includeDeleted?: string,
    @Query('name') name?: string,
  ): Promise<OrgListResponse> {
    return this.orgsService.list({
      limit,
      offset,
      include_deleted: parseBoolean(includeDeleted),
      name,
      user_id: caller?.user_id,
    });
  }

  @Endpoint({
    method: 'GET',
    path: ':org_id',
    permission: 'orgs:read',
    summary: 'Get org by id',
    extraDecorators: [
      ApiQuery({ name: 'include_deleted', required: false }),
    ],
    response: OrgResponseSchema,
    responseName: 'OrgResponse',
  })
  async findById(
    @Param('org_id') orgId: string,
    @Query('include_deleted') includeDeleted?: string,
  ): Promise<OrgResponse> {
    const org = await this.orgsService.findById(orgId, parseBoolean(includeDeleted));
    if (!org) {
      throw new NotFoundException(`Organization ${orgId} not found`);
    }
    return org;
  }

  @Endpoint({
    method: 'GET',
    path: ':org_id/spend',
    permission: 'orgs:read',
    summary: 'Get spend aggregation for an org',
    extraDecorators: [
      ApiQuery({ name: 'since', required: false, description: 'ISO timestamp (inclusive)' }),
      ApiQuery({ name: 'until', required: false, description: 'ISO timestamp (inclusive)' }),
      ApiQuery({ name: 'currency', required: false, description: 'Billing currency (e.g. usd)' }),
    ],
    response: OrgSpendResponseSchema,
    responseName: 'OrgSpendResponse',
  })
  async spend(
    @Param('org_id') orgId: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('currency') currency?: string,
  ): Promise<OrgSpendResponse> {
    return this.orgsService.getSpend(orgId, {
      since: parseOptionalDate(since),
      until: parseOptionalDate(until),
      currency,
    });
  }

  @Endpoint({
    method: 'GET',
    path: ':org_id/agents',
    permission: 'orgs:read',
    summary: 'List agent directory for org',
    response: OrgAgentDirectoryResponseSchema,
    responseName: 'OrgAgentDirectoryResponse',
  })
  async listAgents(
    @Param('org_id') orgId: string,
  ): Promise<OrgAgentDirectoryResponse> {
    return this.orgsService.listAgentDirectory(orgId);
  }

  @Endpoint({
    method: 'PATCH',
    path: ':org_id',
    permission: 'orgs:write',
    summary: 'Update org',
    body: UpdateOrgRequestSchema,
    bodyName: 'UpdateOrgRequest',
    response: OrgResponseSchema,
    responseName: 'OrgResponse',
  })
  async update(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(UpdateOrgRequestSchema)) body: UpdateOrgRequest
  ): Promise<OrgResponse> {
    return this.orgsService.update(orgId, body);
  }

  // ── Members ─────────────────────────────────────────────────────────

  @Endpoint({
    method: 'POST',
    path: ':org_id/members',
    permission: 'orgs:admin',
    status: HttpStatus.OK,
    summary: 'Add or update an org member',
    body: OrgMemberRequestSchema,
    bodyName: 'OrgMemberRequest',
    response: OrgMemberResponseSchema,
    responseName: 'OrgMemberResponse',
  })
  async addMember(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(OrgMemberRequestSchema)) body: OrgMemberRequest,
  ): Promise<OrgMemberResponse> {
    return this.orgsService.addMember(orgId, body);
  }

  @Endpoint({
    method: 'GET',
    path: ':org_id/members',
    permission: 'orgs:members:read',
    summary: 'List org members',
    response: OrgMemberListResponseSchema,
    responseName: 'OrgMemberListResponse',
  })
  async listMembers(
    @Param('org_id') orgId: string,
  ): Promise<OrgMemberListResponse> {
    return this.orgsService.listMembers(orgId);
  }

  @Endpoint({
    method: 'GET',
    path: ':org_id/members/search',
    permission: 'orgs:members:read',
    summary: 'Search org members by email or display name prefix',
    extraDecorators: [
      ApiQuery({ name: 'q', required: true, description: 'Search prefix (email or display name)' }),
    ],
    response: OrgMemberListResponseSchema,
    responseName: 'OrgMemberListResponse',
  })
  async searchMembers(
    @Param('org_id') orgId: string,
    @Query('q') query: string,
  ): Promise<OrgMemberListResponse> {
    if (!query || query.trim().length === 0) {
      return { data: [] };
    }
    return this.orgsService.searchMembers(orgId, query.trim());
  }

  // ── Org-Scoped Invites ──────────────────────────────────────────────

  @Endpoint({
    method: 'POST',
    path: ':org_id/invites',
    permission: 'orgs:invite',
    status: HttpStatus.CREATED,
    summary: 'Create an org invite with optional email sending',
    body: OrgScopedInviteRequestSchema,
    bodyName: 'OrgScopedInviteRequest',
    response: OrgInviteResponseSchema,
    responseName: 'OrgInviteResponse',
  })
  async createOrgInvite(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(OrgScopedInviteRequestSchema)) body: OrgScopedInviteRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<OrgInviteResponse> {
    if (!caller?.user_id) {
      throw new BadRequestException('Authorization required');
    }
    return this.orgsService.createOrgInvite(orgId, caller.user_id, body);
  }

  @Endpoint({
    method: 'GET',
    path: ':org_id/invites',
    permission: 'orgs:invite',
    summary: 'List org invites',
    response: OrgInviteListResponseSchema,
    responseName: 'OrgInviteListResponse',
  })
  async listOrgInvites(
    @Param('org_id') orgId: string,
  ): Promise<OrgInviteListResponse> {
    return this.orgsService.listOrgInvites(orgId);
  }

  @Endpoint({
    method: 'DELETE',
    path: ':org_id',
    permission: 'orgs:admin',
    status: HttpStatus.NO_CONTENT,
    summary: 'Delete an organization (soft or hard delete)',
    extraDecorators: [
      ApiQuery({ name: 'hard', required: false, description: 'Hard delete — physically removes all data' }),
      ApiQuery({ name: 'force', required: false, description: 'Continue on partial failures' }),
    ],
    responseDescription: 'Organization deleted',
  })
  async deleteOrg(
    @Param('org_id') orgId: string,
    @Query('hard') hard?: string,
    @Query('force') force?: string,
  ): Promise<void> {
    return this.orgsService.deleteOrg(orgId, {
      hard: hard === 'true',
      force: force === 'true',
    });
  }

  @Endpoint({
    method: 'DELETE',
    path: ':org_id/members/:user_id',
    permission: 'orgs:admin',
    status: HttpStatus.NO_CONTENT,
    summary: 'Remove an org member',
    responseDescription: 'Member removed',
  })
  async removeMember(
    @Param('org_id') orgId: string,
    @Param('user_id') userId: string,
  ): Promise<void> {
    await this.orgsService.removeMember(orgId, userId);
  }
}
