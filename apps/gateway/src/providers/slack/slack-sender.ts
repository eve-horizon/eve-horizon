import { postJson } from '../../api-client.js';
import { createJsonLogger } from '@eve/shared';

const logger = createJsonLogger('gateway');

/**
 * Slack API message sending utilities.
 *
 * Sends messages via Slack's chat.postMessage API. Fetches the integration's
 * OAuth token from the Eve API to authenticate with Slack.
 */

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/** Extract the Slack bot/access token from integration tokens_json. */
export function extractSlackToken(tokens: Record<string, unknown> | null): string | null {
  if (!tokens || typeof tokens !== 'object') {
    return null;
  }
  const accessToken = tokens['access_token'];
  if (typeof accessToken === 'string' && accessToken.length > 0) {
    return accessToken;
  }
  const botToken = tokens['bot_token'];
  if (typeof botToken === 'string' && botToken.length > 0) {
    return botToken;
  }
  return null;
}

/** Extract the Slack bot user ID from integration tokens_json. */
export function extractSlackBotUserId(tokens: Record<string, unknown> | null): string | null {
  if (!tokens || typeof tokens !== 'object') {
    return null;
  }
  const botUserId = tokens['bot_user_id'];
  if (typeof botUserId === 'string' && botUserId.length > 0) {
    return botUserId;
  }
  const botUser = tokens['bot_user'];
  if (botUser && typeof botUser === 'object') {
    const id = (botUser as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Token fetching
// ---------------------------------------------------------------------------

/** Fetch integration tokens from the Eve API. */
export async function getIntegrationTokens(integrationId: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await postJson<{ tokens_json: Record<string, unknown> | null }>(
      '/internal/integrations/tokens',
      { integration_id: integrationId },
    );
    return response.tokens_json ?? null;
  } catch (err) {
    logger.warn({
      event: 'slack.tokens.fetch_failed',
      integrationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message sending
// ---------------------------------------------------------------------------

export interface SlackReplyOptions {
  token: string;
  channelId: string;
  text: string;
  threadTs?: string;
  blocks?: unknown[];
}

export interface SlackSendResult {
  ok: boolean;
  error?: string;
  httpStatus?: number;
}

const MAX_RETRIES = 2;

/**
 * Send a reply to a Slack channel via chat.postMessage.
 *
 * Returns a structured result instead of swallowing errors. The caller
 * decides whether to log or ignore failures.
 *
 * Handles HTTP 429 (rate limited) by reading `Retry-After` and retrying
 * up to MAX_RETRIES times with the specified delay.
 */
export async function sendSlackMessage(options: SlackReplyOptions): Promise<SlackSendResult> {
  const body: Record<string, unknown> = {
    channel: options.channelId,
    text: options.text,
    thread_ts: options.threadTs,
  };
  if (options.blocks && options.blocks.length > 0) {
    body.blocks = options.blocks;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });

      // Rate limited — wait and retry
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(response.headers.get('retry-after') ?? '1', 10);
        const delayMs = Math.min(retryAfter * 1000, 30_000);
        logger.warn({
          event: 'slack.outbound.rate_limited',
          channel: options.channelId,
          retryAfterSec: retryAfter,
          attempt,
        });
        await sleep(delayMs);
        continue;
      }

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok === false) {
        return {
          ok: false,
          httpStatus: response.status,
          error: payload?.error ?? 'unknown',
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { ok: false, error: 'rate_limited_exhausted' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
