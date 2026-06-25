import { postJson, getJson } from '../api-client.js';
import { createJsonLogger } from '@eve/shared';
import type { NormalizedInbound, MessageContent, GatewayProvider } from '../providers/gateway-provider.interface.js';
import {
  parseAgentCommand,
  parseAgentsCommand,
  type AgentsCommand,
} from '../providers/slack/slack-parser.js';
import {
  getIntegrationTokens,
  extractSlackToken,
  extractSlackBotUserId,
} from '../providers/slack/slack-sender.js';
import {
  formatJobRouted,
  formatError,
  formatAgentReply,
  markdownToMrkdwn,
} from '../providers/slack/slack-format.js';

const logger = createJsonLogger('gateway');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteResult {
  /** If set, the webhook controller should send this reply immediately. */
  immediateReply?: MessageContent;
  /** Whether this was a deduplicated event */
  duplicate?: boolean;
  /** Route metadata from the chat API (populated after successful agent routing) */
  routeResponse?: {
    thread_id: string;
    route_id: string | null;
    target: string | null;
    job_ids: string[];
    event_id: string | null;
    denied?: boolean;
    denial_reason?: string;
  };
}

interface ResolvedIntegration {
  integration_id: string;
  org_id: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Shared chat routing service used by all gateway providers.
 *
 * Resolves integrations and external identities, handles agent management
 * commands (agents list/listen/unlisten/listening), and routes regular
 * messages to the Eve API chat router.
 */
export class GatewayChatService {
  /**
   * Main entry point: resolve integration + identity, then route or handle
   * agent commands.
   *
   * @param provider - Optional provider instance for file resolution
   */
  async resolveAndRoute(inbound: NormalizedInbound, provider?: GatewayProvider): Promise<RouteResult> {
    // 1. Resolve integration (provider + accountId -> org_id)
    let integration: ResolvedIntegration | null = null;
    try {
      integration = await postJson<ResolvedIntegration>(
        '/internal/integrations/resolve',
        { provider: inbound.provider, account_id: inbound.accountId },
      );
    } catch (err) {
      logger.warn({
        event: 'slack.inbound.integration_not_found',
        provider: inbound.provider,
        accountId: inbound.accountId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
    if (!integration) {
      return {};
    }

    // 2. Resolve external identity (with Tier 1 email auto-match)
    let identityResult: {
      external_identity_id: string;
      eve_user_id?: string | null;
      membership_request_id?: string | null;
    } | null = null;

    if (inbound.externalUserId) {
      // Tier 1: Look up Slack user's email for auto-match
      let externalEmail: string | undefined;
      if (inbound.externalEmail) {
        externalEmail = inbound.externalEmail;  // Simulate mode: provided directly
      } else if (inbound.provider === 'slack') {
        externalEmail = await this.lookupSlackEmail(inbound.externalUserId, integration.integration_id);
      }

      try {
        identityResult = await postJson<{
          external_identity_id: string;
          eve_user_id?: string | null;
          membership_request_id?: string | null;
        }>(
          '/internal/integrations/external-identities/resolve',
          {
            provider: inbound.provider,
            account_id: inbound.accountId,
            external_user_id: inbound.externalUserId,
            org_id: integration.org_id,
            external_email: externalEmail,
          },
        );
        inbound.eveUserId = identityResult.eve_user_id ?? null;
        inbound.externalIdentityId = identityResult.external_identity_id ?? null;
      } catch (err) {
        logger.warn({
          event: 'slack.inbound.identity_resolve_failed',
          provider: inbound.provider,
          accountId: inbound.accountId,
          externalUserId: inbound.externalUserId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2b. Resolve files (download from provider, upload to Eve storage)
    if (inbound.files?.length && provider?.resolveFiles) {
      try {
        const messageTs = inbound.threadId || inbound.dedupeKey || 'unknown';
        const getUploadUrl = async (key: string, contentType?: string) => {
          const result = await postJson<{ url: string }>('/internal/storage/chat-attachments/presign', {
            key, operation: 'upload', content_type: contentType,
          });
          return result.url;
        };

        inbound.files = await provider.resolveFiles(inbound.files, {
          orgId: integration.org_id,
          channelId: inbound.channel,
          messageTs,
          accountId: inbound.accountId,
          provider: inbound.provider,
          getUploadUrl,
        });
      } catch (err) {
        logger.warn({ event: 'file.resolve_failed', error: String(err) });
        // Non-fatal: files stay as provider URLs
      }
    }

    // 3. Determine the flow based on event type
    const eventType = inbound.rawType;

    // --- Reaction events → post as thread feedback ---
    if (eventType === 'reaction_added' && inbound.reaction) {
      return this.handleReaction(inbound, integration);
    }

    // --- Plain message events (listener dispatch path) ---
    if (eventType === 'message') {
      return this.handleListenerMessage(inbound, integration);
    }

    // --- Command path (app_mention, Nostr DMs, Nostr mentions) ---
    const parsed = parseAgentCommand(inbound.text);
    const isNostrDM = inbound.provider === 'nostr' && inbound.rawType === 'kind:4';
    if (!parsed && !inbound.agentSlugHint && !isNostrDM) {
      return {};
    }

    // Check for "link" reserved command (Tier 2: self-service identity binding)
    const rawCommandText = parsed?.raw ?? inbound.text;
    if (this.isLinkCommand(rawCommandText)) {
      return this.handleLinkCommand(inbound, integration, rawCommandText);
    }

    // Check for "agents" management command
    const agentsCommand = parseAgentsCommand(rawCommandText);
    if (agentsCommand) {
      return this.handleAgentsCommand(agentsCommand, integration, inbound);
    }

    // Identity interception: if identity unresolved, give helpful message instead of routing
    if (identityResult && identityResult.external_identity_id && !identityResult.eve_user_id) {
      if (identityResult.membership_request_id) {
        return {
          immediateReply: { text: 'Your membership request is still pending. An admin will review it soon.' },
        };
      }
      return {
        immediateReply: {
          text: "I don't recognize your Slack account. If you already have an Eve account, link it by running:\n\n`eve identity link slack --org <org_slug>`\n\nOtherwise, a membership request has been sent to your org admins.",
        },
      };
    }

    // 4. Route to agent via the chat API
    return this.routeToAgent(inbound, integration, parsed);
  }

  // -------------------------------------------------------------------------
  // Message routing
  // -------------------------------------------------------------------------

  private async routeToAgent(
    inbound: NormalizedInbound,
    integration: ResolvedIntegration,
    parsed: { raw: string; first: string; rest: string } | null,
  ): Promise<RouteResult> {
    const agentSlug = inbound.agentSlugHint ?? parsed?.first.toLowerCase();
    const commandText = inbound.commandText ?? parsed?.rest ?? '';
    const rawText = parsed?.raw ?? inbound.text;
    const threadKey = this.buildThreadKey(inbound);
    const threadTs = inbound.threadId;

    try {
      const routeResponse = await postJson<{
        thread_id: string;
        route_id: string | null;
        target: string | null;
        job_ids: string[];
        event_id: string | null;
        denied?: boolean;
        denial_reason?: string;
      }>(`/internal/orgs/${integration.org_id}/chat/route`, {
        agent_slug_hint: agentSlug,
        command_text: commandText,
        raw_text: rawText,
        provider: inbound.provider,
        account_id: inbound.accountId,
        channel_id: inbound.channel || undefined,
        user_id: inbound.externalUserId || undefined,
        text: commandText || rawText,
        thread_key: threadKey || undefined,
        metadata: {
          dedupe_key: inbound.dedupeKey,
          integration_id: integration.integration_id,
          raw_text: inbound.text,
          eve_user_id: inbound.eveUserId,
          external_identity_id: inbound.externalIdentityId,
          files: inbound.files,
        },
      });

      if (routeResponse.denied) {
        const reason = routeResponse.denial_reason ?? 'Access denied.';
        const fmt = formatError(reason);
        return { immediateReply: { text: fmt.text, blocks: fmt.blocks }, routeResponse };
      }

      if (routeResponse.job_ids.length) {
        const fmt = formatJobRouted(routeResponse.job_ids, routeResponse.route_id, agentSlug);
        return { immediateReply: { text: fmt.text, blocks: fmt.blocks }, routeResponse };
      }

      return { immediateReply: { text: 'No matching chat route found.' }, routeResponse };
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      const lower = errMessage.toLowerCase();
      const isUnknown = lower.includes('agent slug');
      const isNoDefault = lower.includes('no default agent');
      const isDefaultMissing = lower.includes('default agent slug');

      const replyText = isUnknown
        ? `Unknown agent slug "${agentSlug}".`
        : isNoDefault
          ? 'No default agent configured. Ask an admin to set one or use a valid agent slug.'
          : isDefaultMissing
            ? 'Default agent is misconfigured. Ask an admin to update the org default agent slug.'
            : 'Unable to route command. Please try again.';

      const fmt = formatError(replyText);
      return { immediateReply: { text: fmt.text, blocks: fmt.blocks } };
    }
  }

  // -------------------------------------------------------------------------
  // Listener dispatch (plain message events)
  // -------------------------------------------------------------------------

  private async handleListenerMessage(
    inbound: NormalizedInbound,
    integration: ResolvedIntegration,
  ): Promise<RouteResult> {
    // Check if this message @mentions our bot -- if so, skip listener dispatch
    // (the app_mention event will handle it instead)
    const shouldSkip = await this.shouldSkipListenerMessage(inbound.text, integration.integration_id);
    if (shouldSkip) {
      return {};
    }

    const threadKey = this.buildThreadKey(inbound);
    if (!threadKey) {
      return {};
    }

    const channelKey = this.buildChannelKey(inbound);

    try {
      await postJson<{ job_ids: string[] }>(`/internal/orgs/${integration.org_id}/chat/dispatch`, {
        provider: inbound.provider,
        account_id: inbound.accountId,
        channel_id: inbound.channel || undefined,
        user_id: inbound.externalUserId || undefined,
        text: inbound.text,
        thread_key: threadKey,
        channel_key: channelKey ?? undefined,
        metadata: {
          dedupe_key: inbound.dedupeKey,
          integration_id: integration.integration_id,
          raw_text: inbound.text,
          files: inbound.files,
        },
      });
    } catch (err) {
      logger.warn({
        event: 'slack.listener.dispatch_failed',
        provider: inbound.provider,
        accountId: inbound.accountId,
        channel: inbound.channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {};
  }

  private async shouldSkipListenerMessage(text: string, integrationId: string): Promise<boolean> {
    if (!text || !text.includes('<@')) {
      return false;
    }
    const tokens = await getIntegrationTokens(integrationId);
    const botUserId = extractSlackBotUserId(tokens);
    if (!botUserId) {
      return false;
    }
    return text.includes(`<@${botUserId}>`);
  }

  // -------------------------------------------------------------------------
  // Agent management commands
  // -------------------------------------------------------------------------

  private async handleAgentsCommand(
    command: AgentsCommand,
    integration: ResolvedIntegration,
    inbound: NormalizedInbound,
  ): Promise<RouteResult> {
    if (command.type === 'directory') {
      return this.handleAgentsList(integration);
    }

    if (command.type === 'invalid') {
      return { immediateReply: { text: command.message } };
    }

    const raw = inbound.raw as { event?: { thread_ts?: string } } | undefined;
    const scope: 'channel' | 'thread' = raw?.event?.thread_ts ? 'thread' : 'channel';
    const threadKey = this.buildThreadKey(inbound);
    const channelKey = this.buildChannelKey(inbound);
    const targetKey = scope === 'thread' ? threadKey : channelKey;

    if (!targetKey) {
      return { immediateReply: { text: 'Unable to resolve channel/thread context for this command.' } };
    }

    if (command.type === 'listen') {
      return this.handleAgentsListen(command.slug, scope, targetKey, integration, inbound);
    }

    if (command.type === 'unlisten') {
      return this.handleAgentsUnlisten(command.slug, scope, targetKey, integration, inbound);
    }

    if (command.type === 'listening') {
      return this.handleAgentsListening(scope, integration, inbound);
    }

    return {};
  }

  private async handleAgentsList(integration: ResolvedIntegration): Promise<RouteResult> {
    try {
      const directory = await getJson<{
        org_id: string;
        default_agent_slug: string | null;
        agents: Array<{
          project_slug: string;
          agent_slug: string | null;
          agent_alias: string | null;
          agent_name: string | null;
          agent_description: string | null;
        }>;
      }>(`/internal/orgs/${integration.org_id}/agents`);

      const entries = directory.agents
        .filter((agent) => typeof agent.agent_slug === 'string' && agent.agent_slug.length > 0)
        .slice(0, 30)
        .map((agent) => {
          const details = agent.agent_description || agent.agent_name;
          const suffix = details ? ` (${details})` : '';
          const aliasLabel = agent.agent_alias ? ` (-> ${agent.agent_alias})` : '';
          return `${agent.agent_slug}${aliasLabel} — ${agent.project_slug}${suffix}`;
        });

      const header = directory.default_agent_slug
        ? `Default: ${directory.default_agent_slug}`
        : 'Default: (not set)';

      const body = entries.length > 0
        ? entries.join('\n')
        : 'No agent slugs configured.';

      return { immediateReply: { text: `${header}\n${body}\n\nUsage: @eve <agent-slug> <command>` } };
    } catch {
      return { immediateReply: { text: 'Unable to fetch agent directory.' } };
    }
  }

  private async handleAgentsListen(
    slug: string,
    scope: 'channel' | 'thread',
    targetKey: string,
    integration: ResolvedIntegration,
    inbound: NormalizedInbound,
  ): Promise<RouteResult> {
    try {
      const response = await postJson<{
        agent_slug: string;
      }>(`/internal/orgs/${integration.org_id}/chat/listen`, {
        provider: inbound.provider,
        account_id: inbound.accountId,
        channel_id: inbound.channel || undefined,
        thread_key: targetKey,
        scope,
        agent_slug: slug,
      });

      const location = scope === 'thread' ? 'this thread' : 'this channel';
      return { immediateReply: { text: `Listening: ${response.agent_slug} in ${location}.` } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const replyText = message.includes('not found')
        ? `Unknown agent slug "${slug}".`
        : 'Unable to add listener.';
      return { immediateReply: { text: replyText } };
    }
  }

  private async handleAgentsUnlisten(
    slug: string,
    scope: 'channel' | 'thread',
    targetKey: string,
    integration: ResolvedIntegration,
    inbound: NormalizedInbound,
  ): Promise<RouteResult> {
    try {
      const response = await postJson<{
        removed: boolean;
        agent_slug: string;
      }>(`/internal/orgs/${integration.org_id}/chat/unlisten`, {
        provider: inbound.provider,
        account_id: inbound.accountId,
        channel_id: inbound.channel || undefined,
        thread_key: targetKey,
        scope,
        agent_slug: slug,
      });

      const location = scope === 'thread' ? 'this thread' : 'this channel';
      const text = response.removed
        ? `Stopped listening: ${response.agent_slug} in ${location}.`
        : `No active listener for ${slug} in ${location}.`;
      return { immediateReply: { text } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const replyText = message.includes('not found')
        ? `Unknown agent slug "${slug}".`
        : 'Unable to remove listener.';
      return { immediateReply: { text: replyText } };
    }
  }

  private async handleAgentsListening(
    scope: 'channel' | 'thread',
    integration: ResolvedIntegration,
    inbound: NormalizedInbound,
  ): Promise<RouteResult> {
    const channelKey = this.buildChannelKey(inbound);
    if (!channelKey) {
      return { immediateReply: { text: 'Unable to resolve channel context.' } };
    }

    const threadKey = this.buildThreadKey(inbound);

    try {
      const response = await postJson<{
        channel_listeners: Array<{
          project_slug: string;
          agent_slug: string | null;
          agent_name: string | null;
          agent_description: string | null;
        }>;
        thread_listeners: Array<{
          project_slug: string;
          agent_slug: string | null;
          agent_name: string | null;
          agent_description: string | null;
        }>;
      }>(`/internal/orgs/${integration.org_id}/chat/listeners`, {
        channel_key: channelKey,
        thread_key: scope === 'thread' ? threadKey ?? undefined : undefined,
      });

      const formatEntry = (listener: { project_slug: string; agent_slug: string | null; agent_name: string | null; agent_description: string | null }): string => {
        const slug = listener.agent_slug ?? listener.agent_name ?? 'unknown-agent';
        const details = listener.agent_description || listener.agent_name;
        const suffix = details ? ` (${details})` : '';
        return `${slug} — ${listener.project_slug}${suffix}`;
      };

      const channelLines = response.channel_listeners.map(formatEntry);
      const threadLines = response.thread_listeners.map(formatEntry);

      const sections: string[] = [];
      sections.push('Channel listeners:');
      sections.push(channelLines.length ? channelLines.join('\n') : '(none)');
      if (scope === 'thread') {
        sections.push('');
        sections.push('Thread listeners:');
        sections.push(threadLines.length ? threadLines.join('\n') : '(none)');
      }
      sections.push('');
      sections.push('Usage: @eve agents listen <agent-slug>');

      return { immediateReply: { text: sections.join('\n') } };
    } catch {
      return { immediateReply: { text: 'Unable to fetch listeners.' } };
    }
  }

  // -------------------------------------------------------------------------
  // Reaction handling
  // -------------------------------------------------------------------------

  private async handleReaction(
    inbound: NormalizedInbound,
    integration: ResolvedIntegration,
  ): Promise<RouteResult> {
    const threadKey = this.buildThreadKey(inbound);
    if (!threadKey) return {};

    try {
      await postJson(`/internal/orgs/${integration.org_id}/chat/feedback`, {
        provider: inbound.provider,
        account_id: inbound.accountId,
        channel_id: inbound.channel || undefined,
        user_id: inbound.externalUserId || undefined,
        thread_key: threadKey,
        feedback_type: 'reaction',
        feedback_value: inbound.reaction,
        metadata: {
          dedupe_key: inbound.dedupeKey,
          integration_id: integration.integration_id,
        },
      });
    } catch (err) {
      logger.warn({
        event: 'slack.reaction.feedback_failed',
        provider: inbound.provider,
        reaction: inbound.reaction,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {};
  }

  // -------------------------------------------------------------------------
  // Tier 1: Slack email lookup
  // -------------------------------------------------------------------------

  private async lookupSlackEmail(externalUserId: string, integrationId: string): Promise<string | undefined> {
    try {
      const tokens = await getIntegrationTokens(integrationId);
      const botToken = extractSlackToken(tokens);
      if (!botToken) return undefined;

      const resp = await fetch(`https://slack.com/api/users.info?user=${externalUserId}`, {
        headers: { authorization: `Bearer ${botToken}` },
      });
      const data = await resp.json() as { ok?: boolean; user?: { profile?: { email?: string } } };
      return data.ok ? data.user?.profile?.email ?? undefined : undefined;
    } catch (err) {
      logger.warn({
        event: 'slack.identity.email_lookup_failed',
        externalUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Tier 2: Link command (self-service identity binding)
  // -------------------------------------------------------------------------

  private isLinkCommand(text: string): boolean {
    const lower = text.toLowerCase().trim();
    return lower.startsWith('link ') || lower === 'link';
  }

  private async handleLinkCommand(
    inbound: NormalizedInbound,
    integration: ResolvedIntegration,
    rawText: string,
  ): Promise<RouteResult> {
    const parts = rawText.trim().split(/\s+/);
    const token = parts[1]; // "link <token>"
    if (!token) {
      return {
        immediateReply: {
          text: 'Usage: `@eve link <token>`\n\nGenerate a link token by running:\n`eve identity link slack --org <org_slug>`',
        },
      };
    }

    try {
      const result = await postJson<{ ok: boolean; external_identity_id?: string; error?: string }>(
        '/internal/identity-link-tokens/redeem',
        {
          token,
          provider: inbound.provider,
          account_id: inbound.accountId,
          external_user_id: inbound.externalUserId,
        },
      );

      if (result.ok) {
        return {
          immediateReply: { text: "Your Slack account is now linked to your Eve account. You're all set!" },
        };
      }

      return {
        immediateReply: {
          text: `${result.error ?? 'Link failed'}. Run \`eve identity link slack --org <org_slug>\` to get a new token.`,
        },
      };
    } catch (err) {
      logger.warn({
        event: 'slack.identity.link_redeem_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        immediateReply: { text: 'Unable to process link token. Please try again.' },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Thread / channel key builders
  // -------------------------------------------------------------------------

  /**
   * Build a deterministic thread key from inbound message data.
   * Format: "accountId:channel:threadId"
   *
   * This matches the existing Slack controller format:
   * buildThreadKey(teamId, channelId, threadTs) => "teamId:channelId:threadTs"
   */
  buildThreadKey(inbound: NormalizedInbound): string | null {
    if (!inbound.accountId || !inbound.channel || !inbound.threadId) {
      return null;
    }
    return [inbound.accountId, inbound.channel, inbound.threadId].join(':');
  }

  /**
   * Build a channel key for listener scope.
   * Format: "accountId:channel"
   */
  private buildChannelKey(inbound: NormalizedInbound): string | null {
    if (!inbound.accountId || !inbound.channel) {
      return null;
    }
    return [inbound.accountId, inbound.channel].join(':');
  }
}
