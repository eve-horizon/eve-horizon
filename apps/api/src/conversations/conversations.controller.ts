import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Param,
  Post,
  Query,
  Req,
  Sse,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import {
  ConversationEventListResponseSchema,
  ConversationEventResponseSchema,
  ConversationResponseSchema,
  ConversationTurnRequestSchema,
  ConversationTurnResponseSchema,
  CreateConversationEventRequestSchema,
  EnsureConversationRequestSchema,
  ThreadMessageListResponseSchema,
  type ConversationEventListResponse,
  type ConversationEventResponse,
  type ConversationResponse,
  type ConversationTurnRequest,
  type ConversationTurnResponse,
  type CreateConversationEventRequest,
  type EnsureConversationRequest,
  type ThreadMessageListResponse,
} from '@eve/shared';
import { RequirePermission } from '../auth/permission.decorator.js';
import type { AuthUser } from '../auth/auth.service.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { ConversationsService } from './conversations.service.js';

@ApiTags('conversations')
@ApiBearerAuth()
@Controller('projects/:project_id/conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @RequirePermission('chat:write')
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Find or create an embedded app conversation' })
  @ApiBody({ schema: zodSchemaToOpenApi(EnsureConversationRequestSchema, 'EnsureConversationRequest') })
  @ApiOkResponse({
    description: 'Conversation resolved',
    schema: zodSchemaToOpenApi(ConversationResponseSchema, 'ConversationResponse'),
  })
  async ensure(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(EnsureConversationRequestSchema)) body: EnsureConversationRequest,
    @Req() request: { user?: AuthUser },
  ): Promise<ConversationResponse> {
    return this.conversationsService.ensure(projectId, body, { user: request.user });
  }

  @RequirePermission('threads:read')
  @Get(':app_key')
  @ApiOperation({ summary: 'Resolve an app conversation key to an Eve thread' })
  @ApiQuery({ name: 'app_id', required: false, description: 'Optional app id when multiple apps may use the same app_key' })
  @ApiOkResponse({
    description: 'Conversation resolved',
    schema: zodSchemaToOpenApi(ConversationResponseSchema, 'ConversationResponse'),
  })
  async resolve(
    @Param('project_id') projectId: string,
    @Param('app_key') appKey: string,
    @Query('app_id') appId?: string,
  ): Promise<ConversationResponse> {
    return this.conversationsService.resolve(projectId, appKey, appId);
  }

  @RequirePermission('chat:write')
  @Post(':app_key/turns')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Append a user turn and route it through Eve chat' })
  @ApiBody({ schema: zodSchemaToOpenApi(ConversationTurnRequestSchema, 'ConversationTurnRequest') })
  @ApiOkResponse({
    description: 'Turn routed',
    schema: zodSchemaToOpenApi(ConversationTurnResponseSchema, 'ConversationTurnResponse'),
  })
  async sendTurn(
    @Param('project_id') projectId: string,
    @Param('app_key') appKey: string,
    @Body(new ZodValidationPipe(ConversationTurnRequestSchema)) body: ConversationTurnRequest,
    @Req() request: { user?: AuthUser },
  ): Promise<ConversationTurnResponse> {
    return this.conversationsService.sendTurn(projectId, appKey, body, { user: request.user });
  }

  @RequirePermission('threads:read')
  @Get(':app_key/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream messages for an embedded app conversation' })
  @ApiQuery({ name: 'app_id', required: false, description: 'Optional app id when multiple apps may use the same app_key' })
  @ApiOkResponse({ description: 'Server-Sent Events stream' })
  async stream(
    @Param('project_id') projectId: string,
    @Param('app_key') appKey: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('app_id') appId?: string,
  ): Promise<Observable<MessageEvent>> {
    return this.conversationsService.stream(projectId, appKey, appId, lastEventId);
  }

  @RequirePermission('threads:read')
  @Get(':app_key/events/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream normalized events for an embedded app conversation' })
  @ApiQuery({ name: 'app_id', required: false, description: 'Optional app id when multiple apps may use the same app_key' })
  @ApiQuery({ name: 'kind', required: false, description: 'Comma-separated event kinds to include' })
  @ApiQuery({ name: 'job_id', required: false, description: 'Only include events for this job id' })
  @ApiQuery({ name: 'attempt_id', required: false, description: 'Only include events for this attempt id' })
  @ApiQuery({ name: 'workflow_step', required: false, description: 'Only include events for this workflow step' })
  @ApiQuery({ name: 'source', required: false, description: 'Only include events from this source' })
  @ApiQuery({ name: 'after', required: false, description: 'Replay events after this cursor or event id' })
  @ApiOkResponse({ description: 'Server-Sent Events stream' })
  async streamEvents(
    @Param('project_id') projectId: string,
    @Param('app_key') appKey: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('app_id') appId?: string,
    @Query('kind') kind?: string,
    @Query('job_id') jobId?: string,
    @Query('attempt_id') attemptId?: string,
    @Query('workflow_step') workflowStep?: string,
    @Query('source') source?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<Observable<MessageEvent>> {
    return this.conversationsService.streamEvents(projectId, appKey, appId, lastEventId, this.parseEventFilters({
      kind,
      jobId,
      attemptId,
      workflowStep,
      source,
      after,
      limit,
    }));
  }

  @RequirePermission('threads:read')
  @Get(':app_key/events')
  @ApiOperation({ summary: 'List normalized events for an embedded app conversation' })
  @ApiQuery({ name: 'app_id', required: false, description: 'Optional app id when multiple apps may use the same app_key' })
  @ApiQuery({ name: 'kind', required: false, description: 'Comma-separated event kinds to include' })
  @ApiQuery({ name: 'job_id', required: false, description: 'Only include events for this job id' })
  @ApiQuery({ name: 'attempt_id', required: false, description: 'Only include events for this attempt id' })
  @ApiQuery({ name: 'workflow_step', required: false, description: 'Only include events for this workflow step' })
  @ApiQuery({ name: 'source', required: false, description: 'Only include events from this source' })
  @ApiQuery({ name: 'after', required: false, description: 'Return events after this cursor or event id' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max events to return (default 100)' })
  @ApiOkResponse({
    description: 'Conversation events',
    schema: zodSchemaToOpenApi(ConversationEventListResponseSchema, 'ConversationEventListResponse'),
  })
  async events(
    @Param('project_id') projectId: string,
    @Param('app_key') appKey: string,
    @Query('app_id') appId?: string,
    @Query('kind') kind?: string,
    @Query('job_id') jobId?: string,
    @Query('attempt_id') attemptId?: string,
    @Query('workflow_step') workflowStep?: string,
    @Query('source') source?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<ConversationEventListResponse> {
    return this.conversationsService.events(projectId, appKey, {
      appId,
      ...this.parseEventFilters({
        kind,
        jobId,
        attemptId,
        workflowStep,
        source,
        after,
        limit,
      }),
    });
  }

  @RequirePermission('threads:write')
  @Post(':app_key/events')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Emit an app-defined event into an embedded app conversation' })
  @ApiQuery({ name: 'app_id', required: false, description: 'Optional app id when multiple apps may use the same app_key' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateConversationEventRequestSchema, 'CreateConversationEventRequest') })
  @ApiOkResponse({
    description: 'Conversation event created',
    schema: zodSchemaToOpenApi(ConversationEventResponseSchema, 'ConversationEventResponse'),
  })
  async emitEvent(
    @Param('project_id') projectId: string,
    @Param('app_key') appKey: string,
    @Body(new ZodValidationPipe(CreateConversationEventRequestSchema)) body: CreateConversationEventRequest,
    @Query('app_id') appId?: string,
  ): Promise<ConversationEventResponse> {
    return this.conversationsService.emitEvent(projectId, appKey, body, appId);
  }

  @RequirePermission('threads:read')
  @Get(':app_key/messages')
  @ApiOperation({ summary: 'List messages for an embedded app conversation' })
  @ApiQuery({ name: 'app_id', required: false, description: 'Optional app id when multiple apps may use the same app_key' })
  @ApiQuery({ name: 'since', required: false, description: 'ISO timestamp - return messages after this time' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max messages to return (default 100)' })
  @ApiOkResponse({
    description: 'Conversation messages',
    schema: zodSchemaToOpenApi(ThreadMessageListResponseSchema, 'ThreadMessageListResponse'),
  })
  async messages(
    @Param('project_id') projectId: string,
    @Param('app_key') appKey: string,
    @Query('app_id') appId?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ): Promise<ThreadMessageListResponse> {
    return this.conversationsService.messages(projectId, appKey, {
      appId,
      since: since ? new Date(since) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  private parseEventFilters(input: {
    kind?: string;
    jobId?: string;
    attemptId?: string;
    workflowStep?: string;
    source?: string;
    after?: string;
    limit?: string;
  }) {
    const parsed = input.limit ? Number.parseInt(input.limit, 10) : undefined;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed as number, 1), 500) : undefined;
    return {
      kinds: input.kind ? input.kind.split(',').map(value => value.trim()).filter(Boolean) : undefined,
      jobId: input.jobId,
      attemptId: input.attemptId,
      workflowStep: input.workflowStep,
      source: input.source,
      after: input.after,
      limit,
    };
  }
}
