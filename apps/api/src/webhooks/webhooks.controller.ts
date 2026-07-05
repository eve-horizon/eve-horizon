import {
  Controller,
  Body,
  Param,
  Query,
  Req,
  HttpStatus,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { Endpoint } from '../common/endpoint.decorator.js';
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
import { CurrentUser } from '../common/request-decorators.js';
import type { AuthUser } from '../auth/auth.types.js';

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

  @Endpoint({
    method: 'POST',
    path: 'orgs/:org_id/webhooks',
    permission: 'orgs:admin',
    status: HttpStatus.CREATED,
    summary: 'Create an org-wide webhook subscription',
    extraDecorators: [
      ApiParam({ name: 'org_id', description: 'Organization ID', type: String }),
    ],
    body: CreateWebhookRequestSchema,
    bodyName: 'CreateWebhookRequest',
    responseDescription: 'Webhook subscription created',
    response: WebhookResponseSchema,
    responseName: 'WebhookResponse',
  })
  async createOrgWebhook(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(CreateWebhookRequestSchema)) body: CreateWebhookRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<WebhookResponse> {
    return this.service.createSubscription(orgId, body, undefined, caller?.user_id);
  }

  // --------------------------------------------------------------------------
  // Create subscription (project-scoped)
  // --------------------------------------------------------------------------

  @Endpoint({
    method: 'POST',
    path: 'projects/:project_id/webhooks',
    permission: 'orgs:admin',
    status: HttpStatus.CREATED,
    summary: 'Create a project-scoped webhook subscription',
    extraDecorators: [
      ApiParam({ name: 'project_id', description: 'Project ID', type: String }),
    ],
    body: CreateWebhookRequestSchema,
    bodyName: 'CreateWebhookRequest',
    responseDescription: 'Webhook subscription created',
    response: WebhookResponseSchema,
    responseName: 'WebhookResponse',
  })
  async createProjectWebhook(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(CreateWebhookRequestSchema)) body: CreateWebhookRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<WebhookResponse> {
    const orgId = await this.rbacService.getProjectOrgId(projectId);
    return this.service.createSubscription(orgId, body, projectId, caller?.user_id);
  }

  // --------------------------------------------------------------------------
  // List subscriptions
  // --------------------------------------------------------------------------

  @Endpoint({
    method: 'GET',
    path: 'orgs/:org_id/webhooks',
    permission: 'orgs:read',
    summary: 'List webhook subscriptions for an org',
    extraDecorators: [
      ApiParam({ name: 'org_id', description: 'Organization ID', type: String }),
    ],
    responseDescription: 'Webhook subscription list',
    response: WebhookListResponseSchema,
    responseName: 'WebhookListResponse',
  })
  async listWebhooks(
    @Param('org_id') orgId: string,
  ): Promise<WebhookListResponse> {
    return this.service.listSubscriptions(orgId);
  }

  // --------------------------------------------------------------------------
  // Get subscription
  // --------------------------------------------------------------------------

  @Endpoint({
    method: 'GET',
    path: 'orgs/:org_id/webhooks/:wh_id',
    permission: 'orgs:read',
    summary: 'Get a webhook subscription',
    extraDecorators: [
      ApiParam({ name: 'org_id', description: 'Organization ID', type: String }),
      ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String }),
      ApiNotFoundResponse({ description: 'Webhook subscription not found' }),
    ],
    responseDescription: 'Webhook subscription details',
    response: WebhookResponseSchema,
    responseName: 'WebhookResponse',
  })
  async getWebhook(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
  ): Promise<WebhookResponse> {
    return this.service.getSubscription(orgId, webhookId);
  }

  // --------------------------------------------------------------------------
  // Delete subscription
  // --------------------------------------------------------------------------

  @Endpoint({
    method: 'DELETE',
    path: 'orgs/:org_id/webhooks/:wh_id',
    permission: 'orgs:admin',
    summary: 'Delete a webhook subscription',
    extraDecorators: [
      ApiParam({ name: 'org_id', description: 'Organization ID', type: String }),
      ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String }),
      ApiNotFoundResponse({ description: 'Webhook subscription not found' }),
    ],
    responseDescription: 'Webhook subscription deleted',
  })
  async deleteWebhook(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.service.deleteSubscription(orgId, webhookId);
  }

  // --------------------------------------------------------------------------
  // Enable subscription
  // --------------------------------------------------------------------------

  @Endpoint({
    method: 'PATCH',
    path: 'orgs/:org_id/webhooks/:wh_id/enable',
    permission: 'orgs:admin',
    summary: 'Re-enable a disabled webhook subscription',
    extraDecorators: [
      ApiParam({ name: 'org_id', description: 'Organization ID', type: String }),
      ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String }),
      ApiNotFoundResponse({ description: 'Webhook subscription not found' }),
    ],
    responseDescription: 'Webhook subscription re-enabled',
    response: WebhookResponseSchema,
    responseName: 'WebhookResponse',
  })
  async enableWebhook(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
  ): Promise<WebhookResponse> {
    return this.service.enableSubscription(orgId, webhookId);
  }

  // --------------------------------------------------------------------------
  // Delivery log
  // --------------------------------------------------------------------------

  @Endpoint({
    method: 'GET',
    path: 'orgs/:org_id/webhooks/:wh_id/deliveries',
    permission: 'orgs:read',
    summary: 'List delivery attempts for a webhook subscription',
    extraDecorators: [
      ApiParam({ name: 'org_id', description: 'Organization ID', type: String }),
      ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String }),
      ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max results (default 50)' }),
      ApiNotFoundResponse({ description: 'Webhook subscription not found' }),
    ],
    responseDescription: 'Delivery log',
    response: WebhookDeliveryListResponseSchema,
    responseName: 'WebhookDeliveryListResponse',
  })
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

  @Endpoint({
    method: 'POST',
    path: 'orgs/:org_id/webhooks/:wh_id/replays',
    permission: 'orgs:admin',
    status: HttpStatus.CREATED,
    summary: 'Replay webhook events for a subscription',
    // The oneOf response cannot be modelled by the response/responseName
    // options, so both @ApiBody and the response decorator live in
    // extraDecorators — keeping them together preserves the body-then-response
    // schema registration order (see EndpointOptions.extraDecorators).
    extraDecorators: [
      ApiParam({ name: 'org_id', description: 'Organization ID', type: String }),
      ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String }),
      ApiBody({ schema: zodSchemaToOpenApi(WebhookReplayRequestSchema, 'WebhookReplayRequest') }),
      ApiCreatedResponse({
        description: 'Replay created or dry-run summary',
        schema: {
          oneOf: [
            zodSchemaToOpenApi(WebhookReplayResponseSchema, 'WebhookReplayResponse'),
            zodSchemaToOpenApi(WebhookReplayDryRunResponseSchema, 'WebhookReplayDryRunResponse'),
          ],
        },
      }),
    ],
  })
  async createReplay(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
    @Body(new ZodValidationPipe(WebhookReplayRequestSchema)) body: WebhookReplayRequest,
    @Req() request: { requestId?: string; user?: { user_id?: string } },
  ): Promise<WebhookReplayResponse | WebhookReplayDryRunResponse> {
    return this.service.createReplay(orgId, webhookId, body, request.requestId, request.user?.user_id);
  }

  @Endpoint({
    method: 'GET',
    path: 'orgs/:org_id/webhooks/:wh_id/replays/:replay_id',
    permission: 'orgs:read',
    summary: 'Get webhook replay status',
    extraDecorators: [
      ApiParam({ name: 'org_id', description: 'Organization ID', type: String }),
      ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String }),
      ApiParam({ name: 'replay_id', description: 'Webhook replay ID', type: String }),
    ],
    responseDescription: 'Replay status',
    response: WebhookReplayStatusResponseSchema,
    responseName: 'WebhookReplayStatusResponse',
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

  @Endpoint({
    method: 'POST',
    path: 'orgs/:org_id/webhooks/:wh_id/test',
    permission: 'orgs:admin',
    status: HttpStatus.OK,
    summary: 'Send a test webhook event',
    extraDecorators: [
      ApiParam({ name: 'org_id', description: 'Organization ID', type: String }),
      ApiParam({ name: 'wh_id', description: 'Webhook subscription ID', type: String }),
      ApiNotFoundResponse({ description: 'Webhook subscription not found' }),
    ],
    responseDescription: 'Test delivery enqueued',
    response: WebhookDeliveryResponseSchema,
    responseName: 'WebhookDeliveryResponse',
  })
  async testWebhook(
    @Param('org_id') orgId: string,
    @Param('wh_id') webhookId: string,
  ): Promise<WebhookDeliveryResponse> {
    return this.service.sendTestEvent(orgId, webhookId);
  }
}
