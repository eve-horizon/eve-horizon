import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ChatRouteRequestSchema,
  ChatRouteResponseSchema,
  ChatDeliverRequestSchema,
  type ChatRouteRequest,
  type ChatRouteResponse,
  type ChatDeliverRequest,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { ChatService } from './chat.service.js';

@ApiTags('internal')
@Controller('internal/projects/:project_id/chat')
@UseGuards(InternalTokenGuard)
export class ChatInternalController {
  constructor(private readonly chatService: ChatService) {}

  @Post('route')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Route a chat message (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(ChatRouteRequestSchema, 'ChatRouteRequest') })
  @ApiOkResponse({
    description: 'Chat routed',
    schema: zodSchemaToOpenApi(ChatRouteResponseSchema, 'ChatRouteResponse'),
  })
  async routeMessage(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(ChatRouteRequestSchema)) body: ChatRouteRequest,
  ): Promise<ChatRouteResponse> {
    return this.chatService.routeMessage(projectId, body);
  }

  @Post('deliver')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deliver an agent result to the originating chat thread (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(ChatDeliverRequestSchema, 'ChatDeliverRequest') })
  @ApiOkResponse({ description: 'Delivery result' })
  async deliverOutbound(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(ChatDeliverRequestSchema)) body: ChatDeliverRequest,
  ) {
    return this.chatService.deliverChatResult({
      projectId,
      job_id: body.job_id,
      thread_id: body.thread_id,
      text: body.text,
      agent_id: body.agent_id,
      progress: body.progress,
    });
  }
}
