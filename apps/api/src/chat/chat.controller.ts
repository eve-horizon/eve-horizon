import { Controller, Post, Body, Param, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  ChatRouteRequestSchema,
  ChatRouteResponseSchema,
  ChatSimulateRequestSchema,
  type ChatRouteRequest,
  type ChatRouteResponse,
  type ChatSimulateRequest,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { ChatService } from './chat.service.js';
import { RequirePermission } from '../auth/permission.decorator.js';
import type { AuthUser } from '../auth/auth.service.js';

@ApiTags('chat')
@ApiBearerAuth()
@Controller('projects/:project_id/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @RequirePermission('chat:write')
  @Post('route')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Route a chat message to agents/teams/workflows' })
  @ApiBody({ schema: zodSchemaToOpenApi(ChatRouteRequestSchema, 'ChatRouteRequest') })
  @ApiOkResponse({
    description: 'Chat routed',
    schema: zodSchemaToOpenApi(ChatRouteResponseSchema, 'ChatRouteResponse'),
  })
  async routeMessage(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(ChatRouteRequestSchema)) body: ChatRouteRequest,
    @Req() request: { user?: AuthUser },
  ): Promise<ChatRouteResponse> {
    return this.chatService.routeMessage(projectId, body, { user: request.user });
  }

  @RequirePermission('chat:write')
  @Post('simulate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Simulate an inbound chat message (test-only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(ChatSimulateRequestSchema, 'ChatSimulateRequest') })
  @ApiOkResponse({
    description: 'Chat routed',
    schema: zodSchemaToOpenApi(ChatRouteResponseSchema, 'ChatRouteResponse'),
  })
  async simulateMessage(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(ChatSimulateRequestSchema)) body: ChatSimulateRequest,
    @Req() request: { user?: AuthUser },
  ): Promise<ChatRouteResponse> {
    const routeRequest: ChatRouteRequest = {
      provider: body.provider,
      account_id: body.team_id,
      channel_id: body.channel_id,
      user_id: body.user_id,
      text: body.text,
      thread_key: body.thread_key,
      metadata: body.metadata,
      hints: body.hints,
    };

    return this.chatService.routeMessage(projectId, routeRequest, { user: request.user });
  }
}
