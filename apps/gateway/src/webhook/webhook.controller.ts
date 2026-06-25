import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createJsonLogger } from '@eve/shared';
import { GatewayProviderRegistry } from '../providers/provider-registry.js';
import { GatewayChatService } from '../chat/gateway-chat.service.js';
import { postJson, getJson } from '../api-client.js';
import type { WebhookRequest, SimulateRequest, SimulateResponse, NormalizedInbound } from '../providers/gateway-provider.interface.js';

const logger = createJsonLogger('gateway');

// ---------------------------------------------------------------------------
// Sentinel channel ID resolution (cached, single source of truth from DB)
// ---------------------------------------------------------------------------

const SENTINEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedSentinelChannelId: string | null = null;
let sentinelCacheExpiry = 0;

async function resolveSentinelChannelId(): Promise<string | null> {
  // Env var override takes precedence (explicit config)
  const envOverride = process.env.EVE_SENTINEL_CHANNEL_ID;
  if (envOverride) return envOverride;

  // Return cached value if fresh
  if (Date.now() < sentinelCacheExpiry) return cachedSentinelChannelId;

  // Fetch from API (same DB setting used for outbound notifications)
  try {
    const config = await getJson<{ channel_id: string | null }>('/internal/sentinel-config');
    cachedSentinelChannelId = config.channel_id;
    sentinelCacheExpiry = Date.now() + SENTINEL_CACHE_TTL_MS;
    return cachedSentinelChannelId;
  } catch {
    // If API is unreachable, don't retry for 30s
    sentinelCacheExpiry = Date.now() + 30_000;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inbound deduplication cache (5-minute TTL, auto-evict)
// ---------------------------------------------------------------------------

const DEDUPE_TTL_MS = 5 * 60 * 1000;
const DEDUPE_MAX_SIZE = 10_000;

const seenEventIds = new Map<string, number>();

function isDuplicate(dedupeKey: string | undefined): boolean {
  if (!dedupeKey) return false;
  const now = Date.now();

  // Evict stale entries periodically (when map grows large)
  if (seenEventIds.size > DEDUPE_MAX_SIZE) {
    for (const [key, ts] of seenEventIds) {
      if (now - ts > DEDUPE_TTL_MS) seenEventIds.delete(key);
    }
  }

  if (seenEventIds.has(dedupeKey)) {
    const ts = seenEventIds.get(dedupeKey)!;
    if (now - ts < DEDUPE_TTL_MS) return true;
  }

  seenEventIds.set(dedupeKey, now);
  return false;
}

/**
 * Generic Webhook Controller
 *
 * Handles inbound webhooks for all webhook-transport gateway providers.
 * Routes requests through the provider's validation/parsing pipeline and
 * then into the shared GatewayChatService for integration resolution,
 * identity mapping, and agent routing.
 *
 * URL: POST /gateway/providers/:provider/webhook
 * URL: POST /gateway/providers/slack/interactive
 */
@Controller('gateway/providers')
export class WebhookController {
  constructor(
    private readonly registry: GatewayProviderRegistry,
    private readonly chatService: GatewayChatService,
  ) {}

  @Post(':provider/webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Param('provider') providerName: string,
    @Req() req: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string },
  ): Promise<unknown> {
    const startMs = Date.now();
    const validationProvider = this.registry.getByProvider(providerName);
    if (!validationProvider || validationProvider.transport !== 'webhook') {
      throw new NotFoundException(`Unknown webhook provider: ${providerName}`);
    }

    if (!validationProvider.validateWebhook || !validationProvider.parseWebhook) {
      throw new NotFoundException(`Provider ${providerName} does not support webhooks`);
    }

    // 1. Validate signature
    const webhookReq: WebhookRequest = {
      headers: req.headers,
      body: req.body,
      rawBody: req.rawBody,
    };

    const validation = validationProvider.validateWebhook(webhookReq);
    if (!validation.valid) {
      if (validation.status === 400) {
        throw new BadRequestException(validation.body ?? 'Bad request');
      }
      throw new UnauthorizedException(validation.body ?? 'Invalid signature');
    }

    // 2. Parse inbound event
    const parsed = await validationProvider.parseWebhook(webhookReq);

    if (parsed.type === 'handshake') {
      if (parsed.response.status !== 200) {
        throw new HttpException(parsed.response.body as Record<string, unknown>, parsed.response.status);
      }
      return parsed.response.body;
    }

    if (parsed.type === 'ignored') {
      return { ok: true };
    }

    // 3. Deduplication — drop events we've already seen
    if (isDuplicate(parsed.inbound.dedupeKey)) {
      logger.log({ event: 'webhook.deduplicated', provider: providerName, dedupeKey: parsed.inbound.dedupeKey });
      return { ok: true };
    }

    // 4. Route and reply asynchronously to stay within Slack's 3s deadline.
    //    We return 200 immediately and process in the background.
    const inbound = parsed.inbound;
    setImmediate(async () => {
      try {
        // Resolve account-specific provider now that accountId is known from parsing.
        // Falls back to validationProvider for single-integration setups.
        const accountProvider = this.registry.getInstance(providerName, inbound.accountId) ?? validationProvider;

        // --- Platform Sentinel channel routing ---
        // If the message is from the sentinel notification channel, route to the
        // platform responder instead of the normal agent routing flow.
        const sentinelChannelId = await resolveSentinelChannelId();
        if (sentinelChannelId && inbound.channel === sentinelChannelId) {
          try {
            const response = await postJson<{ text: string }>('/internal/platform-respond', {
              text: inbound.text ?? '',
              channel_id: inbound.channel,
              thread_ts: inbound.threadId,
            });
            if (response.text) {
              await accountProvider.sendMessage(
                {
                  provider: providerName,
                  accountId: inbound.accountId,
                  channel: inbound.channel,
                  threadId: inbound.threadId,
                },
                { text: response.text },
              );
            }
          } catch (err) {
            logger.warn({
              event: 'sentinel.responder_error',
              channel: inbound.channel,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return; // Skip normal agent routing for sentinel channel
        }

        const result = await this.chatService.resolveAndRoute(inbound, accountProvider);
        if (result.immediateReply) {
          await accountProvider.sendMessage(
            {
              provider: providerName,
              accountId: inbound.accountId,
              channel: inbound.channel,
              threadId: inbound.threadId,
            },
            result.immediateReply,
          );
        }
      } catch (err) {
        logger.warn({
          event: 'webhook.async_processing_error',
          provider: providerName,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        const latencyMs = Date.now() - startMs;
        logger.log({
          event: 'slack.webhook_latency_ms',
          provider: providerName,
          latencyMs,
        });
      }
    });

    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Simulate endpoint (routes through gateway without real webhook)
  // ---------------------------------------------------------------------------

  @Post('simulate')
  @HttpCode(HttpStatus.OK)
  async handleSimulate(
    @Req() req: { body: unknown },
  ): Promise<SimulateResponse> {
    if ((process.env.EVE_SIMULATE_ENABLED ?? '').toLowerCase() !== 'true') {
      throw new NotFoundException('Simulate endpoint disabled');
    }

    const body = req.body as SimulateRequest;
    const dedupeKey = body.dedupe_key;

    // Dedup check (same cache as real webhooks)
    if (dedupeKey && isDuplicate(dedupeKey)) {
      return { immediate_reply: null, duplicate: true, route: null };
    }

    const now = Date.now();

    // Parse agent slug hint from text for simulate mode.
    // In real Slack, the provider strips <@BOT> and extracts the first word.
    // For simulate, if the text doesn't start with <@ or @, treat the first
    // word as the agent slug and the rest as command text.
    let agentSlugHint: string | undefined;
    let commandText: string | undefined;
    const trimmedText = body.text.trim();
    if (!trimmedText.startsWith('<@') && !trimmedText.startsWith('@')) {
      const [first, ...rest] = trimmedText.split(/\s+/);
      if (first) {
        agentSlugHint = first.toLowerCase();
        commandText = rest.join(' ').trim() || undefined;
      }
    }

    const inbound: NormalizedInbound = {
      rawType: body.event_type ?? 'app_mention',
      provider: body.provider ?? 'slack',
      accountId: body.account_id,
      externalUserId: body.user_id ?? '',
      channel: body.channel_id ?? `sim-${now}`,
      threadId: body.thread_id ?? `sim-${now}.000001`,
      text: body.text,
      agentSlugHint,
      commandText,
      externalEmail: body.external_email,
      dedupeKey,
      raw: body,
    };

    const result = await this.chatService.resolveAndRoute(inbound);

    return {
      immediate_reply: result.immediateReply ?? null,
      duplicate: result.duplicate ?? false,
      route: result.routeResponse ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Slack Interactive Components (Tier 3: membership approval buttons)
  // ---------------------------------------------------------------------------

  @Post('slack/interactive')
  @HttpCode(HttpStatus.OK)
  async handleSlackInteractive(
    @Req() req: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string },
  ): Promise<unknown> {
    // Slack sends interactive payloads as application/x-www-form-urlencoded
    // with a 'payload' field containing JSON
    const formBody = req.body as Record<string, unknown>;
    const payloadStr = typeof formBody?.payload === 'string' ? formBody.payload : null;
    if (!payloadStr) {
      throw new BadRequestException('Missing interactive payload');
    }

    // Verify signature using per-org signing secret from the provider instance
    const slackProvider = this.registry.getByProvider('slack');
    if (slackProvider) {
      const validation = slackProvider.validateWebhook?.({
        headers: req.headers,
        body: req.body,
        rawBody: req.rawBody,
      });
      if (validation && !validation.valid) {
        throw new UnauthorizedException('Invalid Slack signature');
      }
    }

    let payload: {
      type: string;
      actions?: Array<{ action_id: string; value: string }>;
      user?: { id: string; name?: string };
      channel?: { id: string };
      message?: { ts: string };
      team?: { id: string };
    };
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      throw new BadRequestException('Invalid interactive payload JSON');
    }

    if (payload.type !== 'block_actions' || !payload.actions?.length) {
      return { ok: true };
    }

    for (const action of payload.actions) {
      if (action.action_id === 'membership_approve') {
        await this.handleMembershipAction(action.value, 'approve', payload.team?.id);
      } else if (action.action_id === 'membership_deny') {
        await this.handleMembershipAction(action.value, 'deny', payload.team?.id);
      }
    }

    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Slack Slash Commands (e.g., /eve <agent-slug> <command>)
  // ---------------------------------------------------------------------------

  @Post('slack/slash')
  @HttpCode(HttpStatus.OK)
  async handleSlackSlash(
    @Req() req: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string },
  ): Promise<unknown> {
    // Slack sends slash commands as application/x-www-form-urlencoded
    const formBody = req.body as Record<string, unknown>;

    // Verify signature using per-org signing secret from the provider instance
    const slashSlackProvider = this.registry.getByProvider('slack');
    if (slashSlackProvider) {
      const validation = slashSlackProvider.validateWebhook?.({
        headers: req.headers,
        body: req.body,
        rawBody: req.rawBody,
      });
      if (validation && !validation.valid) {
        throw new UnauthorizedException('Invalid Slack signature');
      }
    }

    const teamId = typeof formBody.team_id === 'string' ? formBody.team_id : '';
    const userId = typeof formBody.user_id === 'string' ? formBody.user_id : '';
    const channelId = typeof formBody.channel_id === 'string' ? formBody.channel_id : '';
    const text = typeof formBody.text === 'string' ? formBody.text.trim() : '';

    if (!teamId || !text) {
      return { response_type: 'ephemeral', text: 'Usage: /eve <agent-slug> <command>' };
    }

    // Resolve integration
    let integration: { integration_id: string; org_id: string } | null = null;
    try {
      integration = await postJson<{ integration_id: string; org_id: string }>(
        '/internal/integrations/resolve',
        { provider: 'slack', account_id: teamId },
      );
    } catch {
      return { response_type: 'ephemeral', text: 'Slack workspace is not connected to Eve.' };
    }

    if (!integration) {
      return { response_type: 'ephemeral', text: 'Slack workspace is not connected to Eve.' };
    }

    // Parse "<agent-slug> <command>" from slash command text
    const [agentSlug, ...restTokens] = text.split(/\s+/);
    const commandText = restTokens.join(' ').trim();

    // Route asynchronously — respond with ephemeral ack
    setImmediate(async () => {
      try {
        await postJson(`/internal/orgs/${integration!.org_id}/chat/route`, {
          agent_slug_hint: agentSlug?.toLowerCase(),
          command_text: commandText,
          raw_text: text,
          provider: 'slack',
          account_id: teamId,
          channel_id: channelId || undefined,
          user_id: userId || undefined,
          text: commandText || text,
          metadata: { source: 'slash_command', integration_id: integration!.integration_id },
        });
      } catch (err) {
        logger.warn({
          event: 'slack.slash.route_failed',
          teamId,
          text,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return { response_type: 'ephemeral', text: `Processing: \`${agentSlug}\` ${commandText}` };
  }

  private async handleMembershipAction(
    requestId: string,
    action: 'approve' | 'deny',
    teamId?: string,
  ): Promise<void> {
    try {
      // Resolve the org from the team ID
      let orgId: string | null = null;
      if (teamId) {
        const resolution = await postJson<{ integration_id: string; org_id: string }>(
          '/internal/integrations/resolve',
          { provider: 'slack', account_id: teamId },
        );
        orgId = resolution.org_id;
      }

      if (!orgId) {
        logger.warn({ event: 'slack.interactive.no_org', requestId, teamId });
        return;
      }

      if (action === 'approve') {
        await postJson(`/internal/membership-requests/${requestId}/approve`, {
          org_id: orgId,
          approved_by: 'slack_admin',
          role: 'member',
        });
      } else {
        await postJson(`/internal/membership-requests/${requestId}/deny`, {
          org_id: orgId,
          denied_by: 'slack_admin',
        });
      }

      logger.log({
        event: `slack.interactive.membership_${action}d`,
        requestId,
        orgId,
      });
    } catch (err) {
      logger.warn({
        event: 'slack.interactive.action_failed',
        requestId,
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
