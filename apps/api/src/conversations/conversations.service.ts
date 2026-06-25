import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Db } from '@eve/db';
import { agentQueries, teamQueries, threadQueries } from '@eve/db';
import type {
  ChatRouteRequest,
  ChatRouteResponse,
  ConversationEventListResponse,
  ConversationEventResponse,
  ConversationResponse,
  ConversationTarget,
  ConversationTurnRequest,
  ConversationTurnResponse,
  CreateConversationEventRequest,
  EnsureConversationRequest,
  ThreadMessageListResponse,
  ThreadResponse,
} from '@eve/shared';
import { ChatService } from '../chat/chat.service.js';
import { ConversationEventsService, type ConversationEventFilters } from '../threads/conversation-events.service.js';
import { ThreadsService } from '../threads/threads.service.js';
import type { AuthUser } from '../auth/auth.service.js';

type ConversationContext = { user?: AuthUser };

@Injectable()
export class ConversationsService {
  private agents: ReturnType<typeof agentQueries>;
  private teams: ReturnType<typeof teamQueries>;
  private threads: ReturnType<typeof threadQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly chatService: ChatService,
    private readonly threadsService: ThreadsService,
    private readonly conversationEventsService: ConversationEventsService,
  ) {
    this.agents = agentQueries(db);
    this.teams = teamQueries(db);
    this.threads = threadQueries(db);
  }

  async ensure(
    projectId: string,
    request: EnsureConversationRequest,
    ctx?: ConversationContext,
  ): Promise<ConversationResponse> {
    const appId = request.app_id ?? 'default';
    const key = this.canonicalThreadKey(appId, request.app_key);
    await this.threadsService.ensureThread(
      projectId,
      key,
      request.app_key,
      this.buildConversationMetadata(request.app_key, appId, request.metadata),
    );

    if (request.text) {
      await this.sendTurn(projectId, request.app_key, {
        text: request.text,
        app_id: appId,
        actor_id: request.actor_id,
        metadata: request.metadata,
        target: request.target,
        hints: request.hints,
      }, ctx);
    }

    return this.resolve(projectId, request.app_key, appId);
  }

  async resolve(projectId: string, appKey: string, appId?: string): Promise<ConversationResponse> {
    const thread = await this.findConversationThread(projectId, appKey, appId);
    if (!thread) {
      throw new NotFoundException(`Conversation ${appKey} not found`);
    }
    return this.toConversationResponse(thread, appKey, appId);
  }

  async sendTurn(
    projectId: string,
    appKey: string,
    request: ConversationTurnRequest,
    ctx?: ConversationContext,
  ): Promise<ConversationTurnResponse> {
    const existing = await this.findConversationThread(projectId, appKey, request.app_id);
    const appId = request.app_id
      ?? (typeof existing?.metadata?.app_id === 'string' ? existing.metadata.app_id : 'default');
    const key = this.canonicalThreadKey(appId, appKey);
    await this.threadsService.ensureThread(
      projectId,
      key,
      appKey,
      this.buildConversationMetadata(appKey, appId, request.metadata),
    );

    if (!request.target && existing?.metadata?.continuation) {
      const continued = await this.chatService.continueThread(existing.id, {
        text: request.text,
        actor_id: request.actor_id ?? ctx?.user?.user_id,
        metadata: {
          ...(request.metadata ?? {}),
          app_key: appKey,
          app_id: appId,
          product_metadata: request.metadata ?? {},
          ...(ctx?.user?.user_id ? { eve_user_id: ctx.user.user_id } : {}),
        },
        hints: request.hints,
      }, ctx);
      return {
        ...continued,
        app_key: appKey,
        app_id: appId,
        dispatch_status: continued.denied ? 'denied' : continued.job_ids.length > 0 ? 'queued' : 'no_route',
      };
    }

    const routeRequest: ChatRouteRequest = {
      provider: 'app',
      account_id: appId,
      channel_id: appKey,
      user_id: request.actor_id ?? ctx?.user?.user_id,
      text: request.text,
      thread_key: key,
      metadata: {
        ...(request.metadata ?? {}),
        app_key: appKey,
        app_id: appId,
        product_metadata: request.metadata ?? {},
        ...(ctx?.user?.user_id ? { eve_user_id: ctx.user.user_id } : {}),
      },
      hints: request.hints,
    };

    const routed = await this.dispatchTurn(projectId, routeRequest, request.target, ctx);
    return {
      ...routed,
      app_key: appKey,
      app_id: appId,
      dispatch_status: routed.denied ? 'denied' : routed.job_ids.length > 0 ? 'queued' : 'no_route',
    };
  }

  async stream(projectId: string, appKey: string, appId?: string, lastEventId?: string) {
    const thread = await this.findConversationThread(projectId, appKey, appId);
    if (!thread) {
      throw new NotFoundException(`Conversation ${appKey} not found`);
    }
    return this.threadsService.streamMessages(thread.id, lastEventId);
  }

  async events(
    projectId: string,
    appKey: string,
    options: ConversationEventFilters & { appId?: string },
  ): Promise<ConversationEventListResponse> {
    const thread = await this.findConversationThread(projectId, appKey, options.appId);
    if (!thread) {
      throw new NotFoundException(`Conversation ${appKey} not found`);
    }
    return this.conversationEventsService.listEvents(thread.id, options);
  }

  async streamEvents(
    projectId: string,
    appKey: string,
    appId?: string,
    lastEventId?: string,
    filters: ConversationEventFilters = {},
  ) {
    const thread = await this.findConversationThread(projectId, appKey, appId);
    if (!thread) {
      throw new NotFoundException(`Conversation ${appKey} not found`);
    }
    return this.conversationEventsService.streamEvents(thread.id, filters, lastEventId);
  }

  async emitEvent(
    projectId: string,
    appKey: string,
    request: CreateConversationEventRequest,
    appId?: string,
  ): Promise<ConversationEventResponse> {
    const thread = await this.findConversationThread(projectId, appKey, appId);
    if (!thread) {
      throw new NotFoundException(`Conversation ${appKey} not found`);
    }
    return this.conversationEventsService.createEvent(thread.id, request);
  }

  async messages(
    projectId: string,
    appKey: string,
    options: { appId?: string; since?: Date; limit?: number },
  ): Promise<ThreadMessageListResponse> {
    const thread = await this.findConversationThread(projectId, appKey, options.appId);
    if (!thread) {
      throw new NotFoundException(`Conversation ${appKey} not found`);
    }
    return this.threadsService.listMessages(thread.id, {
      since: options.since,
      limit: options.limit,
    });
  }

  private async dispatchTurn(
    projectId: string,
    routeRequest: ChatRouteRequest,
    target: ConversationTarget | undefined,
    ctx?: ConversationContext,
  ): Promise<ChatRouteResponse> {
    if (!target || (target.kind === 'route' && !target.route_id)) {
      return this.chatService.routeMessage(projectId, routeRequest, ctx);
    }

    if (target.kind === 'route') {
      return this.chatService.routeMessageToRoute(projectId, target.route_id!, routeRequest, ctx);
    }

    if (target.kind === 'agent') {
      const agent = await this.resolveRoutableAgent(projectId, target.agent_slug);
      return this.chatService.routeMessageToAgent(projectId, agent.id, routeRequest, {
        agent_slug: agent.slug ?? target.agent_slug,
      }, ctx);
    }

    const team = await this.resolveRoutableTeam(projectId, target.team_id);
    return this.chatService.routeMessageToTeam(projectId, team.id, routeRequest, ctx);
  }

  private async resolveRoutableAgent(projectId: string, slugOrAlias: string) {
    const normalized = slugOrAlias.trim().toLowerCase();
    const agents = await this.agents.listByProject(projectId);
    const agent = agents.find((entry) =>
      entry.slug === normalized || entry.alias?.trim().toLowerCase() === normalized,
    );
    if (!agent) {
      throw new BadRequestException(`Unknown agent ${slugOrAlias}`);
    }
    const policy = agent.gateway_policy ?? 'none';
    if (policy !== 'routable') {
      throw new ForbiddenException(`Agent '${slugOrAlias}' is not directly addressable`);
    }
    if (agent.gateway_clients !== null && !agent.gateway_clients.includes('app')) {
      throw new ForbiddenException(`Agent '${slugOrAlias}' is not available via app conversations`);
    }
    return agent;
  }

  private async resolveRoutableTeam(projectId: string, teamId: string) {
    const teams = await this.teams.listByProject(projectId);
    const team = teams.find((entry) => entry.id === teamId);
    if (!team) {
      throw new BadRequestException(`Unknown team ${teamId}`);
    }
    if (team.lead_agent_id) {
      const agents = await this.agents.listByProject(projectId);
      const lead = agents.find((entry) => entry.id === team.lead_agent_id);
      if (lead) {
        if ((lead.gateway_policy ?? 'none') === 'none') {
          throw new ForbiddenException(`Team '${teamId}' lead agent is not available via chat`);
        }
        if (lead.gateway_clients !== null && !lead.gateway_clients.includes('app')) {
          throw new ForbiddenException(`Team '${teamId}' is not available via app conversations`);
        }
      }
    }
    return team;
  }

  private async findConversationThread(projectId: string, appKey: string, appId?: string) {
    if (appId) {
      const byKey = await this.threadsService.findByProjectAndKey(
        projectId,
        this.canonicalThreadKey(appId, appKey),
      );
      if (byKey) return byKey;
    }

    const raw = await this.threads.findConversationByAppKey(projectId, appKey);
    return raw ? this.threadsService.findById(raw.id) : null;
  }

  private async toConversationResponse(
    thread: ThreadResponse,
    appKey: string,
    appId?: string,
  ): Promise<ConversationResponse> {
    const metadata = thread.metadata ?? {};
    const messages = await this.threadsService.listMessages(thread.id, { limit: 100 });
    const lastMessage = messages.messages[messages.messages.length - 1] ?? null;
    return {
      thread_id: thread.id,
      key: thread.key,
      app_key: typeof metadata.app_key === 'string' ? metadata.app_key : appKey,
      app_id: typeof metadata.app_id === 'string' ? metadata.app_id : appId ?? 'default',
      metadata,
      current_target: this.currentTarget(metadata),
      last_message: lastMessage,
    };
  }

  private currentTarget(metadata: Record<string, unknown>): ConversationResponse['current_target'] {
    const continuation = metadata.continuation;
    if (!continuation || typeof continuation !== 'object') return null;
    const raw = continuation as Record<string, unknown>;
    const kind = raw.kind;
    const target = raw.target;
    if (
      (kind !== 'route' && kind !== 'agent' && kind !== 'team') ||
      typeof target !== 'string'
    ) {
      return null;
    }
    return {
      kind,
      target,
      route_id: typeof raw.route_id === 'string' ? raw.route_id : null,
      agent_slug: typeof raw.agent_slug === 'string' ? raw.agent_slug : null,
    };
  }

  private buildConversationMetadata(
    appKey: string,
    appId: string,
    productMetadata: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    return {
      provider: 'app',
      account_id: appId,
      channel_id: appKey,
      app_key: appKey,
      app_id: appId,
      product_metadata: productMetadata ?? {},
    };
  }

  private canonicalThreadKey(appId: string, appKey: string): string {
    const digest = createHash('sha256').update(appKey).digest('base64url');
    return `app:${appId}:sha256:${digest}`;
  }
}
