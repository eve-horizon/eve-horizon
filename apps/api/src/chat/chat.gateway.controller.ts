import {
  Body,
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ChatRouteBySlugRequestSchema,
  ChatRouteResponseSchema,
  ChatListenRequestSchema,
  ChatListenResponseSchema,
  ChatUnlistenResponseSchema,
  ChatListenersRequestSchema,
  ChatListenersResponseSchema,
  ChatDispatchRequestSchema,
  ChatDispatchResponseSchema,
  type ChatRouteBySlugRequest,
  type ChatRouteResponse,
  type ChatListenRequest,
  type ChatListenResponse,
  type ChatUnlistenResponse,
  type ChatListenersRequest,
  type ChatListenersResponse,
  type ChatDispatchRequest,
  type ChatDispatchResponse,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { ChatService } from './chat.service.js';
import { Inject } from '@nestjs/common';
import type { Db } from '@eve/db';
import { agentQueries, orgQueries, teamQueries } from '@eve/db';

@ApiTags('internal')
@Controller('internal/orgs/:org_id/chat')
@UseGuards(InternalTokenGuard)
export class ChatGatewayController {
  private agents: ReturnType<typeof agentQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private teams: ReturnType<typeof teamQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly chatService: ChatService,
  ) {
    this.agents = agentQueries(db);
    this.orgs = orgQueries(db);
    this.teams = teamQueries(db);
  }

  @Public()
  @Post('route')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Route a chat message to an org-scoped agent slug (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(ChatRouteBySlugRequestSchema, 'ChatRouteBySlugRequest') })
  @ApiOkResponse({
    description: 'Chat routed',
    schema: zodSchemaToOpenApi(ChatRouteResponseSchema, 'ChatRouteResponse'),
  })
  async routeBySlug(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(ChatRouteBySlugRequestSchema)) body: ChatRouteBySlugRequest,
  ): Promise<ChatRouteResponse> {
    const org = await this.orgs.findById(orgId);
    if (!org) {
      throw new NotFoundException(`Organization ${orgId} not found`);
    }

    const slugHint = body.agent_slug_hint.trim().toLowerCase();
    let agent = await this.agents.findByOrgAndSlug(orgId, slugHint);
    let slugSource: 'hint' | 'alias' | 'default' = 'hint';
    let resolvedSlug = slugHint;
    let commandText = (body.command_text ?? '').trim();

    if (!agent) {
      agent = await this.agents.findByOrgAndAlias(orgId, slugHint);
      if (agent) {
        slugSource = 'alias';
        resolvedSlug = agent.slug ?? slugHint;
      }
    }

    // If no agent found by slug or alias, check if it's a team name
    if (!agent) {
      const team = await this.teams.findByOrgAndId(orgId, slugHint);
      if (team) {
        // Team found — route via team dispatch (council/fanout/relay)
        // Check gateway policy on the team lead (lead_agent_id is an agent ID, not a slug)
        if (team.lead_agent_id) {
          const projectAgents = await this.agents.listByProject(team.project_id);
          const leadAgent = projectAgents.find((a) => a.id === team.lead_agent_id);
          if (leadAgent) {
            const leadPolicy = leadAgent.gateway_policy ?? 'none';
            if (leadPolicy === 'none') {
              throw new ForbiddenException(`Team '${slugHint}' lead agent is not available via chat`);
            }
            const leadClients = leadAgent.gateway_clients as string[] | null;
            if (leadClients !== null && !leadClients.includes(body.provider)) {
              throw new ForbiddenException(`Team '${slugHint}' is not available via ${body.provider}`);
            }
          }
        }

        commandText = commandText.length > 0 ? commandText : body.raw_text.trim();
        const metadata = {
          ...(body.metadata ?? {}),
          team_id: slugHint,
          slug_source: 'team' as const,
        };

        return this.chatService.routeMessageToTeam(team.project_id, team.id, {
          provider: body.provider,
          account_id: body.account_id,
          channel_id: body.channel_id,
          user_id: body.user_id,
          text: commandText,
          thread_key: body.thread_key,
          metadata,
          hints: body.hints,
        });
      }
    }

    if (!agent) {
      const fallbackSlug = org.default_agent_slug ?? null;
      if (!fallbackSlug) {
        throw new NotFoundException(`Agent or team '${slugHint}' not found and no default agent configured`);
      }
      agent = await this.agents.findByOrgAndSlug(orgId, fallbackSlug);
      if (!agent) {
        throw new NotFoundException(`Default agent slug ${fallbackSlug} not found`);
      }
      slugSource = 'default';
      resolvedSlug = fallbackSlug;
      commandText = body.raw_text.trim();
    }

    // Enforce gateway policy for direct slug-based routing
    const gatewayPolicy = agent.gateway_policy ?? 'none';
    if (gatewayPolicy === 'none') {
      throw new ForbiddenException(`Agent '${resolvedSlug}' is not available via chat`);
    }
    if (gatewayPolicy === 'discoverable') {
      throw new ForbiddenException(
        `Agent '${resolvedSlug}' is not directly addressable. Use a project route or team dispatch.`,
      );
    }

    // Enforce client restrictions
    const gatewayClients = agent.gateway_clients as string[] | null;
    if (gatewayClients !== null && !gatewayClients.includes(body.provider)) {
      throw new ForbiddenException(
        `Agent '${resolvedSlug}' is not available via ${body.provider}`,
      );
    }

    if (commandText.length === 0) {
      commandText = body.raw_text.trim();
    }

    const metadata = {
      ...(body.metadata ?? {}),
      agent_slug: resolvedSlug,
      slug_source: slugSource,
    };

    return this.chatService.routeMessageToAgent(agent.project_id, agent.id, {
      provider: body.provider,
      account_id: body.account_id,
      channel_id: body.channel_id,
      user_id: body.user_id,
      text: commandText,
      thread_key: body.thread_key,
      metadata,
      hints: body.hints,
    }, {
      agent_slug: resolvedSlug,
    });
  }

  @Public()
  @Post('listen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Subscribe an agent slug to a channel or thread (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(ChatListenRequestSchema, 'ChatListenRequest') })
  @ApiOkResponse({
    description: 'Listener subscription updated',
    schema: zodSchemaToOpenApi(ChatListenResponseSchema, 'ChatListenResponse'),
  })
  async listen(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(ChatListenRequestSchema)) body: ChatListenRequest,
  ): Promise<ChatListenResponse> {
    return this.chatService.subscribeAgentToThread(
      orgId,
      body.agent_slug.trim().toLowerCase(),
      body.thread_key,
      body.scope,
      { channel_id: body.channel_id ?? null },
    );
  }

  @Public()
  @Post('unlisten')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a listener subscription (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(ChatListenRequestSchema, 'ChatListenRequest') })
  @ApiOkResponse({
    description: 'Listener subscription removed',
    schema: zodSchemaToOpenApi(ChatUnlistenResponseSchema, 'ChatUnlistenResponse'),
  })
  async unlisten(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(ChatListenRequestSchema)) body: ChatListenRequest,
  ): Promise<ChatUnlistenResponse> {
    return this.chatService.unsubscribeAgentFromThread(
      orgId,
      body.agent_slug.trim().toLowerCase(),
      body.thread_key,
      body.scope,
    );
  }

  @Public()
  @Post('listeners')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List listeners for channel/thread (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(ChatListenersRequestSchema, 'ChatListenersRequest') })
  @ApiOkResponse({
    description: 'Listener list',
    schema: zodSchemaToOpenApi(ChatListenersResponseSchema, 'ChatListenersResponse'),
  })
  async listeners(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(ChatListenersRequestSchema)) body: ChatListenersRequest,
  ): Promise<ChatListenersResponse> {
    const channelKey = body.channel_key ?? null;
    const threadKey = body.thread_key ?? null;
    if (!channelKey && !threadKey) {
      throw new BadRequestException('channel_key or thread_key is required');
    }
    return this.chatService.listListeners(orgId, channelKey, threadKey);
  }

  @Public()
  @Post('dispatch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dispatch a message to all listeners (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(ChatDispatchRequestSchema, 'ChatDispatchRequest') })
  @ApiOkResponse({
    description: 'Dispatch result',
    schema: zodSchemaToOpenApi(ChatDispatchResponseSchema, 'ChatDispatchResponse'),
  })
  async dispatch(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(ChatDispatchRequestSchema)) body: ChatDispatchRequest,
  ): Promise<ChatDispatchResponse> {
    return this.chatService.dispatchToListeners(orgId, body);
  }
}
