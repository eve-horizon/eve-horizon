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
import { createJsonLogger, INTERNAL_TOKEN_HEADER, internalTokenMatches } from '@eve/shared';
import { GatewayProviderRegistry } from '../providers/provider-registry.js';
import { GatewayChatService } from '../chat/gateway-chat.service.js';
import { postJson, getJson } from '../api-client.js';
import { isSimulateEnabled } from '../simulate-mode.js';
import type {
  GatewayProvider,
  WebhookRequest,
  SimulateRequest,
  SimulateResponse,
  NormalizedInbound,
} from '../providers/gateway-provider.interface.js';

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
    const anyInstance = this.registry.getByProvider(providerName);
    if (!anyInstance || anyInstance.transport !== 'webhook') {
      throw new NotFoundException(`Unknown webhook provider: ${providerName}`);
    }

    if (!anyInstance.validateWebhook || !anyInstance.parseWebhook) {
      throw new NotFoundException(`Provider ${providerName} does not support webhooks`);
    }

    const webhookReq: WebhookRequest = {
      headers: req.headers,
      body: req.body,
      rawBody: req.rawBody,
    };

    // 1. Verify the signature with the secret of the integration the request
    //    names (e.g. Slack team_id). A request that names none, such as a
    //    protocol handshake, may verify with any connected integration's
    //    secret, and is then only answered as a handshake.
    const accountId = anyInstance.webhookAccountId?.(webhookReq);
    const validationProvider = accountId
      ? this.verifyForAccount(providerName, accountId, webhookReq)
      : this.verifyForAnyAccount(providerName, webhookReq);
    if (!validationProvider.parseWebhook) {
      throw new NotFoundException(`Provider ${providerName} does not support webhooks`);
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

    // A message must belong to the integration whose secret verified it.
    if (!accountId || parsed.inbound.accountId !== accountId) {
      throw new UnauthorizedException('Unknown integration');
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
        // The verifying instance is the one for this message's account.
        const accountProvider = validationProvider;

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
  // Simulate endpoint (routes through gateway without real webhook).
  // Development and tests only: needs EVE_SIMULATE_ENABLED=true and the
  // internal service token.
  // ---------------------------------------------------------------------------

  @Post('simulate')
  @HttpCode(HttpStatus.OK)
  async handleSimulate(
    @Req() req: { headers: Record<string, string | string[] | undefined>; body: unknown },
  ): Promise<SimulateResponse> {
    if (!isSimulateEnabled()) {
      throw new NotFoundException('Simulate endpoint disabled');
    }
    if (!internalTokenMatches(req.headers?.[INTERNAL_TOKEN_HEADER], process.env.EVE_INTERNAL_API_KEY)) {
      throw new UnauthorizedException('Missing or invalid internal token');
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

    // Verify with the signing secret of the workspace the payload names.
    const teamId = typeof payload.team?.id === 'string' ? payload.team.id : undefined;
    this.verifyForAccount('slack', teamId, {
      headers: req.headers,
      body: req.body,
      rawBody: req.rawBody,
    });

    if (payload.type !== 'block_actions' || !payload.actions?.length) {
      return { ok: true };
    }

    for (const action of payload.actions) {
      if (action.action_id === 'membership_approve') {
        await this.handleMembershipAction(action.value, 'approve', teamId);
      } else if (action.action_id === 'membership_deny') {
        await this.handleMembershipAction(action.value, 'deny', teamId);
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
    const formBody = (req.body ?? {}) as Record<string, unknown>;
    const teamId = typeof formBody.team_id === 'string' ? formBody.team_id : '';

    // Verify with the signing secret of the workspace the command names.
    this.verifyForAccount('slack', teamId || undefined, {
      headers: req.headers,
      body: req.body,
      rawBody: req.rawBody,
    });

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

  /**
   * Verify a webhook with the signing secret of the integration whose account
   * it names, and return that integration's provider instance. Refuses (401)
   * when no active integration has that account or the signature does not
   * match its secret; never falls back to another integration's secret.
   */
  private verifyForAccount(
    providerName: string,
    accountId: string | undefined,
    req: WebhookRequest,
  ): GatewayProvider {
    const provider = accountId ? this.registry.getInstance(providerName, accountId) : undefined;
    if (!provider?.validateWebhook) {
      throw new UnauthorizedException('Unknown integration');
    }
    const validation = provider.validateWebhook(req);
    if (!validation.valid) {
      if (validation.status === 400) {
        throw new BadRequestException(validation.body ?? 'Bad request');
      }
      throw new UnauthorizedException(validation.body ?? 'Invalid signature');
    }
    return provider;
  }

  /**
   * Verify a webhook that names no account (e.g. Slack's url_verification
   * handshake) against each connected integration's own secret.
   */
  private verifyForAnyAccount(providerName: string, req: WebhookRequest): GatewayProvider {
    for (const provider of this.registry.listByProvider(providerName)) {
      if (provider.validateWebhook?.(req).valid) {
        return provider;
      }
    }
    throw new UnauthorizedException('Invalid signature');
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
