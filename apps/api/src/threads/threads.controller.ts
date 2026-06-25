import {
  Controller,
  Delete,
  Get,
  Post,
  Body,
  Headers,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  MessageEvent,
  NotFoundException,
  Req,
  Sse,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import {
  ChatRouteResponseSchema,
  ConversationEventListResponseSchema,
  ConversationEventResponseSchema,
  CreateConversationEventRequestSchema,
  CreateThreadMessageRequestSchema,
  ThreadChatRequestSchema,
  ThreadMessageResponseSchema,
  ThreadMessageListResponseSchema,
  ThreadResponseSchema,
  type ChatRouteResponse,
  type ConversationEventListResponse,
  type ConversationEventResponse,
  type CreateConversationEventRequest,
  type CreateThreadMessageRequest,
  type ThreadChatRequest,
  type ThreadMessageResponse,
  type ThreadMessageListResponse,
  type ThreadResponse,
} from '@eve/shared';
import { RequirePermission } from '../auth/permission.decorator.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { RbacService } from '../auth/rbac.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ChatService } from '../chat/chat.service.js';
import { ConversationEventsService, type ConversationEventFilters } from './conversation-events.service.js';
import { ThreadsService } from './threads.service.js';

@ApiTags('threads')
@ApiBearerAuth()
@Controller('threads')
export class ThreadsController {
  constructor(
    private readonly threadsService: ThreadsService,
    private readonly conversationEventsService: ConversationEventsService,
    private readonly chatService: ChatService,
    private readonly rbacService: RbacService,
  ) {}

  @RequirePermission('threads:read')
  @Get(':thread_id')
  @ApiOperation({ summary: 'Get thread by id' })
  @ApiOkResponse({
    description: 'Thread details',
    schema: zodSchemaToOpenApi(ThreadResponseSchema, 'ThreadResponse'),
  })
  async findById(
    @Param('thread_id') threadId: string,
    @Req() request: { user?: { user_id?: string; is_job_token?: boolean; project_id?: string } },
  ): Promise<ThreadResponse> {
    const thread = await this.threadsService.findById(threadId);
    if (!thread || !thread.project_id) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    await this.requireThreadAccess(request, thread.project_id);
    return thread;
  }

  @RequirePermission('threads:read')
  @Get(':thread_id/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream messages in a thread (SSE)' })
  @ApiOkResponse({ description: 'Server-Sent Events stream' })
  async streamMessages(
    @Param('thread_id') threadId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: { user?: { user_id?: string; is_job_token?: boolean; project_id?: string } },
  ): Promise<Observable<MessageEvent>> {
    const thread = await this.threadsService.findById(threadId);
    if (!thread || !thread.project_id) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    await this.requireThreadAccess(request, thread.project_id);
    return this.threadsService.streamMessages(threadId, lastEventId);
  }

  @RequirePermission('threads:read')
  @Get(':thread_id/events/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream normalized conversation events in a thread (SSE)' })
  @ApiQuery({ name: 'kind', required: false, description: 'Comma-separated event kinds to include' })
  @ApiQuery({ name: 'job_id', required: false, description: 'Only include events for this job id' })
  @ApiQuery({ name: 'attempt_id', required: false, description: 'Only include events for this attempt id' })
  @ApiQuery({ name: 'workflow_step', required: false, description: 'Only include events for this workflow step' })
  @ApiQuery({ name: 'source', required: false, description: 'Only include events from this source' })
  @ApiQuery({ name: 'after', required: false, description: 'Replay events after this cursor or event id' })
  @ApiOkResponse({ description: 'Server-Sent Events stream' })
  async streamEvents(
    @Param('thread_id') threadId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('kind') kind?: string,
    @Query('job_id') jobId?: string,
    @Query('attempt_id') attemptId?: string,
    @Query('workflow_step') workflowStep?: string,
    @Query('source') source?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Req() request?: { user?: { user_id?: string; is_job_token?: boolean; project_id?: string } },
  ): Promise<Observable<MessageEvent>> {
    const thread = await this.threadsService.findById(threadId);
    if (!thread || !thread.project_id) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    await this.requireThreadAccess(request!, thread.project_id);
    return this.conversationEventsService.streamEvents(threadId, this.parseEventFilters({
      kind,
      jobId,
      attemptId,
      workflowStep,
      source,
      after,
      limit,
    }), lastEventId);
  }

  @RequirePermission('threads:read')
  @Get(':thread_id/events')
  @ApiOperation({ summary: 'List normalized conversation events in a thread' })
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
  async listEvents(
    @Param('thread_id') threadId: string,
    @Query('kind') kind?: string,
    @Query('job_id') jobId?: string,
    @Query('attempt_id') attemptId?: string,
    @Query('workflow_step') workflowStep?: string,
    @Query('source') source?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Req() request?: { user?: { user_id?: string; is_job_token?: boolean; project_id?: string } },
  ): Promise<ConversationEventListResponse> {
    const thread = await this.threadsService.findById(threadId);
    if (!thread || !thread.project_id) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    await this.requireThreadAccess(request!, thread.project_id);
    return this.conversationEventsService.listEvents(threadId, this.parseEventFilters({
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
  @Get(':thread_id/messages')
  @ApiOperation({ summary: 'List messages in a thread' })
  @ApiQuery({ name: 'since', required: false, description: 'ISO timestamp — return messages after this time' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max messages to return (default 100)' })
  @ApiOkResponse({
    description: 'Thread messages',
    schema: zodSchemaToOpenApi(ThreadMessageListResponseSchema, 'ThreadMessageListResponse'),
  })
  async listMessages(
    @Param('thread_id') threadId: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @Req() request?: { user?: { user_id?: string; is_job_token?: boolean; project_id?: string } },
  ): Promise<ThreadMessageListResponse> {
    const thread = await this.threadsService.findById(threadId);
    if (!thread || !thread.project_id) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    await this.requireThreadAccess(request!, thread.project_id);

    return this.threadsService.listMessages(threadId, {
      since: since ? new Date(since) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @RequirePermission('chat:write')
  @Post(':thread_id/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Continue an existing chat thread and trigger agent processing' })
  @ApiBody({
    schema: zodSchemaToOpenApi(ThreadChatRequestSchema, 'ThreadChatRequest'),
  })
  @ApiOkResponse({
    description: 'Chat routed on existing thread',
    schema: zodSchemaToOpenApi(ChatRouteResponseSchema, 'ChatRouteResponse'),
  })
  async continueChat(
    @Param('thread_id') threadId: string,
    @Body(new ZodValidationPipe(ThreadChatRequestSchema)) body: ThreadChatRequest,
    @Req() request: { user?: { user_id?: string; is_job_token?: boolean; project_id?: string } },
  ): Promise<ChatRouteResponse> {
    const thread = await this.threadsService.findById(threadId);
    if (!thread || !thread.project_id) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    await this.requireThreadAccess(request, thread.project_id);
    return this.chatService.continueThread(threadId, body, { user: request.user as AuthUser | undefined });
  }

  @RequirePermission('threads:write')
  @Post(':thread_id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Post a message to a thread' })
  @ApiBody({
    schema: zodSchemaToOpenApi(CreateThreadMessageRequestSchema, 'CreateThreadMessageRequest'),
  })
  @ApiOkResponse({
    description: 'Thread message created',
    schema: zodSchemaToOpenApi(ThreadMessageResponseSchema, 'ThreadMessageResponse'),
  })
  async createMessage(
    @Param('thread_id') threadId: string,
    @Body(new ZodValidationPipe(CreateThreadMessageRequestSchema)) body: CreateThreadMessageRequest,
    @Req() request: { user?: { user_id?: string; is_job_token?: boolean; project_id?: string } },
  ): Promise<ThreadMessageResponse> {
    const thread = await this.threadsService.findById(threadId);
    if (!thread || !thread.project_id) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    await this.requireThreadAccess(request, thread.project_id);
    return this.threadsService.createMessage(threadId, body);
  }

  @RequirePermission('threads:write')
  @Post(':thread_id/events')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Emit an app-defined conversation event into a thread' })
  @ApiBody({
    schema: zodSchemaToOpenApi(CreateConversationEventRequestSchema, 'CreateConversationEventRequest'),
  })
  @ApiOkResponse({
    description: 'Conversation event created',
    schema: zodSchemaToOpenApi(ConversationEventResponseSchema, 'ConversationEventResponse'),
  })
  async createEvent(
    @Param('thread_id') threadId: string,
    @Body(new ZodValidationPipe(CreateConversationEventRequestSchema)) body: CreateConversationEventRequest,
    @Req() request: { user?: { user_id?: string; is_job_token?: boolean; project_id?: string } },
  ): Promise<ConversationEventResponse> {
    const thread = await this.threadsService.findById(threadId);
    if (!thread || !thread.project_id) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    await this.requireThreadAccess(request, thread.project_id);
    return this.conversationEventsService.createEvent(threadId, body);
  }

  @RequirePermission('threads:admin')
  @Delete(':thread_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a thread and all its messages' })
  @ApiNoContentResponse({ description: 'Thread deleted' })
  async delete(@Param('thread_id') threadId: string): Promise<void> {
    return this.threadsService.delete(threadId);
  }

  /**
   * Check thread access for both user tokens and job tokens.
   * Job tokens get access if their project_id matches the thread's project.
   * User tokens go through RBAC role check.
   */
  private async requireThreadAccess(
    request: { user?: { user_id?: string; is_job_token?: boolean; project_id?: string } },
    projectId: string,
  ): Promise<void> {
    if (!request.user) {
      throw new UnauthorizedException('Missing user context');
    }

    // Job tokens: allow if project matches
    if (request.user.is_job_token) {
      if (request.user.project_id !== projectId) {
        throw new UnauthorizedException('Job token project does not match thread project');
      }
      return;
    }

    // User tokens: RBAC check
    if (!request.user.user_id) {
      throw new UnauthorizedException('Missing user context');
    }
    await this.rbacService.requireProjectRole(request.user.user_id, projectId, 'member');
  }

  private parseEventFilters(input: {
    kind?: string;
    jobId?: string;
    attemptId?: string;
    workflowStep?: string;
    source?: string;
    after?: string;
    limit?: string;
  }): ConversationEventFilters {
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
