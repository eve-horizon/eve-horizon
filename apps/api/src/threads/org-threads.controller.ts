import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ThreadResponseSchema,
  ThreadListResponseSchema,
  ThreadMessageResponseSchema,
  ThreadMessageListResponseSchema,
  CreateThreadMessageRequestSchema,
  type CreateThreadMessageRequest,
  type ThreadResponse,
  type ThreadListResponse,
  type ThreadMessageResponse,
  type ThreadMessageListResponse,
} from '@eve/shared';
import { RequirePermission } from '../auth/permission.decorator.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { CurrentUser } from '../common/request-decorators.js';
import { isScopedToken } from '../auth/token-scope.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ThreadsService } from './threads.service.js';

@ApiTags('org-threads')
@ApiBearerAuth()
@Controller('orgs/:org_id/threads')
export class OrgThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  @RequirePermission('threads:write')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create or retrieve an org-scoped thread' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiCreatedResponse({
    description: 'Thread created or retrieved',
    schema: zodSchemaToOpenApi(ThreadResponseSchema, 'ThreadResponse'),
  })
  async create(
    @Param('org_id') orgId: string,
    @Body() body: { key: string; channel?: string },
  ): Promise<ThreadResponse> {
    return this.threads.ensureOrgThread(orgId, body.key, body.channel);
  }

  @RequirePermission('orgs:read')
  @Get()
  @ApiOperation({ summary: 'List org-scoped threads' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiQuery({ name: 'scope', required: false, description: 'Thread scope filter (default: org)' })
  @ApiQuery({ name: 'key_prefix', required: false, description: 'Filter threads by key prefix' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiOkResponse({
    description: 'Org threads list',
    schema: zodSchemaToOpenApi(ThreadListResponseSchema, 'ThreadListResponse'),
  })
  async list(
    @Param('org_id') orgId: string,
    @Query('scope') scope?: string,
    @Query('key_prefix') keyPrefix?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ThreadListResponse> {
    return this.threads.listOrgThreads(orgId, {
      scope: scope ?? 'org',
      keyPrefix,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @RequirePermission('orgs:read')
  @Get(':thread_id')
  @ApiOperation({ summary: 'Get an org-scoped thread by ID' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiParam({ name: 'thread_id', description: 'Thread ID', type: String })
  @ApiOkResponse({
    description: 'Thread details',
    schema: zodSchemaToOpenApi(ThreadResponseSchema, 'ThreadResponse'),
  })
  async show(
    @Param('org_id') orgId: string,
    @Param('thread_id') threadId: string,
    @CurrentUser() caller?: AuthUser,
  ): Promise<ThreadResponse> {
    return this.requireThreadInOrg(orgId, threadId, caller);
  }

  @RequirePermission('threads:write')
  @Post(':thread_id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Post a message to an org thread' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiParam({ name: 'thread_id', description: 'Thread ID', type: String })
  @ApiCreatedResponse({
    description: 'Message created',
    schema: zodSchemaToOpenApi(ThreadMessageResponseSchema, 'ThreadMessageResponse'),
  })
  async postMessage(
    @Param('org_id') orgId: string,
    @Param('thread_id') threadId: string,
    @Body(new ZodValidationPipe(CreateThreadMessageRequestSchema)) body: CreateThreadMessageRequest,
    @CurrentUser() caller?: AuthUser,
  ): Promise<ThreadMessageResponse> {
    await this.requireThreadInOrg(orgId, threadId, caller);
    return this.threads.createMessage(threadId, body);
  }

  @RequirePermission('orgs:read')
  @Get(':thread_id/messages')
  @ApiOperation({ summary: 'List messages in an org thread' })
  @ApiParam({ name: 'org_id', description: 'Organization ID', type: String })
  @ApiParam({ name: 'thread_id', description: 'Thread ID', type: String })
  @ApiQuery({ name: 'since', required: false, description: 'ISO timestamp — return messages after this time' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({
    description: 'Thread messages',
    schema: zodSchemaToOpenApi(ThreadMessageListResponseSchema, 'ThreadMessageListResponse'),
  })
  async listMessages(
    @Param('org_id') orgId: string,
    @Param('thread_id') threadId: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @CurrentUser() caller?: AuthUser,
  ): Promise<ThreadMessageListResponse> {
    await this.requireThreadInOrg(orgId, threadId, caller);
    return this.threads.listMessages(threadId, {
      since: since ? new Date(since) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /**
   * The route authorises the path org, so the thread must belong to it (an
   * org thread of that org or a thread of one of its projects); 404 otherwise.
   * A job or service token, minted for one project, gets only org threads and
   * its own project's threads.
   */
  private async requireThreadInOrg(orgId: string, threadId: string, caller?: AuthUser): Promise<ThreadResponse> {
    const thread = await this.threads.findByIdInOrg(threadId, orgId);
    const projectToken = caller && isScopedToken(caller) && caller.project_id ? caller : undefined;
    if (!thread || (projectToken && thread.project_id && thread.project_id !== projectToken.project_id)) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    return thread;
  }
}
