import {
  Controller,
  Post,
  Get,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { RbacService } from '../auth/rbac.service.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import {
  CreateWebhookRequestSchema,
  WebhookResponseSchema,
  WebhookListResponseSchema,
  WebhookDeliveryResponseSchema,
  WebhookDeliveryListResponseSchema,
  WebhookReplayRequestSchema,
  WebhookReplayDryRunResponseSchema,
  WebhookReplayResponseSchema,
  WebhookReplayStatusResponseSchema,
  type CreateWebhookRequest,
  type WebhookResponse,
  type WebhookListResponse,
  type WebhookDeliveryResponse,
  type WebhookDeliveryListResponse,
  type WebhookReplayRequest,
  type WebhookReplayDryRunResponse,
  type WebhookReplayResponse,
  type WebhookReplayStatusResponse,
} from '@eve/shared';
import { WebhooksService } from './webhooks.service.js';

@ApiTags('webhooks')
@ApiBearerAuth()
@Controller()
export class WebhooksController {
  constructor(
    private readonly service: WebhooksService,
    private readonly rbacService: RbacService,
  ) {}

  // --------------------------------------------------------------------------
  // Create subscription (org-wide)
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:admin')
  @Post('orgs/:org_id/webhooks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an org-wide webhook subscription' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateWebhookRequestSchema, 'CreateWebhookRequest') })
  @ApiCreatedResponse({
    description: 'Webhook subscription created',
    schema: zodSchemaToOpenApi(WebhookResponseSchema, 'WebhookResponse'),
  })
  async createOrgWebhook(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(CreateWebhookRequestSchema)) body: CreateWebhookRequest,
    @Req() request: { user?: { user_id?: string } },
  ): Promise<WebhookResponse> {
    return this.service.createSubscription(orgId, body, undefined, request.user?.user_id);
  }

  // --------------------------------------------------------------------------
  // Create subscription (project-scoped)
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:admin')
  @Post('projects/:project_id/webhooks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a project-scoped webhook subscription' })
  @ApiParam({ name: 'project_id', description: 'Project ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateWebhookRequestSchema, 'CreateWebhookRequest') })
  @ApiCreatedResponse({
    description: 'Webhook subscription created',
    schema: zodSchemaToOpenApi(WebhookResponseSchema, 'WebhookResponse'),
  })
  async createProjectWebhook(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(CreateWebhookRequestSchema)) body: CreateWebhookRequest,
    @Req() request: { user?: { user_id?: string; org_id?: string } },
  ): Promise<WebhookResponse> {
    const orgId = await this.rbacService.getProjectOrgId(projectId);
    return this.service.createSubscription(orgId, body, projectId, request.user?.user_id);
  }

  // --------------------------------------------------------------------------
  // List subscriptions
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:read')
  @Get('orgs/:org_id/webhooks')
  @ApiOperation({ summary: 'List webhook subscriptions for an org' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiOkResponse({
    description: 'Webhook subscription list',
    schema: zodSchemaToOpenApi(WebhookListResponseSchema, 'WebhookListResponse'),
  })
  async listWebhooks(
    @Param('org_id') orgId: string,
  ): Promise<WebhookListResponse> {
    return this.service.listSubscriptions(orgId);
  }

  // --------------------------------------------------------------------------
  // Get subscription
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:read')
  @Get('orgs/:org_id/webhooks/:wh_id')
  @ApiOperation({ summary: 'Get a webhook subscription' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String })
  @ApiOkResponse({
    description: 'Webhook subscription details',
    schema: zodSchemaToOpenApi(WebhookResponseSchema, 'WebhookResponse'),
  })
  @ApiNotFoundResponse({ description: 'Webhook subscription not found' })
  async getWebhook(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
  ): Promise<WebhookResponse> {
    return this.service.getSubscription(orgId, webhookId);
  }

  // --------------------------------------------------------------------------
  // Delete subscription
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:admin')
  @Delete('orgs/:org_id/webhooks/:wh_id')
  @ApiOperation({ summary: 'Delete a webhook subscription' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String })
  @ApiOkResponse({ description: 'Webhook subscription deleted' })
  @ApiNotFoundResponse({ description: 'Webhook subscription not found' })
  async deleteWebhook(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.service.deleteSubscription(orgId, webhookId);
  }

  // --------------------------------------------------------------------------
  // Enable subscription
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:admin')
  @Patch('orgs/:org_id/webhooks/:wh_id/enable')
  @ApiOperation({ summary: 'Re-enable a disabled webhook subscription' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String })
  @ApiOkResponse({
    description: 'Webhook subscription re-enabled',
    schema: zodSchemaToOpenApi(WebhookResponseSchema, 'WebhookResponse'),
  })
  @ApiNotFoundResponse({ description: 'Webhook subscription not found' })
  async enableWebhook(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
  ): Promise<WebhookResponse> {
    return this.service.enableSubscription(orgId, webhookId);
  }

  // --------------------------------------------------------------------------
  // Delivery log
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:read')
  @Get('orgs/:org_id/webhooks/:wh_id/deliveries')
  @ApiOperation({ summary: 'List delivery attempts for a webhook subscription' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max results (default 50)' })
  @ApiOkResponse({
    description: 'Delivery log',
    schema: zodSchemaToOpenApi(WebhookDeliveryListResponseSchema, 'WebhookDeliveryListResponse'),
  })
  @ApiNotFoundResponse({ description: 'Webhook subscription not found' })
  async listDeliveries(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ): Promise<WebhookDeliveryListResponse> {
    return this.service.listDeliveries(orgId, webhookId, limit);
  }

  // --------------------------------------------------------------------------
  // Replay events
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:admin')
  @Post('orgs/:org_id/webhooks/:wh_id/replays')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Replay webhook events for a subscription' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(WebhookReplayRequestSchema, 'WebhookReplayRequest') })
  @ApiCreatedResponse({
    description: 'Replay created or dry-run summary',
    schema: {
      oneOf: [
        zodSchemaToOpenApi(WebhookReplayResponseSchema, 'WebhookReplayResponse'),
        zodSchemaToOpenApi(WebhookReplayDryRunResponseSchema, 'WebhookReplayDryRunResponse'),
      ],
    },
  })
  async createReplay(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
    @Body(new ZodValidationPipe(WebhookReplayRequestSchema)) body: WebhookReplayRequest,
    @Req() request: { requestId?: string; user?: { user_id?: string } },
  ): Promise<WebhookReplayResponse | WebhookReplayDryRunResponse> {
    return this.service.createReplay(orgId, webhookId, body, request.requestId, request.user?.user_id);
  }

  @RequirePermission('orgs:read')
  @Get('orgs/:org_id/webhooks/:wh_id/replays/:replay_id')
  @ApiOperation({ summary: 'Get webhook replay status' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String })
  @ApiParam({ name: 'replay_id', description: 'Webhook replay ID', type: String })
  @ApiOkResponse({
    description: 'Replay status',
    schema: zodSchemaToOpenApi(WebhookReplayStatusResponseSchema, 'WebhookReplayStatusResponse'),
  })
  async getReplayStatus(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
    @Param('replay_id') replayId: string,
  ): Promise<WebhookReplayStatusResponse> {
    return this.service.getReplayStatus(orgId, webhookId, replayId);
  }

  // --------------------------------------------------------------------------
  // Test event
  // --------------------------------------------------------------------------

  @RequirePermission('orgs:admin')
  @Post('orgs/:org_id/webhooks/:wh_id/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a test webhook event' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String })
  @ApiOkResponse({
    description: 'Test delivery enqueued',
    schema: zodSchemaToOpenApi(WebhookDeliveryResponseSchema, 'WebhookDeliveryResponse'),
  })
  @ApiNotFoundResponse({ description: 'Webhook subscription not found' })
  async testWebhook(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
  ): Promise<WebhookDeliveryResponse> {
    return this.service.sendTestEvent(orgId, webhookId);
  }
}
