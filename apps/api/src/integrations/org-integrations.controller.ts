import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  IntegrationListResponseSchema,
  IntegrationResponseSchema,
  SlackConnectRequestSchema,
  IntegrationTestResponseSchema,
  MembershipRequestListResponseSchema,
  MembershipRequestResponseSchema,
  MembershipRequestApproveRequestSchema,
  IntegrationSettingsUpdateRequestSchema,
  type IntegrationListResponse,
  type IntegrationResponse,
  type SlackConnectRequest,
  type IntegrationTestResponse,
  type MembershipRequestListResponse,
  type MembershipRequestResponse,
  type MembershipRequestApproveRequest,
  type IntegrationSettingsUpdateRequest,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { RequirePermission } from '../auth/permission.decorator.js';
import { IntegrationsService } from './integrations.service.js';

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('orgs/:org_id/integrations')
export class OrgIntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @RequirePermission('integrations:read')
  @Get()
  @ApiOperation({ summary: 'List integrations for an org' })
  @ApiOkResponse({
    description: 'Integrations list',
    schema: zodSchemaToOpenApi(IntegrationListResponseSchema, 'IntegrationListResponse'),
  })
  async list(@Param('org_id') orgId: string): Promise<IntegrationListResponse> {
    const integrations = await this.integrationsService.listByOrg(orgId);
    return { integrations };
  }

  @RequirePermission('integrations:write')
  @Post('slack/connect')
  @ApiOperation({ summary: 'Connect a Slack workspace to an org' })
  @ApiBody({ schema: zodSchemaToOpenApi(SlackConnectRequestSchema, 'SlackConnectRequest') })
  @ApiOkResponse({
    description: 'Slack integration connected',
    schema: zodSchemaToOpenApi(IntegrationResponseSchema, 'IntegrationResponse'),
  })
  async connectSlack(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(SlackConnectRequestSchema)) body: SlackConnectRequest,
  ): Promise<IntegrationResponse> {
    return this.integrationsService.connectSlack(orgId, body);
  }

  @RequirePermission('integrations:write')
  @Post('slack/install-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a shareable Slack install link (no Eve auth needed to redeem)' })
  @ApiBody({ schema: { type: 'object', properties: { ttl_seconds: { type: 'number' } } } })
  @ApiOkResponse({ description: 'Install URL and expiry' })
  async generateSlackInstallToken(
    @Param('org_id') orgId: string,
    @Body() body: { ttl_seconds?: number },
  ): Promise<{ token: string; expires_at: string }> {
    const { token, expiresAt } = this.integrationsService.generateSlackInstallToken(orgId, body?.ttl_seconds);
    return { token, expires_at: expiresAt };
  }

  @RequirePermission('integrations:write')
  @Patch(':integration_id/settings')
  @ApiOperation({ summary: 'Update integration settings (e.g., admin_channel_id)' })
  @ApiParam({ name: 'integration_id', description: 'Integration ID' })
  @ApiBody({ schema: zodSchemaToOpenApi(IntegrationSettingsUpdateRequestSchema, 'IntegrationSettingsUpdateRequest') })
  @ApiOkResponse({
    description: 'Updated integration',
    schema: zodSchemaToOpenApi(IntegrationResponseSchema, 'IntegrationResponse'),
  })
  async updateSettings(
    @Param('org_id') orgId: string,
    @Param('integration_id') integrationId: string,
    @Body(new ZodValidationPipe(IntegrationSettingsUpdateRequestSchema)) body: IntegrationSettingsUpdateRequest,
  ): Promise<IntegrationResponse> {
    return this.integrationsService.updateSettings(integrationId, orgId, body.settings);
  }
}

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('orgs/:org_id/integrations')
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @RequirePermission('integrations:write')
  @Post(':integration_id/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test an integration connection' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'integration_id', description: 'Integration ID' })
  @ApiOkResponse({
    description: 'Integration test status',
    schema: zodSchemaToOpenApi(IntegrationTestResponseSchema, 'IntegrationTestResponse'),
  })
  async test(
    @Param('org_id') orgId: string,
    @Param('integration_id') integrationId: string,
  ): Promise<IntegrationTestResponse> {
    const result = await this.integrationsService.testIntegration(integrationId, orgId);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Membership requests controller
// ---------------------------------------------------------------------------

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('orgs/:org_id/membership-requests')
export class MembershipRequestsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @RequirePermission('integrations:read')
  @Get()
  @ApiOperation({ summary: 'List membership requests for an org' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status (pending, approved, denied)' })
  @ApiOkResponse({
    description: 'Membership requests',
    schema: zodSchemaToOpenApi(MembershipRequestListResponseSchema, 'MembershipRequestListResponse'),
  })
  async list(
    @Param('org_id') orgId: string,
    @Query('status') status?: string,
  ): Promise<MembershipRequestListResponse> {
    const requests = await this.integrationsService.listMembershipRequests(orgId, status);
    return { requests };
  }

  @RequirePermission('integrations:write')
  @Post(':request_id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a membership request' })
  @ApiBody({ schema: zodSchemaToOpenApi(MembershipRequestApproveRequestSchema, 'MembershipRequestApproveRequest') })
  @ApiOkResponse({
    description: 'Approved membership request',
    schema: zodSchemaToOpenApi(MembershipRequestResponseSchema, 'MembershipRequestResponse'),
  })
  async approve(
    @Param('org_id') orgId: string,
    @Param('request_id') requestId: string,
    @Req() request: { user?: { user_id?: string } },
    @Body(new ZodValidationPipe(MembershipRequestApproveRequestSchema)) body: MembershipRequestApproveRequest,
  ): Promise<MembershipRequestResponse> {
    return this.integrationsService.approveMembershipRequest(
      requestId, orgId, request.user?.user_id ?? 'system', body.role, body.email,
    );
  }

  @RequirePermission('integrations:write')
  @Post(':request_id/deny')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deny a membership request' })
  @ApiOkResponse({
    description: 'Denied membership request',
    schema: zodSchemaToOpenApi(MembershipRequestResponseSchema, 'MembershipRequestResponse'),
  })
  async deny(
    @Param('org_id') orgId: string,
    @Param('request_id') requestId: string,
    @Req() request: { user?: { user_id?: string } },
  ): Promise<MembershipRequestResponse> {
    return this.integrationsService.denyMembershipRequest(requestId, orgId, request.user?.user_id ?? 'system');
  }
}
