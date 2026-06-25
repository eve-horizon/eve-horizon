import type {
  GatewayProvider,
  GatewayTransport,
  GatewayCapability,
  ProviderConfig,
  WebhookRequest,
  WebhookValidation,
  WebhookParseResult,
  NormalizedInbound,
  OutboundTarget,
  MessageContent,
} from '../gateway-provider.interface.js';
import { createJsonLogger, sanitizeFilename } from '@eve/shared';
import type { ChatFile, FileResolveContext } from '@eve/shared';
import { isValidSlackSignature } from './slack-signature.js';
import {
  isBotEvent,
  isPlainMessageEvent,
  extractText,
  parseAgentCommand,
  type SlackWebhookPayload,
  type SlackEventCallbackPayload,
} from './slack-parser.js';
import {
  extractSlackToken,
  extractSlackBotUserId,
  getIntegrationTokens,
  sendSlackMessage,
} from './slack-sender.js';

const logger = createJsonLogger('gateway');

/**
 * Slack Gateway Provider
 *
 * Implements the GatewayProvider interface for Slack's webhook-based transport.
 * Handles HMAC signature verification, URL verification challenges, event
 * parsing (app_mention + message), bot filtering, and chat.postMessage replies.
 */
export class SlackGatewayProvider implements GatewayProvider {
  readonly name = 'slack';
  readonly transport: GatewayTransport = 'webhook';
  readonly capabilities: GatewayCapability[] = ['inbound', 'outbound', 'identity'];

  private signingSecret: string | null = null;
  private integrationId: string | null = null;

  async initialize(config: ProviderConfig): Promise<void> {
    this.integrationId = config.integration.id;
    // Signing secret comes from per-org oauth_app_configs (enriched into settings by the API)
    this.signingSecret = (config.settings['signing_secret'] as string) ?? null;
  }

  async shutdown(): Promise<void> {
    // No persistent connections for webhook transport
  }

  // -------------------------------------------------------------------------
  // Webhook validation
  // -------------------------------------------------------------------------

  validateWebhook(req: WebhookRequest): WebhookValidation {
    const secret = this.signingSecret;
    if (!secret) {
      return { valid: false, status: 401, body: { error: 'Slack signing secret not configured' } };
    }

    const signature = headerString(req.headers['x-slack-signature']);
    const timestamp = headerString(req.headers['x-slack-request-timestamp']);
    const rawBody = req.rawBody ?? '';

    if (!signature || !timestamp || !rawBody) {
      return { valid: false, status: 401, body: { error: 'Missing Slack signature headers' } };
    }

    if (!isValidSlackSignature(secret, rawBody, signature, timestamp)) {
      return { valid: false, status: 401, body: { error: 'Invalid Slack signature' } };
    }

    return { valid: true };
  }

  // -------------------------------------------------------------------------
  // Webhook parsing
  // -------------------------------------------------------------------------

  async parseWebhook(req: WebhookRequest): Promise<WebhookParseResult> {
    const payload = req.body as SlackWebhookPayload;

    // --- URL verification challenge ---
    if (payload.type === 'url_verification') {
      if (!payload.challenge) {
        return { type: 'handshake', response: { status: 400, body: { error: 'Missing Slack challenge' } } };
      }
      return { type: 'handshake', response: { status: 200, body: { challenge: payload.challenge } } };
    }

    // --- Event callback ---
    if (payload.type !== 'event_callback' || !payload.event?.type) {
      return { type: 'ignored' };
    }

    const eventPayload = payload as SlackEventCallbackPayload;

    // Drop bot events
    if (isBotEvent(eventPayload.event)) {
      return { type: 'ignored' };
    }

    const eventType = eventPayload.event.type;
    if (eventType !== 'app_mention' && eventType !== 'message' && eventType !== 'reaction_added') {
      return { type: 'ignored' };
    }

    const teamId = eventPayload.team_id;
    if (!teamId) {
      return { type: 'ignored' };
    }

    // For plain message events (listener dispatch path), check if the message
    // is a direct @mention of our bot -- those should go through the command path
    // via app_mention, not the listener path. We handle this by checking if the
    // integration tokens contain a bot_user_id and the text includes it.
    if (eventType === 'message') {
      if (!isPlainMessageEvent(eventPayload.event)) {
        return { type: 'ignored' };
      }
    }

    const rawText = extractText(eventPayload);
    const eventRecord = eventPayload.event as Record<string, unknown>;
    const item = eventRecord.item as Record<string, unknown> | undefined;
    const channelId = eventPayload.event.channel ?? (item?.channel as string | undefined) ?? '';
    const userId = eventPayload.event.user ?? '';
    const threadTs = eventPayload.event.thread_ts ?? eventPayload.event.ts ?? eventPayload.event_id;

    // Parse @agent command for app_mention events
    let agentSlugHint: string | undefined;
    let commandText: string | undefined;
    if (eventType === 'app_mention') {
      const parsed = parseAgentCommand(rawText);
      if (parsed) {
        agentSlugHint = parsed.first.toLowerCase();
        commandText = parsed.rest;
      }
    }

    // Extract reaction name for reaction_added events
    let reaction: string | undefined;
    if (eventType === 'reaction_added') {
      reaction = (eventPayload.event as Record<string, unknown>).reaction as string | undefined;
    }

    // Extract file attachments
    const rawFiles = (eventPayload.event as Record<string, unknown>).files;
    let files: NormalizedInbound['files'];
    if (Array.isArray(rawFiles) && rawFiles.length > 0) {
      files = rawFiles.slice(0, 10).map((f: Record<string, unknown>) => ({
        id: String(f.id ?? ''),
        name: String(f.name ?? f.title ?? 'unnamed'),
        mimetype: typeof f.mimetype === 'string' ? f.mimetype : undefined,
        url: typeof f.url_private === 'string' ? f.url_private : undefined,
        size: typeof f.size === 'number' ? f.size : undefined,
      }));
    }

    const inbound: NormalizedInbound = {
      rawType: eventType,
      provider: 'slack',
      accountId: teamId,
      externalUserId: userId,
      channel: channelId as string,
      threadId: threadTs,
      text: rawText,
      agentSlugHint,
      commandText,
      reaction,
      files,
      dedupeKey: `slack:${eventPayload.event_id}`,
      raw: eventPayload,
    };

    return { type: 'message', inbound };
  }

  // -------------------------------------------------------------------------
  // Outbound messaging
  // -------------------------------------------------------------------------

  async sendMessage(target: OutboundTarget, content: MessageContent): Promise<void> {
    if (!target.channel) return;

    const integrationId = this.integrationId;
    if (!integrationId) return;

    const tokens = await getIntegrationTokens(integrationId);
    const token = extractSlackToken(tokens);
    if (!token) {
      logger.warn({
        event: 'slack.outbound.no_token',
        integrationId,
        channel: target.channel,
      });
      return;
    }

    const result = await sendSlackMessage({
      token,
      channelId: target.channel,
      text: content.text,
      threadTs: target.threadId,
      blocks: content.blocks as unknown[] | undefined,
    });

    if (!result.ok) {
      logger.warn({
        event: 'slack.outbound.failed',
        integrationId,
        channel: target.channel,
        httpStatus: result.httpStatus,
        error: result.error,
      });
    }
  }
  // -------------------------------------------------------------------------
  // File resolution
  // -------------------------------------------------------------------------

  async resolveFiles(files: ChatFile[], context: FileResolveContext): Promise<ChatFile[]> {
    if (!this.integrationId) {
      logger.warn({ event: 'slack.files.no_integration' });
      return files;
    }
    const tokens = await getIntegrationTokens(this.integrationId);
    const token = extractSlackToken(tokens);
    if (!token) {
      logger.warn({ event: 'slack.files.no_token', integrationId: this.integrationId });
      return files;
    }

    const resolved: ChatFile[] = [];
    let totalSize = 0;

    for (const file of files) {
      if (!file.url || !file.id) {
        resolved.push(file);
        continue;
      }

      // Enforce per-file size limit before downloading
      if (file.size && file.size > MAX_FILE_SIZE) {
        logger.warn({ event: 'file.too_large', fileId: file.id, size: file.size });
        resolved.push({ ...file, source_url: file.url, source_provider: 'slack' });
        continue;
      }

      // Enforce total size limit
      if (file.size) {
        totalSize += file.size;
        if (totalSize > MAX_TOTAL_SIZE) {
          logger.warn({ event: 'file.total_limit_exceeded', fileId: file.id, totalSize });
          resolved.push({ ...file, source_url: file.url, source_provider: 'slack' });
          continue;
        }
      }

      // Download from Slack — disable redirect following to catch CDN auth failures
      let response: Response;
      try {
        response = await fetch(file.url, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'manual',
        });
      } catch (err) {
        logger.warn({ event: 'file.download_error', fileId: file.id, error: String(err) });
        resolved.push({ ...file, source_url: file.url, source_provider: 'slack', error: 'download_error' });
        continue;
      }

      // Treat any redirect as an auth failure (Slack CDN redirects to login page on bad token)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') || '';
        logger.warn({
          event: 'file.auth_redirect',
          fileId: file.id,
          fileName: file.name,
          status: response.status,
          location: location.slice(0, 200),
        });
        resolved.push({ ...file, source_url: file.url, source_provider: 'slack', error: 'auth_failed' });
        continue;
      }

      if (!response.ok) {
        logger.warn({ event: 'file.download_failed', fileId: file.id, status: response.status });
        resolved.push({ ...file, source_url: file.url, source_provider: 'slack', error: 'download_failed' });
        continue;
      }

      if (!response.body) {
        logger.warn({ event: 'file.empty_response', fileId: file.id });
        resolved.push({ ...file, source_url: file.url, source_provider: 'slack', error: 'empty_response' });
        continue;
      }

      // Validate content-type — catch HTML login pages masquerading as files
      const responseContentType = response.headers.get('content-type') || '';
      if (
        file.mimetype &&
        !file.mimetype.includes('html') &&
        responseContentType.includes('text/html')
      ) {
        logger.warn({
          event: 'file.content_type_mismatch',
          fileId: file.id,
          fileName: file.name,
          expected: file.mimetype,
          received: responseContentType,
        });
        resolved.push({ ...file, source_url: file.url, source_provider: 'slack', error: 'content_mismatch' });
        continue;
      }

      const safeName = `${file.id}-${sanitizeFilename(file.name || file.id)}`;
      const contentType = file.mimetype || response.headers.get('content-type') || 'application/octet-stream';

      // Upload via presigned URL (no AWS SDK needed in gateway)
      const key = `chat-attachments/${context.orgId}/slack:${context.accountId}/${context.channelId}/${context.messageTs}/${safeName}`;
      try {
        const uploadUrl = await context.getUploadUrl(key, contentType);
        const body = await response.arrayBuffer();
        const uploadResp = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          body,
        });
        if (!uploadResp.ok) {
          logger.warn({ event: 'file.upload_failed', fileId: file.id, status: uploadResp.status });
          resolved.push({ ...file, source_url: file.url, source_provider: 'slack', error: 'upload_failed' });
          continue;
        }
        logger.log({
          event: 'file.resolved',
          fileId: file.id,
          fileName: file.name,
          size: body.byteLength,
          contentType,
        });
      } catch (err) {
        logger.warn({ event: 'file.upload_error', fileId: file.id, error: String(err) });
        resolved.push({ ...file, source_url: file.url, source_provider: 'slack', error: 'upload_error' });
        continue;
      }

      resolved.push({
        ...file,
        url: `eve-storage://${key}`,
        source_url: file.url,
        source_provider: 'slack',
        storage_key: key,
      });
    }

    return resolved;
  }
}

const MAX_FILE_SIZE = 50 * 1024 * 1024;  // 50 MB
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100 MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
