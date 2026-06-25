import {
  Controller,
  Post,
  Get,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse, ApiBody, ApiNoContentResponse, ApiBearerAuth } from '@nestjs/swagger';
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
import { zodSchemaToOpenApi } from '../openapi.js';
import { RequirePermission } from '../auth/permission.decorator.js';

function parseBoolean(value?: string): boolean {
  if (!value) return false;
  return ['true', '1', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

function parseOptionalDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`Invalid date: ${value}`);
  }
  return d;
}

@ApiTags('orgs')
@ApiBearerAuth()
@Controller('orgs')
export class OrgsController {
  constructor(private readonly orgsService: OrgsService) {}

  @RequirePermission('orgs:create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an org' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateOrgRequestSchema, 'CreateOrgRequest') })
  @ApiResponse({ status: 201, schema: zodSchemaToOpenApi(OrgResponseSchema, 'OrgResponse') })
  async create(
    @Body(new ZodValidationPipe(CreateOrgRequestSchema)) body: CreateOrgRequest,
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
  ): Promise<OrgResponse> {
    if (body.owner_user_id && !request.user?.is_admin) {
      throw new ForbiddenException('Only admins can set owner_user_id');
    }
    return this.orgsService.create(body, request.user?.user_id);
  }

  @RequirePermission('orgs:create')
  @Post('ensure')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ensure an org exists by id or name (case-insensitive unique name)' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateOrgRequestSchema, 'CreateOrgRequest') })
  @ApiResponse({ status: 200, schema: zodSchemaToOpenApi(OrgResponseSchema, 'OrgResponse') })
  async ensure(
    @Body(new ZodValidationPipe(CreateOrgRequestSchema)) body: CreateOrgRequest,
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
  ): Promise<OrgResponse> {
    if (body.owner_user_id && !request.user?.is_admin) {
      throw new ForbiddenException('Only admins can set owner_user_id');
    }
    return this.orgsService.ensure(body, request.user?.user_id);
  }

  @RequirePermission('orgs:read')
  @Get()
  @ApiOperation({ summary: 'List orgs' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'include_deleted', required: false })
  @ApiQuery({ name: 'name', required: false })
  @ApiResponse({ status: 200, schema: zodSchemaToOpenApi(OrgListResponseSchema, 'OrgListResponse') })
  async list(
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Req() request: { user?: { user_id?: string } },
    @Query('include_deleted') includeDeleted?: string,
    @Query('name') name?: string,
  ): Promise<OrgListResponse> {
    return this.orgsService.list({
      limit,
      offset,
      include_deleted: parseBoolean(includeDeleted),
      name,
      user_id: request.user?.user_id,
    });
  }

  @RequirePermission('orgs:read')
  @Get(':org_id')
  @ApiOperation({ summary: 'Get org by id' })
  @ApiQuery({ name: 'include_deleted', required: false })
  @ApiResponse({ status: 200, schema: zodSchemaToOpenApi(OrgResponseSchema, 'OrgResponse') })
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

  @RequirePermission('orgs:read')
  @Get(':org_id/spend')
  @ApiOperation({ summary: 'Get spend aggregation for an org' })
  @ApiQuery({ name: 'since', required: false, description: 'ISO timestamp (inclusive)' })
  @ApiQuery({ name: 'until', required: false, description: 'ISO timestamp (inclusive)' })
  @ApiQuery({ name: 'currency', required: false, description: 'Billing currency (e.g. usd)' })
  @ApiResponse({ status: 200, schema: zodSchemaToOpenApi(OrgSpendResponseSchema, 'OrgSpendResponse') })
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

  @RequirePermission('orgs:read')
  @Get(':org_id/agents')

  @ApiOperation({ summary: 'List agent directory for org' })
  @ApiResponse({ status: 200, schema: zodSchemaToOpenApi(OrgAgentDirectoryResponseSchema, 'OrgAgentDirectoryResponse') })
  async listAgents(
    @Param('org_id') orgId: string,
  ): Promise<OrgAgentDirectoryResponse> {
    return this.orgsService.listAgentDirectory(orgId);
  }

  @RequirePermission('orgs:write')
  @Patch(':org_id')

  @ApiOperation({ summary: 'Update org' })
  @ApiBody({ schema: zodSchemaToOpenApi(UpdateOrgRequestSchema, 'UpdateOrgRequest') })
  @ApiResponse({ status: 200, schema: zodSchemaToOpenApi(OrgResponseSchema, 'OrgResponse') })
  async update(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(UpdateOrgRequestSchema)) body: UpdateOrgRequest
  ): Promise<OrgResponse> {
    return this.orgsService.update(orgId, body);
  }

  // ── Members ─────────────────────────────────────────────────────────

  @RequirePermission('orgs:admin')
  @Post(':org_id/members')

  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add or update an org member' })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgMemberRequestSchema, 'OrgMemberRequest') })
  @ApiResponse({ status: 200, schema: zodSchemaToOpenApi(OrgMemberResponseSchema, 'OrgMemberResponse') })
  async addMember(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(OrgMemberRequestSchema)) body: OrgMemberRequest,
  ): Promise<OrgMemberResponse> {
    return this.orgsService.addMember(orgId, body);
  }

  @RequirePermission('orgs:members:read')
  @Get(':org_id/members')

  @ApiOperation({ summary: 'List org members' })
  @ApiResponse({ status: 200, schema: zodSchemaToOpenApi(OrgMemberListResponseSchema, 'OrgMemberListResponse') })
  async listMembers(
    @Param('org_id') orgId: string,
  ): Promise<OrgMemberListResponse> {
    return this.orgsService.listMembers(orgId);
  }

  @RequirePermission('orgs:members:read')
  @Get(':org_id/members/search')
  @ApiOperation({ summary: 'Search org members by email or display name prefix' })
  @ApiQuery({ name: 'q', required: true, description: 'Search prefix (email or display name)' })
  @ApiResponse({ status: 200, schema: zodSchemaToOpenApi(OrgMemberListResponseSchema, 'OrgMemberListResponse') })
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

  @RequirePermission('orgs:invite')
  @Post(':org_id/invites')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an org invite with optional email sending' })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgScopedInviteRequestSchema, 'OrgScopedInviteRequest') })
  @ApiResponse({ status: 201, schema: zodSchemaToOpenApi(OrgInviteResponseSchema, 'OrgInviteResponse') })
  async createOrgInvite(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(OrgScopedInviteRequestSchema)) body: OrgScopedInviteRequest,
    @Req() req: { user?: { user_id?: string } },
  ): Promise<OrgInviteResponse> {
    if (!req.user?.user_id) {
      throw new BadRequestException('Authorization required');
    }
    return this.orgsService.createOrgInvite(orgId, req.user.user_id, body);
  }

  @RequirePermission('orgs:invite')
  @Get(':org_id/invites')
  @ApiOperation({ summary: 'List org invites' })
  @ApiResponse({ status: 200, schema: zodSchemaToOpenApi(OrgInviteListResponseSchema, 'OrgInviteListResponse') })
  async listOrgInvites(
    @Param('org_id') orgId: string,
  ): Promise<OrgInviteListResponse> {
    return this.orgsService.listOrgInvites(orgId);
  }

  @RequirePermission('orgs:admin')
  @Delete(':org_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an organization (soft or hard delete)' })
  @ApiQuery({ name: 'hard', required: false, description: 'Hard delete — physically removes all data' })
  @ApiQuery({ name: 'force', required: false, description: 'Continue on partial failures' })
  @ApiNoContentResponse({ description: 'Organization deleted' })
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

  @RequirePermission('orgs:admin')
  @Delete(':org_id/members/:user_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an org member' })
  @ApiResponse({ status: 204, description: 'Member removed' })
  async removeMember(
    @Param('org_id') orgId: string,
    @Param('user_id') userId: string,
  ): Promise<void> {
    await this.orgsService.removeMember(orgId, userId);
  }
}
