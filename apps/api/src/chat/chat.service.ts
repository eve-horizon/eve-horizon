import { Injectable, Inject, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import type { Db } from '@eve/db';
import {
  agentConfigQueries,
  agentQueries,
  teamQueries,
  teamMemberQueries,
  threadQueries,
  threadMessageQueries,
  threadSubscriptionQueries,
  projectQueries,
  projectManifestQueries,
  eventQueries,
  membershipQueries,
} from '@eve/db';
import {
  generateThreadId,
  generateEventId,
  loadConfig,
  resolveHarnessProfile as sharedResolveHarnessProfile,
  type ChatDispatchRequest,
  type ChatDispatchResponse,
  type ChatHints,
  type ChatListenerScope,
  type ChatRouteRequest,
  type ChatRouteResponse,
  type EnvOverrides,
  type InlineProfileBundle,
  type ThreadChatRequest,
} from '@eve/shared';
import { JobsService } from '../jobs/jobs.service.js';
import { RbacService } from '../auth/rbac.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import type { Permission } from '../auth/permissions.js';
import * as yaml from 'yaml';
import * as crypto from 'crypto';

/**
 * Per-message override bundle resolved from request hints (with legacy
 * metadata.hints alias support). Plan §3.4 / Phase 3.
 */
type ResolvedChatHints = {
  harness_profile_override?: InlineProfileBundle;
  env_overrides?: EnvOverrides;
};

/** Optional caller context for chat-service methods. */
export interface ChatDispatchContext {
  user?: AuthUser;
}

type RouteEntry = {
  id: string;
  match: string;
  target: string;
  providers?: string[];
  account_ids?: string[];
  permissions?: Record<string, unknown>;
};

type RoutePermissions = {
  project_roles?: string[];
  envs?: string[];
};

type ThreadContinuation = {
  kind: 'route' | 'agent' | 'team';
  target: string;
  route_id?: string | null;
  permissions?: RoutePermissions | null;
  agent_slug?: string | null;
};

type ParsedThreadMetadata = {
  raw: Record<string, unknown>;
  provider?: string;
  account_id?: string;
  channel_id?: string;
  user_id?: string;
  thread_id?: string;
  continuation?: ThreadContinuation | null;
};

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private agentConfigs: ReturnType<typeof agentConfigQueries>;
  private agents: ReturnType<typeof agentQueries>;
  private teams: ReturnType<typeof teamQueries>;
  private teamMembers: ReturnType<typeof teamMemberQueries>;
  private threads: ReturnType<typeof threadQueries>;
  private threadMessages: ReturnType<typeof threadMessageQueries>;
  private threadSubscriptions: ReturnType<typeof threadSubscriptionQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private events: ReturnType<typeof eventQueries>;
  private memberships: ReturnType<typeof membershipQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly jobsService: JobsService,
    private readonly rbac: RbacService,
  ) {
    this.agentConfigs = agentConfigQueries(db);
    this.agents = agentQueries(db);
    this.teams = teamQueries(db);
    this.teamMembers = teamMemberQueries(db);
    this.threads = threadQueries(db);
    this.threadMessages = threadMessageQueries(db);
    this.threadSubscriptions = threadSubscriptionQueries(db);
    this.projects = projectQueries(db);
    this.events = eventQueries(db);
    this.memberships = membershipQueries(db);
    this.manifests = projectManifestQueries(db);
  }

  async deliverChatResult(input: {
    projectId: string;
    job_id?: string;
    thread_id: string;
    text: string;
    agent_id?: string;
    progress?: boolean;
  }): Promise<{ delivered: boolean; message_id?: string; error?: string }> {
    const thread = await this.threads.findById(input.thread_id);
    if (!thread) {
      return { delivered: false, error: `Thread ${input.thread_id} not found` };
    }

    const isProgress = input.progress === true;
    let outbound: { id: string } | undefined;

    if (isProgress) {
      // Progress messages bypass the job_id idempotency index — each one is a new message
      outbound = await this.threadMessages.create({
        id: crypto.randomUUID(),
        thread_id: input.thread_id,
        direction: 'outbound',
        kind: 'progress',
        actor_type: 'agent',
        actor_id: input.agent_id ?? null,
        body: input.text,
        job_id: input.job_id ?? null,
      });
    } else {
      // Result delivery: idempotent by job_id
      if (!input.job_id) {
        return { delivered: false, error: 'job_id is required for result delivery' };
      }
      const created = await this.threadMessages.createOutbound({
        id: crypto.randomUUID(),
        thread_id: input.thread_id,
        actor_type: 'agent',
        actor_id: input.agent_id ?? null,
        body: input.text,
        job_id: input.job_id,
      });

      // If createOutbound returned undefined, this is a duplicate (already delivered)
      if (!created) {
        this.logger.log(`Duplicate delivery attempt for job ${input.job_id} — skipping`);
        return { delivered: true };
      }
      outbound = created;
    }

    // Resolve delivery target from thread metadata or key parsing
    const metadata = thread.metadata_json as Record<string, string> | null;
    let provider: string | undefined;
    let accountId: string | undefined;
    let channelId: string | undefined;
    let threadTs: string | undefined;

    if (metadata?.provider) {
      provider = metadata.provider;
      accountId = metadata.account_id;
      channelId = metadata.channel_id;
      threadTs = metadata.thread_id;
    } else {
      // Fallback: parse thread key "provider:account_id:channel_id:thread_ts" or similar
      const parts = thread.key.split(':');
      if (parts.length >= 3) {
        accountId = parts[0];
        channelId = parts[1];
        threadTs = parts[2];
        provider = 'slack'; // Legacy threads are all Slack
      }
    }

    if (!provider || !accountId || !channelId) {
      const error = `Cannot resolve delivery target for thread ${input.thread_id}`;
      this.logger.warn(error);
      if (isProgress) {
        await this.threadMessages.updateDeliveryStatusById(outbound.id, 'failed', error);
      } else {
        await this.threadMessages.updateDeliveryStatus(input.job_id!, 'failed', error);
      }
      return { delivered: false, message_id: outbound.id, error };
    }

    // Forward to gateway
    try {
      const config = loadConfig();
      const gatewayUrl = config.EVE_GATEWAY_URL ?? process.env.EVE_GATEWAY_URL;
      if (!gatewayUrl) {
        throw new Error('EVE_GATEWAY_URL not configured');
      }

      const response = await fetch(`${gatewayUrl}/internal/deliver`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-eve-internal-token': config.EVE_INTERNAL_API_KEY ?? '',
        },
        body: JSON.stringify({
          provider,
          account_id: accountId,
          channel_id: channelId,
          thread_id: threadTs,
          text: input.text,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Gateway returned ${response.status}: ${body}`);
      }

      // Gateway returns 200 for both pushed and no-push (polling) providers.
      // Either way the message is available to the client — mark as delivered.
      if (isProgress) {
        await this.threadMessages.updateDeliveryStatusById(outbound.id, 'delivered');
      } else {
        await this.threadMessages.updateDeliveryStatus(input.job_id!, 'delivered');
      }
      return { delivered: true, message_id: outbound.id };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const label = isProgress ? `progress on thread ${input.thread_id}` : `job ${input.job_id}`;
      this.logger.error(`Failed to deliver to gateway for ${label}: ${error}`);
      if (isProgress) {
        await this.threadMessages.updateDeliveryStatusById(outbound.id, 'failed', error);
      } else {
        await this.threadMessages.updateDeliveryStatus(input.job_id!, 'failed', error);
      }
      return { delivered: false, message_id: outbound.id, error };
    }
  }

  async routeMessage(
    projectId: string,
    data: ChatRouteRequest,
    ctx?: ChatDispatchContext,
  ): Promise<ChatRouteResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const hints = this.resolveChatHints(data);
    await this.enforceHintPermissions(projectId, data, hints, ctx);

    const config = await this.agentConfigs.findLatestByProject(projectId);
    if (!config) {
      throw new BadRequestException('Agents config must be synced before routing chat.');
    }

    const routes = this.normalizeRoutes(config.parsed_routes);
    const parsedChat = this.parseChatYaml(config.chat_yaml);

    const { thread, eventId } = await this.recordThreadAndEvent(projectId, data, hints);

    const route = this.matchRoute(routes, parsedChat.default_route, data);
    if (!route) {
      return {
        thread_id: thread.id,
        thread_key: thread.key,
        route_id: null,
        target: null,
        job_ids: [],
        event_id: eventId,
      };
    }

    await this.setThreadContinuation(thread.id, data, {
      kind: 'route',
      route_id: route.id,
      target: route.target,
      permissions: this.normalizeRoutePermissions(route.permissions),
    });

    // Extract sender identity from gateway metadata
    const eveUserId = data.metadata?.eve_user_id as string | null | undefined;

    // Check route-level permissions before dispatching
    if (route.permissions) {
      const allowed = await this.checkRoutePermissions(
        route.permissions as { project_roles?: string[]; envs?: string[] },
        { eveUserId },
        projectId,
      );
      if (!allowed) {
        const requiredRoles = (route.permissions as { project_roles?: string[] }).project_roles;
        return {
          thread_id: thread.id,
          thread_key: thread.key,
          route_id: route.id,
          target: route.target,
          job_ids: [],
          event_id: eventId,
          denied: true,
          denial_reason: requiredRoles
            ? `Required roles: ${requiredRoles.join(', ')}`
            : 'Insufficient permissions for this route.',
        };
      }
    }
    const jobIds = await this.dispatchRouteTarget(projectId, config, thread.id, data, route, hints);

    return {
      thread_id: thread.id,
      thread_key: thread.key,
      route_id: route.id,
      target: route.target,
      job_ids: jobIds,
      event_id: eventId,
    };
  }

  async routeMessageToRoute(
    projectId: string,
    routeId: string,
    data: ChatRouteRequest,
    ctx?: ChatDispatchContext,
  ): Promise<ChatRouteResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const hints = this.resolveChatHints(data);
    await this.enforceHintPermissions(projectId, data, hints, ctx);

    const config = await this.agentConfigs.findLatestByProject(projectId);
    if (!config) {
      throw new BadRequestException('Agents config must be synced before routing chat.');
    }

    const route = this.normalizeRoutes(config.parsed_routes).find((entry) => entry.id === routeId);
    if (!route) {
      throw new BadRequestException(`Unknown route ${routeId}`);
    }
    if (!this.matchesRouteContext(route, data)) {
      throw new BadRequestException(`Route ${routeId} is not available for ${data.provider}/${data.account_id}`);
    }

    const { thread, eventId } = await this.recordThreadAndEvent(projectId, data, hints);
    await this.setThreadContinuation(thread.id, data, {
      kind: 'route',
      route_id: route.id,
      target: route.target,
      permissions: this.normalizeRoutePermissions(route.permissions),
    });

    const eveUserId = data.metadata?.eve_user_id as string | null | undefined;
    if (route.permissions) {
      const allowed = await this.checkRoutePermissions(
        route.permissions as { project_roles?: string[]; envs?: string[] },
        { eveUserId },
        projectId,
      );
      if (!allowed) {
        const requiredRoles = (route.permissions as { project_roles?: string[] }).project_roles;
        return {
          thread_id: thread.id,
          thread_key: thread.key,
          route_id: route.id,
          target: route.target,
          job_ids: [],
          event_id: eventId,
          denied: true,
          denial_reason: requiredRoles
            ? `Required roles: ${requiredRoles.join(', ')}`
            : 'Insufficient permissions for this route.',
        };
      }
    }

    const jobIds = await this.dispatchRouteTarget(projectId, config, thread.id, data, route, hints);
    return {
      thread_id: thread.id,
      thread_key: thread.key,
      route_id: route.id,
      target: route.target,
      job_ids: jobIds,
      event_id: eventId,
    };
  }

  async continueThread(threadId: string, data: ThreadChatRequest, ctx?: ChatDispatchContext): Promise<ChatRouteResponse> {
    const thread = await this.threads.findById(threadId);
    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    if (thread.scope !== 'project' || !thread.project_id) {
      throw new BadRequestException('Only project-scoped chat threads can be continued');
    }

    const metadata = this.parseThreadMetadata(thread.metadata_json);
    if (!metadata.provider || !metadata.account_id) {
      throw new ConflictException(`Thread ${threadId} is not continuation-capable`);
    }

    const continuation = metadata.continuation;
    if (!continuation) {
      throw new ConflictException(`Thread ${threadId} is not continuation-capable`);
    }

    const request: ChatRouteRequest = {
      provider: metadata.provider,
      account_id: metadata.account_id,
      channel_id: metadata.channel_id,
      user_id: data.actor_id ?? metadata.user_id,
      text: data.text,
      thread_key: thread.key,
      metadata: data.metadata,
      // Plan §3.4 Phase 3: continuation messages can carry per-turn hints.
      hints: (data as ThreadChatRequest & { hints?: ChatHints }).hints,
    };

    if (continuation.kind === 'route') {
      return this.continueStoredRoute(thread.project_id, request, continuation, ctx);
    }

    if (continuation.kind === 'agent') {
      const targetMatch = continuation.target.match(/^agent:(.+)$/);
      if (!targetMatch) {
        throw new ConflictException(`Thread ${threadId} has invalid continuation target`);
      }
      return this.routeMessageToAgent(thread.project_id, targetMatch[1], request, {
        agent_slug: continuation.agent_slug ?? undefined,
      }, ctx);
    }

    if (continuation.kind === 'team') {
      const targetMatch = continuation.target.match(/^team:(.+)$/);
      if (!targetMatch) {
        throw new ConflictException(`Thread ${threadId} has invalid continuation target`);
      }
      return this.routeMessageToTeam(thread.project_id, targetMatch[1], request, ctx);
    }

    throw new ConflictException(`Thread ${threadId} has unsupported continuation type`);
  }

  private async continueStoredRoute(
    projectId: string,
    data: ChatRouteRequest,
    continuation: ThreadContinuation,
    ctx?: ChatDispatchContext,
  ): Promise<ChatRouteResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const config = await this.agentConfigs.findLatestByProject(projectId);
    if (!config) {
      throw new BadRequestException('Agents config must be synced before routing chat.');
    }

    const route: RouteEntry = {
      id: continuation.route_id ?? 'continued_route',
      match: '.*',
      target: continuation.target,
      ...(continuation.permissions ? { permissions: continuation.permissions } : {}),
    };

    const hints = this.resolveChatHints(data);
    await this.enforceHintPermissions(projectId, data, hints, ctx);

    const { thread, eventId } = await this.recordThreadAndEvent(projectId, data, hints);
    await this.setThreadContinuation(thread.id, data, continuation);

    const eveUserId = data.metadata?.eve_user_id as string | null | undefined;
    if (continuation.permissions) {
      const allowed = await this.checkRoutePermissions(continuation.permissions, { eveUserId }, projectId);
      if (!allowed) {
        const requiredRoles = continuation.permissions.project_roles;
        return {
          thread_id: thread.id,
          thread_key: thread.key,
          route_id: route.id,
          target: route.target,
          job_ids: [],
          event_id: eventId,
          denied: true,
          denial_reason: requiredRoles
            ? `Required roles: ${requiredRoles.join(', ')}`
            : 'Insufficient permissions for this route.',
        };
      }
    }

    const jobIds = await this.dispatchRouteTarget(projectId, config, thread.id, data, route, hints);
    return {
      thread_id: thread.id,
      thread_key: thread.key,
      route_id: route.id,
      target: route.target,
      job_ids: jobIds,
      event_id: eventId,
    };
  }

  async routeMessageToAgent(
    projectId: string,
    agentId: string,
    data: ChatRouteRequest,
    options: { agent_slug?: string } = {},
    ctx?: ChatDispatchContext,
  ): Promise<ChatRouteResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const overrideHints = this.resolveChatHints(data);
    await this.enforceHintPermissions(projectId, data, overrideHints, ctx);

    const config = await this.agentConfigs.findLatestByProject(projectId);
    if (!config) {
      throw new BadRequestException('Agents config must be synced before routing chat.');
    }

    const agents = await this.agents.listByProject(projectId);
    const agent = agents.find((entry) => entry.id === agentId);
    if (!agent) {
      throw new BadRequestException(`Unknown agent ${agentId}`);
    }

    const { thread, eventId } = await this.recordThreadAndEvent(projectId, data, overrideHints);
    await this.setThreadContinuation(thread.id, data, {
      kind: 'agent',
      target: `agent:${agent.id}`,
      agent_slug: options.agent_slug ?? null,
    });

    // Load thread history for multi-turn context
    const threadContext = await this.buildThreadContext(thread.id);
    const threadHints = threadContext
      ? { thread_context: threadContext, thread_id: thread.id }
      : { thread_id: thread.id };

    const labels = ['chat', `agent:${agent.id}`];
    if (options.agent_slug) {
      labels.push(`agent_slug:${options.agent_slug}`);
    }

    const resolved = await this.resolveHarnessProfile(projectId, agent.harness_profile, overrideHints);
    const chatFiles = Array.isArray(data.metadata?.files) ? data.metadata.files : undefined;
    const job = await this.jobsService.create(projectId, {
      description: this.buildDirectJobDescription(data, thread.id, agent.id, options.agent_slug),
      assignee: agent.id,
      harness: resolved.harness,
      harness_profile: agent.harness_profile ?? undefined,
      harness_options: resolved.harness_options,
      harness_profile_override: overrideHints.harness_profile_override,
      env_overrides: overrideHints.env_overrides,
      labels,
      hints: { ...threadHints, ...this.getAgentContextHints(config, agent.id, agent.slug ?? null), ...this.getAgentAppApisHint(config, agent.slug ?? null), ...(chatFiles ? { chat_files: chatFiles } : {}) },
    });

    return {
      thread_id: thread.id,
      thread_key: thread.key,
      route_id: null,
      target: `agent:${agent.id}`,
      job_ids: [job.id],
      event_id: eventId,
    };
  }

  /**
   * Route a chat message directly to a team, triggering team dispatch
   * (council/fanout/relay) without going through the route-matching system.
   */
  async routeMessageToTeam(
    projectId: string,
    teamId: string,
    data: ChatRouteRequest,
    ctx?: ChatDispatchContext,
  ): Promise<ChatRouteResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const overrideHints = this.resolveChatHints(data);
    await this.enforceHintPermissions(projectId, data, overrideHints, ctx);

    const config = await this.agentConfigs.findLatestByProject(projectId);
    if (!config) {
      throw new BadRequestException('Agents config must be synced before routing chat.');
    }

    const teams = await this.teams.listByProject(projectId);
    const teamMembers = await this.teamMembers.listByProject(projectId);
    const agents = await this.agents.listByProject(projectId);
    const team = teams.find((entry) => entry.id === teamId);
    if (!team) {
      throw new BadRequestException(`Unknown team ${teamId}`);
    }

    const { thread, eventId } = await this.recordThreadAndEvent(projectId, data, overrideHints);
    await this.setThreadContinuation(thread.id, data, {
      kind: 'team',
      target: `team:${teamId}`,
    });

    const threadContext = await this.buildThreadContext(thread.id);
    const threadHints = threadContext
      ? { thread_context: threadContext, thread_id: thread.id }
      : { thread_id: thread.id };

    const memberIds = teamMembers
      .filter((member) => member.team_id === team.id)
      .map((member) => member.agent_id);

    const leadId = team.lead_agent_id ?? null;

    const parsedTeam = (config as unknown as { parsed_teams?: unknown })?.parsed_teams as
      | { teams?: Record<string, unknown> }
      | undefined;
    const parsedTeamEntry = (parsedTeam?.teams?.[team.id] ?? null) as
      | { dispatch?: Record<string, unknown>; members?: unknown }
      | null;

    const dispatch =
      (parsedTeamEntry?.dispatch as Record<string, unknown> | undefined) ??
      ((team as unknown as { dispatch_json?: Record<string, unknown> | null }).dispatch_json ?? undefined);
    const dispatchMode = (dispatch?.mode as string) ?? 'fanout';
    const isSupervisingLead = dispatchMode === 'council';
    const isStaged = dispatch?.staged === true && dispatchMode === 'council';
    const leadTimeout = dispatch?.lead_timeout as number | undefined;
    const memberTimeout = dispatch?.member_timeout as number | undefined;
    const mergeStrategy = dispatch?.merge_strategy as string | undefined;

    const yamlMembersRaw = parsedTeamEntry?.members;
    const yamlMembers = Array.isArray(yamlMembersRaw)
      ? (yamlMembersRaw.filter((m) => typeof m === 'string') as string[])
      : null;
    const effectiveMemberIds = (yamlMembers ?? memberIds)
      .filter((id) => id !== leadId);

    if (isStaged && effectiveMemberIds.length === 0) {
      this.logger.warn(`Team ${team.id} dispatch is staged but has no members; falling back to normal council flow.`);
    }
    const shouldStageMembers = isStaged && effectiveMemberIds.length > 0;

    const leadAgent = leadId ? agents.find((entry) => entry.id === leadId) : null;
    const leadResolved = await this.resolveHarnessProfile(projectId, leadAgent?.harness_profile, overrideHints);
    const chatFiles = Array.isArray(data.metadata?.files) ? data.metadata.files : undefined;

    const jobIds: string[] = [];

    const leadAppApis = leadId ? this.getAgentAppApisHint(config, leadAgent?.slug ?? null) : {};
    const parent = await this.jobsService.create(projectId, {
      description: this.buildTeamJobDescription(data, thread.id, teamId, dispatchMode),
      assignee: leadId,
      harness: leadResolved.harness,
      harness_profile: leadAgent?.harness_profile ?? undefined,
      harness_options: leadResolved.harness_options,
      harness_profile_override: overrideHints.harness_profile_override,
      env_overrides: overrideHints.env_overrides,
      labels: ['chat', `team:${team.id}`, `dispatch:${dispatchMode}`],
      hints: {
        ...threadHints,
        ...(isSupervisingLead ? { supervising: true } : {}),
        ...(isStaged ? { staged: true } : {}),
        ...(leadTimeout ? { timeout_seconds: leadTimeout } : {}),
        ...leadAppApis,
        ...(chatFiles ? { chat_files: chatFiles } : {}),
      },
    });
    jobIds.push(parent.id);

    const coordThreadKey = `coord:job:${parent.id}`;
    const coordThread = await this.ensureThread(projectId, coordThreadKey, null, overrideHints);

    await this.jobsService.updateHints(parent.id, {
      coordination: {
        thread_id: coordThread.id,
        dispatch_mode: dispatchMode,
      },
      ...(mergeStrategy ? { merge_strategy: mergeStrategy } : {}),
    });

    if (dispatchMode === 'relay') {
      let previousChildId: string | null = parent.id;
      for (const memberId of effectiveMemberIds) {
        const agent = agents.find((entry) => entry.id === memberId);
        const childDescription = previousChildId
          ? `Continue from previous job ${previousChildId}.\n\n${this.buildTeamJobDescription(data, thread.id, teamId, dispatchMode)}`
          : this.buildTeamJobDescription(data, thread.id, teamId, dispatchMode);
        const memberResolved = await this.resolveHarnessProfile(projectId, agent?.harness_profile, overrideHints);

        const child = await this.jobsService.create(projectId, {
          parent_id: parent.id,
          description: childDescription,
          assignee: memberId,
          harness: memberResolved.harness,
          harness_profile: agent?.harness_profile ?? undefined,
          harness_options: memberResolved.harness_options,
          harness_profile_override: overrideHints.harness_profile_override,
          env_overrides: overrideHints.env_overrides,
          labels: ['chat', `team:${team.id}`, `agent:${memberId}`],
          hints: {
            ...threadHints,
            ...this.getAgentContextHints(config, memberId, agent?.slug ?? null),
            ...this.getAgentAppApisHint(config, agent?.slug ?? null),
            ...(memberTimeout ? { timeout_seconds: memberTimeout } : {}),
          },
        });

        if (previousChildId) {
          await this.jobsService.addDependency(child.id, {
            related_job_id: previousChildId,
          });
        }

        jobIds.push(child.id);
        previousChildId = child.id;
      }
    } else {
      for (const memberId of effectiveMemberIds) {
        const agent = agents.find((entry) => entry.id === memberId);
        const memberResolved = await this.resolveHarnessProfile(projectId, agent?.harness_profile, overrideHints);
        const child = await this.jobsService.create(projectId, {
          parent_id: parent.id,
          description: this.buildTeamJobDescription(data, thread.id, teamId, dispatchMode),
          assignee: memberId,
          harness: memberResolved.harness,
          harness_profile: agent?.harness_profile ?? undefined,
          harness_options: memberResolved.harness_options,
          harness_profile_override: overrideHints.harness_profile_override,
          env_overrides: overrideHints.env_overrides,
          labels: ['chat', `team:${team.id}`, `agent:${memberId}`],
          phase: shouldStageMembers ? 'backlog' : undefined,
          hints: {
            ...threadHints,
            ...this.getAgentContextHints(config, memberId, agent?.slug ?? null),
            ...this.getAgentAppApisHint(config, agent?.slug ?? null),
            ...(memberTimeout ? { timeout_seconds: memberTimeout } : {}),
          },
        });
        jobIds.push(child.id);
      }
    }

    return {
      thread_id: thread.id,
      thread_key: thread.key,
      route_id: null,
      target: `team:${teamId}`,
      job_ids: jobIds,
      event_id: eventId,
    };
  }

  async subscribeAgentToThread(
    orgId: string,
    agentSlug: string,
    threadKey: string,
    scope: ChatListenerScope,
    options: { channel_id?: string | null } = {},
  ) {
    let agent = await this.agents.findByOrgAndSlug(orgId, agentSlug);
    if (!agent) {
      agent = await this.agents.findByOrgAndAlias(orgId, agentSlug);
    }
    if (!agent || !agent.slug) {
      throw new NotFoundException(`Agent slug ${agentSlug} not found`);
    }

    const project = await this.projects.findById(agent.project_id);
    if (!project) {
      throw new NotFoundException(`Project ${agent.project_id} not found`);
    }

    const thread = await this.ensureThread(agent.project_id, threadKey, options.channel_id ?? null);
    await this.threadSubscriptions.insert({
      thread_id: thread.id,
      subscriber_type: 'agent',
      subscriber_id: agent.id,
    });

    return {
      thread_id: thread.id,
      thread_key: thread.key,
      scope,
      agent_id: agent.id,
      agent_slug: agent.slug,
      project_id: project.id,
      project_slug: project.slug,
    };
  }

  async unsubscribeAgentFromThread(
    orgId: string,
    agentSlug: string,
    threadKey: string,
    scope: ChatListenerScope,
  ) {
    let agent = await this.agents.findByOrgAndSlug(orgId, agentSlug);
    if (!agent) {
      agent = await this.agents.findByOrgAndAlias(orgId, agentSlug);
    }
    if (!agent || !agent.slug) {
      throw new NotFoundException(`Agent slug ${agentSlug} not found`);
    }

    const project = await this.projects.findById(agent.project_id);
    if (!project) {
      throw new NotFoundException(`Project ${agent.project_id} not found`);
    }

    const thread = await this.threads.findByProjectAndKey(agent.project_id, threadKey);
    if (!thread) {
      return {
        removed: false,
        scope,
        agent_slug: agent.slug,
        project_slug: project.slug,
      };
    }

    const removed = await this.threadSubscriptions.deleteByThread(thread.id, 'agent', agent.id);
    return {
      removed: removed > 0,
      scope,
      agent_slug: agent.slug,
      project_slug: project.slug,
    };
  }

  async listListeners(
    orgId: string,
    channelKey: string | null,
    threadKey: string | null,
  ) {
    const keys = [channelKey, threadKey].filter((key): key is string => Boolean(key));
    const listeners = await this.threadSubscriptions.listAgentSubscriptionsByOrgAndThreadKeys(orgId, keys);
    const channelListeners = channelKey
      ? listeners.filter((listener) => listener.thread_key === channelKey)
      : [];
    const threadListeners = threadKey
      ? listeners.filter((listener) => listener.thread_key === threadKey)
      : [];

    return {
      channel_key: channelKey,
      thread_key: threadKey,
      channel_listeners: channelListeners.map((listener) => ({
        project_id: listener.project_id,
        project_slug: listener.project_slug,
        project_name: listener.project_name,
        agent_id: listener.agent_id,
        agent_slug: listener.agent_slug,
        agent_name: listener.agent_name,
        agent_description: listener.agent_description,
      })),
      thread_listeners: threadListeners.map((listener) => ({
        project_id: listener.project_id,
        project_slug: listener.project_slug,
        project_name: listener.project_name,
        agent_id: listener.agent_id,
        agent_slug: listener.agent_slug,
        agent_name: listener.agent_name,
        agent_description: listener.agent_description,
      })),
    };
  }

  async dispatchToListeners(orgId: string, data: ChatDispatchRequest): Promise<ChatDispatchResponse> {
    const overrideHints = this.resolveChatHints(data);
    // Internal dispatch: resolve principal via metadata.eve_user_id when hints present.
    if (overrideHints.harness_profile_override || overrideHints.env_overrides) {
      const user = this.resolveMetadataPrincipal(data);
      if (!user) {
        throw new BadRequestException(
          'harness_profile_override / env_overrides require an authenticated principal (metadata.eve_user_id)',
        );
      }
      // No single project_id on an org-wide dispatch — enforcement happens per listener below.
    }

    const channelKey = data.channel_key ?? (data.channel_id
      ? `${data.account_id}:${data.channel_id}`
      : null);
    const threadKey = data.thread_key;
    const keys = [threadKey, channelKey].filter((key): key is string => Boolean(key));
    const subscriptions = await this.threadSubscriptions.listAgentSubscriptionsByOrgAndThreadKeys(orgId, keys);
    if (subscriptions.length === 0) {
      return { job_ids: [] };
    }

    const agentMap = new Map<string, {
      project_id: string;
      agent_id: string;
      agent_slug: string | null;
      agent_name: string | null;
      harness_profile: string | null;
      scopes: Set<ChatListenerScope>;
    }>();

    for (const subscription of subscriptions) {
      const scope: ChatListenerScope = subscription.thread_key === threadKey ? 'thread' : 'channel';
      const key = `${subscription.project_id}:${subscription.agent_id}`;
      const existing = agentMap.get(key);
      if (existing) {
        existing.scopes.add(scope);
        continue;
      }
      agentMap.set(key, {
        project_id: subscription.project_id,
        agent_id: subscription.agent_id,
        agent_slug: subscription.agent_slug,
        agent_name: subscription.agent_name,
        harness_profile: subscription.harness_profile,
        scopes: new Set([scope]),
      });
    }

    const byProject = new Map<string, Array<{
      project_id: string;
      agent_id: string;
      agent_slug: string | null;
      agent_name: string | null;
      harness_profile: string | null;
      scopes: Set<ChatListenerScope>;
    }>>();

    for (const entry of agentMap.values()) {
      const list = byProject.get(entry.project_id);
      if (list) {
        list.push(entry);
      } else {
        byProject.set(entry.project_id, [entry]);
      }
    }

    const jobIds: string[] = [];

    for (const [projectId, entries] of byProject.entries()) {
      const config = await this.agentConfigs.findLatestByProject(projectId);
      if (!config) {
        this.logger.warn(`Agents config missing for project ${projectId}; skipping listener dispatch.`);
        continue;
      }

      const listenerMeta = {
        ...(data.metadata ?? {}),
        listener_scopes: Array.from(new Set(entries.flatMap((entry) => Array.from(entry.scopes)))),
        listener_agents: entries
          .map((entry) => entry.agent_slug ?? entry.agent_id)
          .filter(Boolean),
      };

      // Enforce permissions at project scope when hints are present.
      if (overrideHints.harness_profile_override || overrideHints.env_overrides) {
        const user = this.resolveMetadataPrincipal(data);
        if (user) {
          const needs: Permission[] = ['jobs:harness_override'];
          if (overrideHints.env_overrides) {
            const refsAnySecret = Object.values(overrideHints.env_overrides).some((v) =>
              /\$\{secret\.[A-Z_][A-Z0-9_]*\}/.test(v),
            );
            if (refsAnySecret) needs.push('secrets:read');
          }
          await this.rbac.requirePermissions(user, projectId, needs);
        }
      }

      const { thread } = await this.recordThreadAndEvent(projectId, {
        ...data,
        metadata: listenerMeta,
      }, overrideHints);

      // Load thread history for multi-turn context
      const threadContext = await this.buildThreadContext(thread.id);
      const threadHints = threadContext
        ? { thread_context: threadContext, thread_id: thread.id }
        : { thread_id: thread.id };

      for (const entry of entries) {
        const scopeLabels = Array.from(entry.scopes).map((scope) => `listener:${scope}`);
        const labels = [
          'chat',
          'listener',
          `agent:${entry.agent_id}`,
          ...scopeLabels,
        ];

        if (entry.agent_slug) {
          labels.push(`agent_slug:${entry.agent_slug}`);
        }

        const chatFiles = Array.isArray(data.metadata?.files) ? data.metadata.files : undefined;
        const listenerResolved = await this.resolveHarnessProfile(
          projectId,
          entry.harness_profile,
          overrideHints,
        );
        const job = await this.jobsService.create(projectId, {
          description: this.buildListenerJobDescription(
            data,
            thread.id,
            entry.agent_id,
            entry.agent_slug,
            Array.from(entry.scopes),
          ),
          assignee: entry.agent_id,
          harness: listenerResolved.harness,
          harness_profile: entry.harness_profile ?? undefined,
          harness_options: listenerResolved.harness_options,
          harness_profile_override: overrideHints.harness_profile_override,
          env_overrides: overrideHints.env_overrides,
          labels,
          hints: {
            ...threadHints,
            ...this.getAgentContextHints(config, entry.agent_id, entry.agent_slug ?? null),
            ...this.getAgentAppApisHint(config, entry.agent_slug ?? null),
            ...(chatFiles ? { chat_files: chatFiles } : {}),
          },
        });
        jobIds.push(job.id);
      }

    }

    return { job_ids: jobIds };
  }

  private async dispatchRouteTarget(
    projectId: string,
    config: NonNullable<Awaited<ReturnType<typeof this.agentConfigs.findLatestByProject>>>,
    threadId: string,
    data: ChatRouteRequest,
    route: RouteEntry,
    overrideHints: ResolvedChatHints,
  ): Promise<string[]> {
    const threadContext = await this.buildThreadContext(threadId);
    const threadHints = threadContext
      ? { thread_context: threadContext, thread_id: threadId }
      : { thread_id: threadId };

    const jobIds: string[] = [];
    const targetMatch = route.target.match(/^(agent|team|workflow|pipeline):(.+)$/);
    if (!targetMatch) {
      throw new BadRequestException(`Invalid route target: ${route.target}`);
    }

    const targetType = targetMatch[1];
    const targetId = targetMatch[2];

    if (targetType === 'agent') {
      const agents = await this.agents.listByProject(projectId);
      const agent = agents.find((entry) => entry.id === targetId);
      if (!agent) {
        throw new BadRequestException(`Unknown agent ${targetId} for route ${route.id}`);
      }
      const agentContextHints = this.getAgentContextHints(config, agent.id, agent.slug ?? null);
      const agentAppApis = this.getAgentAppApisHint(config, agent.slug ?? null);
      const resolved = await this.resolveHarnessProfile(projectId, agent.harness_profile, overrideHints);

      const chatFiles = Array.isArray(data.metadata?.files) ? data.metadata.files : undefined;
      const job = await this.jobsService.create(projectId, {
        description: this.buildJobDescription(data, route, threadId),
        assignee: agent.id,
        harness: resolved.harness,
        harness_profile: agent.harness_profile ?? undefined,
        harness_options: resolved.harness_options,
        harness_profile_override: overrideHints.harness_profile_override,
        env_overrides: overrideHints.env_overrides,
        labels: ['chat', `route:${route.id}`, `agent:${agent.id}`],
        hints: { ...threadHints, ...agentContextHints, ...agentAppApis, ...(chatFiles ? { chat_files: chatFiles } : {}) },
      });
      jobIds.push(job.id);
      return jobIds;
    }

    if (targetType === 'team') {
      const teams = await this.teams.listByProject(projectId);
      const teamMembers = await this.teamMembers.listByProject(projectId);
      const agents = await this.agents.listByProject(projectId);
      const team = teams.find((entry) => entry.id === targetId);
      if (!team) {
        throw new BadRequestException(`Unknown team ${targetId} for route ${route.id}`);
      }

      const memberIds = teamMembers
        .filter((member) => member.team_id === team.id)
        .map((member) => member.agent_id);

      const leadId = team.lead_agent_id ?? null;

      const parsedTeam = (config as unknown as { parsed_teams?: unknown })?.parsed_teams as
        | { teams?: Record<string, unknown> }
        | undefined;
      const parsedTeamEntry = (parsedTeam?.teams?.[team.id] ?? null) as
        | { dispatch?: Record<string, unknown>; members?: unknown }
        | null;

      const dispatch =
        (parsedTeamEntry?.dispatch as Record<string, unknown> | undefined) ??
        ((team as unknown as { dispatch_json?: Record<string, unknown> | null }).dispatch_json ?? undefined);
      const dispatchMode = (dispatch?.mode as string) ?? 'fanout';
      const isSupervisingLead = dispatchMode === 'council';
      const isStaged = dispatch?.staged === true && dispatchMode === 'council';
      const leadTimeout = dispatch?.lead_timeout as number | undefined;
      const memberTimeout = dispatch?.member_timeout as number | undefined;
      const mergeStrategy = dispatch?.merge_strategy as string | undefined;

      const yamlMembersRaw = parsedTeamEntry?.members;
      const yamlMembers = Array.isArray(yamlMembersRaw)
        ? (yamlMembersRaw.filter((m) => typeof m === 'string') as string[])
        : null;
      const effectiveMemberIds = (yamlMembers ?? memberIds).filter((id) => id !== leadId);

      if (isStaged && effectiveMemberIds.length === 0) {
        this.logger.warn(`Team ${team.id} dispatch is staged but has no members; falling back to normal council flow.`);
      }
      const shouldStageMembers = isStaged && effectiveMemberIds.length > 0;

      const leadAgent = leadId ? agents.find((entry) => entry.id === leadId) : null;
      const leadResolved = await this.resolveHarnessProfile(projectId, leadAgent?.harness_profile, overrideHints);
      const chatFiles = Array.isArray(data.metadata?.files) ? data.metadata.files : undefined;
      const leadAppApis = leadId ? this.getAgentAppApisHint(config, leadAgent?.slug ?? null) : {};

      const parent = await this.jobsService.create(projectId, {
        description: this.buildJobDescription(data, route, threadId),
        assignee: leadId,
        harness: leadResolved.harness,
        harness_profile: leadAgent?.harness_profile ?? undefined,
        harness_options: leadResolved.harness_options,
        harness_profile_override: overrideHints.harness_profile_override,
        env_overrides: overrideHints.env_overrides,
        labels: ['chat', `route:${route.id}`, `team:${team.id}`, `dispatch:${dispatchMode}`],
        hints: {
          ...threadHints,
          ...(isSupervisingLead ? { supervising: true } : {}),
          ...(isStaged ? { staged: true } : {}),
          ...(leadTimeout ? { timeout_seconds: leadTimeout } : {}),
          ...leadAppApis,
          ...(chatFiles ? { chat_files: chatFiles } : {}),
        },
      });
      jobIds.push(parent.id);

      const coordThreadKey = `coord:job:${parent.id}`;
      const coordThread = await this.ensureThread(projectId, coordThreadKey, null, overrideHints);

      await this.jobsService.updateHints(parent.id, {
        coordination: {
          thread_id: coordThread.id,
          dispatch_mode: dispatchMode,
        },
        ...(mergeStrategy ? { merge_strategy: mergeStrategy } : {}),
      });

      if (dispatchMode === 'relay') {
        let previousChildId: string | null = parent.id;
        for (const memberId of effectiveMemberIds) {
          const agent = agents.find((entry) => entry.id === memberId);
          const childDescription = previousChildId
            ? `Continue from previous job ${previousChildId}.\n\n${this.buildJobDescription(data, route, threadId)}`
            : this.buildJobDescription(data, route, threadId);
          const memberResolved = await this.resolveHarnessProfile(projectId, agent?.harness_profile, overrideHints);

          const child = await this.jobsService.create(projectId, {
            parent_id: parent.id,
            description: childDescription,
            assignee: memberId,
            harness: memberResolved.harness,
            harness_profile: agent?.harness_profile ?? undefined,
            harness_options: memberResolved.harness_options,
            harness_profile_override: overrideHints.harness_profile_override,
            env_overrides: overrideHints.env_overrides,
            labels: ['chat', `route:${route.id}`, `team:${team.id}`, `agent:${memberId}`],
            hints: {
              ...threadHints,
              ...this.getAgentContextHints(config, memberId, agent?.slug ?? null),
              ...this.getAgentAppApisHint(config, agent?.slug ?? null),
              ...(memberTimeout ? { timeout_seconds: memberTimeout } : {}),
            },
          });

          if (previousChildId) {
            await this.jobsService.addDependency(child.id, {
              related_job_id: previousChildId,
            });
          }

          jobIds.push(child.id);
          previousChildId = child.id;
        }
      } else {
        for (const memberId of effectiveMemberIds) {
          const agent = agents.find((entry) => entry.id === memberId);
          const memberResolved = await this.resolveHarnessProfile(projectId, agent?.harness_profile, overrideHints);
          const child = await this.jobsService.create(projectId, {
            parent_id: parent.id,
            description: this.buildJobDescription(data, route, threadId),
            assignee: memberId,
            harness: memberResolved.harness,
            harness_profile: agent?.harness_profile ?? undefined,
            harness_options: memberResolved.harness_options,
            harness_profile_override: overrideHints.harness_profile_override,
            env_overrides: overrideHints.env_overrides,
            labels: ['chat', `route:${route.id}`, `team:${team.id}`, `agent:${memberId}`],
            phase: shouldStageMembers ? 'backlog' : undefined,
            hints: {
              ...threadHints,
              ...this.getAgentContextHints(config, memberId, agent?.slug ?? null),
              ...this.getAgentAppApisHint(config, agent?.slug ?? null),
              ...(memberTimeout ? { timeout_seconds: memberTimeout } : {}),
            },
          });
          jobIds.push(child.id);
        }
      }

      return jobIds;
    }

    if (targetType === 'workflow' || targetType === 'pipeline') {
      const job = await this.jobsService.create(projectId, {
        description: this.buildJobDescription(data, route, threadId),
        labels: ['chat', `route:${route.id}`, `target:${route.target}`],
        hints: { ...threadHints },
      });
      jobIds.push(job.id);
      return jobIds;
    }

    return jobIds;
  }

  private normalizeRoutes(routes: unknown[] | null): RouteEntry[] {
    if (!Array.isArray(routes)) return [];
    return routes
      .map((route) => (typeof route === 'object' && route ? route as Record<string, unknown> : {}))
      .filter((route) => typeof route.id === 'string' && typeof route.match === 'string' && typeof route.target === 'string')
      .map((route) => ({
        id: String(route.id),
        match: String(route.match),
        target: String(route.target),
        providers: Array.isArray(route.providers)
          ? route.providers.filter((value): value is string => typeof value === 'string')
          : undefined,
        account_ids: Array.isArray(route.account_ids)
          ? route.account_ids.filter((value): value is string => typeof value === 'string')
          : undefined,
        permissions: (route.permissions && typeof route.permissions === 'object')
          ? route.permissions as Record<string, unknown>
          : undefined,
      }));
  }

  private parseChatYaml(yamlContent: string): { default_route?: string } {
    try {
      const parsed = yaml.parse(yamlContent) as { default_route?: string } | null;
      if (!parsed || typeof parsed !== 'object') {
        return {};
      }
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to parse chat YAML: ${message}`);
      return {};
    }
  }

  /**
   * Find an agent entry in parsed_agents by slug.
   * parsed_agents.agents is keyed by YAML key name (e.g. "pm-coordinator"),
   * not by DB row ID — so we iterate and match on the slug field.
   */
  private findAgentEntry(
    config: { parsed_agents?: Record<string, unknown> | null },
    agentSlug: string | null,
  ): Record<string, unknown> | null {
    if (!agentSlug) return null;
    const parsed = config.parsed_agents;
    if (!parsed || typeof parsed !== 'object') return null;
    const agents = (parsed as { agents?: Record<string, unknown> }).agents;
    if (!agents || typeof agents !== 'object') return null;

    for (const entry of Object.values(agents)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (e.slug === agentSlug) return e;
    }
    return null;
  }

  private getAgentContextHints(
    config: { parsed_agents?: Record<string, unknown> | null },
    agentId: string,
    agentSlug: string | null,
  ): Record<string, unknown> {
    const entry = this.findAgentEntry(config, agentSlug);
    if (!entry) return {};
    const context = entry.context as Record<string, unknown> | undefined;
    if (!context || typeof context !== 'object') return {};

    return {
      agent_context: {
        ...context,
        ...(agentSlug ? { agent_slug: agentSlug } : {}),
      },
    };
  }

  /**
   * Extract with_apis from an agent's config and return as app_apis hint.
   * This allows chat-triggered jobs to receive EVE_APP_API_URL_* env vars
   * just like workflow-triggered jobs do.
   */
  private getAgentAppApisHint(
    config: { parsed_agents?: Record<string, unknown> | null },
    agentSlug: string | null,
  ): Record<string, unknown> {
    const entry = this.findAgentEntry(config, agentSlug);
    if (!entry) return {};
    const withApis = entry.with_apis as Array<{ service: string }> | undefined;
    if (!Array.isArray(withApis) || withApis.length === 0) return {};

    return {
      app_apis: withApis.map(api => api.service),
    };
  }

  /**
   * Resolve a harness_profile name to a concrete harness + harness_options,
   * honoring per-message inline overrides and env_overrides from chat hints
   * (plan §3.4 Phase 3). The shared resolver is the single source of truth.
   */
  private async resolveHarnessProfile(
    projectId: string,
    profileName: string | null | undefined,
    hints?: ResolvedChatHints,
  ): Promise<{ harness?: string; harness_options?: Record<string, unknown> }> {
    if (!profileName && !hints?.harness_profile_override) return {};
    const resolved = await sharedResolveHarnessProfile(
      { agentConfigs: this.agentConfigs, manifests: this.manifests, logger: this.logger },
      {
        projectId,
        stringRef: profileName ?? null,
        inlineOverride: hints?.harness_profile_override ?? null,
        envOverrides: hints?.env_overrides ?? null,
      },
    );
    return {
      harness: resolved.harness,
      harness_options: resolved.harness_options as Record<string, unknown> | undefined,
    };
  }

  /**
   * Normalise a chat request's override hints. Prefers the typed `hints` field
   * but falls back to legacy `metadata.hints` (accepted in Phase 3 for gateway
   * clients that have not rolled forward yet). Returns `{}` when nothing set.
   */
  private resolveChatHints(data: ChatRouteRequest): ResolvedChatHints {
    if (data.hints) {
      return {
        harness_profile_override: data.hints.harness_profile_override,
        env_overrides: data.hints.env_overrides,
      };
    }
    const metadataHints = data.metadata?.hints as Partial<ChatHints> | undefined;
    if (!metadataHints || typeof metadataHints !== 'object') return {};
    return {
      harness_profile_override: metadataHints.harness_profile_override as InlineProfileBundle | undefined,
      env_overrides: metadataHints.env_overrides as EnvOverrides | undefined,
    };
  }

  /**
   * When chat hints carry harness_profile_override or env_overrides the
   * caller must hold the same permissions as direct POST /projects/:id/jobs
   * (plan §3.7). If no Eve principal can be resolved (internal dispatch with
   * no `metadata.eve_user_id`) we reject rather than silently drop the hints.
   */
  private async enforceHintPermissions(
    projectId: string,
    data: ChatRouteRequest,
    hints: ResolvedChatHints,
    ctx: ChatDispatchContext | undefined,
  ): Promise<void> {
    if (!hints.harness_profile_override && !hints.env_overrides) return;

    const user = ctx?.user ?? this.resolveMetadataPrincipal(data);
    if (!user) {
      throw new BadRequestException(
        'harness_profile_override / env_overrides require an authenticated principal',
      );
    }

    const needs: Permission[] = ['jobs:harness_override'];
    if (hints.env_overrides) {
      const refsAnySecret = Object.values(hints.env_overrides).some((v) =>
        /\$\{secret\.[A-Z_][A-Z0-9_]*\}/.test(v),
      );
      if (refsAnySecret) needs.push('secrets:read');
    }
    await this.rbac.requirePermissions(user, projectId, needs);
  }

  private resolveMetadataPrincipal(data: ChatRouteRequest): AuthUser | undefined {
    const eveUserId = typeof data.metadata?.eve_user_id === 'string' ? data.metadata.eve_user_id : null;
    if (!eveUserId) return undefined;
    // Minimal principal stand-in — RbacService only needs user_id for permission resolution.
    return { user_id: eveUserId } as AuthUser;
  }

  /**
   * Persist override hints into a thread's metadata so `eve thread messages`
   * can surface what brain ran for a given turn. Placeholders stay intact —
   * we never resolve secret values here (plan §3.6 / Phase 3 R2.2).
   */
  private buildHarnessOverridesSnapshot(
    hints: ResolvedChatHints,
  ): Record<string, unknown> | null {
    if (!hints.harness_profile_override && !hints.env_overrides) return null;
    const snapshot: Record<string, unknown> = {};
    if (hints.harness_profile_override) snapshot.profile_override = hints.harness_profile_override;
    if (hints.env_overrides) snapshot.env_overrides = hints.env_overrides;
    return snapshot;
  }

  private matchRoute(routes: RouteEntry[], defaultRoute: string | undefined, data: ChatRouteRequest): RouteEntry | null {
    // IMPORTANT: `default_route` is a fallback, not a first-match rule.
    // Many projects define `route_default.match: ".*"`. If we test routes in order,
    // that catch-all would shadow every more-specific route.
    for (const route of routes) {
      if (defaultRoute && route.id === defaultRoute) continue;
      if (!this.matchesRouteContext(route, data)) continue;
      try {
        const regex = new RegExp(route.match, 'i');
        if (regex.test(data.text)) {
          return route;
        }
      } catch (error) {
        this.logger.warn(`Invalid chat route regex for ${route.id}: ${route.match}`);
        continue;
      }
    }

    if (defaultRoute) {
      const fallback = routes.find((route) => route.id === defaultRoute);
      if (fallback && this.matchesRouteContext(fallback, data)) {
        return fallback;
      }
    }

    return null;
  }

  private matchesRouteContext(route: RouteEntry, data: ChatRouteRequest): boolean {
    if (route.providers?.length && !route.providers.includes(data.provider)) {
      return false;
    }
    if (route.account_ids?.length && !route.account_ids.includes(data.account_id)) {
      return false;
    }
    return true;
  }

  private normalizeRoutePermissions(raw: unknown): RoutePermissions | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const permissions = raw as Record<string, unknown>;
    const normalized: RoutePermissions = {};

    if (Array.isArray(permissions.project_roles)) {
      normalized.project_roles = permissions.project_roles.filter(
        (value): value is string => typeof value === 'string',
      );
    }
    if (Array.isArray(permissions.envs)) {
      normalized.envs = permissions.envs.filter(
        (value): value is string => typeof value === 'string',
      );
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private parseThreadContinuation(raw: unknown): ThreadContinuation | null {
    if (!raw || typeof raw !== 'object') return null;
    const continuation = raw as Record<string, unknown>;
    const kind = continuation.kind;
    const target = continuation.target;

    if (
      (kind !== 'route' && kind !== 'agent' && kind !== 'team')
      || typeof target !== 'string'
      || target.length === 0
    ) {
      return null;
    }

    return {
      kind,
      target,
      route_id: typeof continuation.route_id === 'string' ? continuation.route_id : null,
      permissions: this.normalizeRoutePermissions(continuation.permissions) ?? null,
      agent_slug: typeof continuation.agent_slug === 'string' ? continuation.agent_slug : null,
    };
  }

  private parseThreadMetadata(metadata: Record<string, unknown> | null): ParsedThreadMetadata {
    const raw = metadata && typeof metadata === 'object' ? metadata : {};
    return {
      raw,
      provider: typeof raw.provider === 'string' ? raw.provider : undefined,
      account_id: typeof raw.account_id === 'string' ? raw.account_id : undefined,
      channel_id: typeof raw.channel_id === 'string' ? raw.channel_id : undefined,
      user_id: typeof raw.user_id === 'string' ? raw.user_id : undefined,
      thread_id: typeof raw.thread_id === 'string' ? raw.thread_id : undefined,
      continuation: this.parseThreadContinuation(raw.continuation),
    };
  }

  private buildThreadMetadata(
    data: ChatRouteRequest,
    existingMetadata: Record<string, unknown> | null,
    continuation?: ThreadContinuation,
    hints?: ResolvedChatHints,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      ...(existingMetadata ?? {}),
      provider: data.provider,
      account_id: data.account_id,
    };

    if (data.channel_id) metadata.channel_id = data.channel_id;
    if (data.user_id) metadata.user_id = data.user_id;

    const threadKey = data.thread_key
      ?? `${data.provider}:${data.account_id}:${data.channel_id ?? data.user_id ?? 'unknown'}`;
    const threadKeyParts = threadKey.split(':');
    if (threadKeyParts.length >= 3) {
      metadata.thread_id = threadKeyParts[threadKeyParts.length - 1];
    }

    if (continuation !== undefined) {
      metadata.continuation = continuation;
    }

    // Phase 3 R2.2: persist the per-turn override bundle so `eve thread
    // messages` (and future audit tooling) can show which brain ran. We
    // intentionally overwrite any prior snapshot — the field reflects the
    // most recent turn, not full history.
    if (hints) {
      const snapshot = this.buildHarnessOverridesSnapshot(hints);
      if (snapshot) {
        metadata.harness_overrides = snapshot;
      } else {
        delete metadata.harness_overrides;
      }
    }

    return metadata;
  }

  private async setThreadContinuation(
    threadId: string,
    data: ChatRouteRequest,
    continuation: ThreadContinuation,
  ): Promise<void> {
    const thread = await this.threads.findById(threadId);
    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }

    const metadata = this.buildThreadMetadata(
      data,
      thread.metadata_json as Record<string, unknown> | null,
      continuation,
    );
    await this.threads.updateMetadata(threadId, metadata);
  }

  /**
   * Load recent thread messages and format as context for agent continuity.
   * Returns undefined if the thread has fewer than 2 messages (no prior context).
   */
  private async buildThreadContext(
    threadId: string,
  ): Promise<Array<{ direction: string; actor: string; text: string; timestamp: string }> | undefined> {
    const messages = await this.threadMessages.listRecent(threadId, { limit: 20 });
    // Need at least 2 messages for context (current + at least one prior)
    if (messages.length < 2) return undefined;

    return messages.map((m) => ({
      direction: m.direction,
      actor: m.actor_type === 'agent' ? (m.actor_id ?? 'agent') : 'user',
      text: m.body,
      timestamp: m.created_at.toISOString(),
    }));
  }

  private async checkRoutePermissions(
    permissions: { project_roles?: string[]; envs?: string[] },
    sender: { eveUserId?: string | null },
    projectId: string,
  ): Promise<boolean> {
    if (permissions.project_roles) {
      if (!sender.eveUserId) return false;
      const membership = await this.memberships.findProjectMembership(sender.eveUserId, projectId);
      if (!membership || !permissions.project_roles.includes(membership.role)) return false;
    }
    return true;
  }

  private buildJobDescription(data: ChatRouteRequest, route: RouteEntry, threadId: string): string {
    const lines = [
      `Chat message from ${data.provider} (${data.account_id})`,
      `Thread: ${threadId}`,
      `Route: ${route.id} -> ${route.target}`,
      '',
      data.text,
    ];
    return lines.join('\n');
  }

  private buildDirectJobDescription(
    data: ChatRouteRequest,
    threadId: string,
    agentId: string,
    agentSlug?: string,
  ): string {
    const slugLabel = agentSlug ? ` (slug: ${agentSlug})` : '';
    const lines = [
      `Chat message from ${data.provider} (${data.account_id})`,
      `Thread: ${threadId}`,
      `Target agent: ${agentId}${slugLabel}`,
      '',
      data.text,
    ];
    return lines.join('\n');
  }

  private buildTeamJobDescription(
    data: ChatRouteRequest,
    threadId: string,
    teamId: string,
    dispatchMode: string,
  ): string {
    const lines = [
      `Chat message from ${data.provider} (${data.account_id})`,
      `Thread: ${threadId}`,
      `Target team: ${teamId} (dispatch: ${dispatchMode})`,
      '',
      data.text,
    ];
    return lines.join('\n');
  }

  private buildListenerJobDescription(
    data: ChatRouteRequest,
    threadId: string,
    agentId: string,
    agentSlug: string | null,
    scopes: ChatListenerScope[],
  ): string {
    const slugLabel = agentSlug ? ` (slug: ${agentSlug})` : '';
    const scopeLabel = scopes.length > 0 ? `Listener scopes: ${scopes.join(', ')}` : 'Listener scopes: (unknown)';
    const lines = [
      `Chat message from ${data.provider} (${data.account_id})`,
      `Thread: ${threadId}`,
      `Target agent: ${agentId}${slugLabel}`,
      scopeLabel,
      '',
      data.text,
    ];
    return lines.join('\n');
  }

  private async ensureThread(
    projectId: string,
    threadKey: string,
    channelId: string | null,
    hints?: ResolvedChatHints,
  ) {
    let thread = await this.threads.findByProjectAndKey(projectId, threadKey);
    if (thread) {
      // Thread existed — freshen metadata.harness_overrides so the
      // coordination thread reflects the latest override turn.
      if (hints) {
        const snapshot = this.buildHarnessOverridesSnapshot(hints);
        const metadata = { ...((thread.metadata_json as Record<string, unknown> | null) ?? {}) };
        if (snapshot) {
          metadata.harness_overrides = snapshot;
        } else {
          delete metadata.harness_overrides;
        }
        await this.threads.updateMetadata(thread.id, metadata);
      }
      return thread;
    }

    const initialMetadata = hints ? this.buildHarnessOverridesSnapshot(hints) : null;
    try {
      thread = await this.threads.create({
        id: generateThreadId(),
        project_id: projectId,
        key: threadKey,
        channel: channelId ?? null,
        peer: null,
        policy_json: null,
        summary: null,
        workspace_key: null,
        metadata_json: initialMetadata ? { harness_overrides: initialMetadata } : null,
      });
      return thread;
    } catch (error) {
      const existing = await this.threads.findByProjectAndKey(projectId, threadKey);
      if (existing) {
        return existing;
      }
      throw error;
    }
  }

  private async recordThreadAndEvent(
    projectId: string,
    data: ChatRouteRequest,
    hints?: ResolvedChatHints,
  ) {
    const threadKey = data.thread_key
      ?? `${data.provider}:${data.account_id}:${data.channel_id ?? data.user_id ?? 'unknown'}`;

    let thread = await this.threads.findByProjectAndKey(projectId, threadKey);
    if (!thread) {
      const metadata = this.buildThreadMetadata(data, null, undefined, hints);
      thread = await this.threads.create({
        id: generateThreadId(),
        project_id: projectId,
        key: threadKey,
        channel: data.channel_id ?? null,
        peer: data.user_id ?? null,
        policy_json: null,
        summary: null,
        workspace_key: null,
        metadata_json: metadata,
      });
    } else {
      // Keep metadata current for routing safety
      const metadata = this.buildThreadMetadata(
        data,
        thread.metadata_json as Record<string, unknown> | null,
        undefined,
        hints,
      );
      await this.threads.updateMetadata(thread.id, metadata);
    }

    await this.threadMessages.create({
      id: crypto.randomUUID(),
      thread_id: thread.id,
      direction: 'inbound',
      actor_type: 'user',
      actor_id: data.user_id ?? null,
      body: data.text,
      job_id: null,
    });

    await this.threads.touch(thread.id);

    const eventId = generateEventId();
    await this.events.create({
      id: eventId,
      project_id: projectId,
      type: 'chat.message.received',
      source: 'chat',
      env_name: null,
      ref_sha: null,
      ref_branch: null,
      actor_type: 'user',
      actor_id: data.user_id ?? null,
      payload_json: {
        provider: data.provider,
        account_id: data.account_id,
        channel_id: data.channel_id ?? null,
        user_id: data.user_id ?? null,
        text: data.text,
        metadata: data.metadata ?? null,
        thread_id: thread.id,
        thread_key: threadKey,
      },
      dedupe_key: null,
    });

    return { thread, eventId, threadKey };
  }
}
