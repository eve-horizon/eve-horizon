import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Db } from '@eve/db';
import type { NotificationSendRequest, NotificationSendResponse } from '@eve/shared';

type ProjectRow = { id: string; org_id: string };

type SlackIntegrationRow = {
  id: string;
  org_id: string;
  account_id: string;
  tokens_json: Record<string, unknown> | null;
};

type SlackConversation = {
  id?: string;
  name?: string;
  is_archived?: boolean;
};

type SlackListResponse = {
  ok?: boolean;
  error?: string;
  channels?: SlackConversation[];
  response_metadata?: { next_cursor?: string };
};

type SlackPostResponse = {
  ok?: boolean;
  error?: string;
  channel?: string;
  ts?: string;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@Inject('DB') private readonly db: Db) {}

  async sendForProject(
    projectInput: string,
    request: NotificationSendRequest,
    options: { callerProjectId?: string } = {},
  ): Promise<NotificationSendResponse> {
    const project = await this.resolveProject(projectInput);
    if (options.callerProjectId && options.callerProjectId !== project.id) {
      throw new ForbiddenException('Job token cannot send notifications for a different project');
    }

    const integration = await this.resolveSlackIntegration(project.org_id, request.integration_id);
    const token = extractSlackToken(integration.tokens_json);
    if (!token) {
      throw new BadRequestException(`Slack integration ${integration.id} has no bot token`);
    }

    const channelId = await this.resolveSlackChannelId(token, request.channel);
    const result = await postSlackMessage(token, {
      channelId,
      text: request.message,
      threadTs: request.thread_id,
    });

    if (!result.ok) {
      throw new BadRequestException(`Slack notification failed: ${result.error ?? 'unknown'}`);
    }

    this.logger.log(`Notification delivered to Slack channel ${channelId} for project ${project.id}`);
    return {
      delivered: true,
      provider: 'slack',
      integration_id: integration.id,
      channel: request.channel,
      channel_id: result.channel ?? channelId,
      ...(result.ts ? { message_ts: result.ts } : {}),
    };
  }

  private async resolveProject(projectInput: string): Promise<ProjectRow> {
    const rows = projectInput.startsWith('proj_')
      ? await this.db<ProjectRow[]>`
          SELECT id, org_id
          FROM projects
          WHERE id = ${projectInput} AND deleted_at IS NULL
          LIMIT 1
        `
      : await this.db<ProjectRow[]>`
          SELECT id, org_id
          FROM projects
          WHERE slug = ${projectInput} AND deleted_at IS NULL
          LIMIT 1
        `;

    const project = rows[0];
    if (!project) {
      throw new NotFoundException(`Project ${projectInput} not found`);
    }
    return project;
  }

  private async resolveSlackIntegration(
    orgId: string,
    integrationId?: string,
  ): Promise<SlackIntegrationRow> {
    if (integrationId) {
      const rows = await this.db<SlackIntegrationRow[]>`
        SELECT id, org_id, account_id, tokens_json
        FROM integrations
        WHERE id = ${integrationId}
          AND org_id = ${orgId}
          AND provider = 'slack'
          AND status = 'active'
        LIMIT 1
      `;
      const integration = rows[0];
      if (!integration) {
        throw new NotFoundException(`Active Slack integration ${integrationId} not found for org ${orgId}`);
      }
      return integration;
    }

    const rows = await this.db<SlackIntegrationRow[]>`
      SELECT id, org_id, account_id, tokens_json
      FROM integrations
      WHERE org_id = ${orgId}
        AND provider = 'slack'
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 2
    `;

    if (rows.length === 0) {
      throw new NotFoundException(`No active Slack integration found for org ${orgId}`);
    }
    if (rows.length > 1) {
      throw new BadRequestException(
        'Multiple active Slack integrations found for this org; pass integration_id explicitly',
      );
    }
    return rows[0];
  }

  private async resolveSlackChannelId(token: string, channel: string): Promise<string> {
    const trimmed = channel.trim();
    if (/^[CGD][A-Z0-9]+$/.test(trimmed)) {
      return trimmed;
    }

    const wanted = trimmed.replace(/^#/, '');
    if (!wanted) {
      throw new BadRequestException('Slack channel must be a channel ID or channel name');
    }

    let cursor: string | undefined;
    do {
      const url = new URL('https://slack.com/api/conversations.list');
      url.searchParams.set('types', 'public_channel,private_channel');
      url.searchParams.set('exclude_archived', 'true');
      url.searchParams.set('limit', '1000');
      if (cursor) url.searchParams.set('cursor', cursor);

      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => null) as SlackListResponse | null;
      if (!response.ok || !payload?.ok) {
        throw new BadRequestException(
          `Slack channel lookup failed: ${payload?.error ?? `http_${response.status}`}`,
        );
      }

      const match = (payload.channels ?? []).find((c) => c.name === wanted && !c.is_archived);
      if (match?.id) {
        return match.id;
      }

      cursor = payload.response_metadata?.next_cursor || undefined;
    } while (cursor);

    throw new NotFoundException(`Slack channel "${channel}" not found`);
  }
}

function extractSlackToken(tokens: Record<string, unknown> | null): string | null {
  if (!tokens || typeof tokens !== 'object') return null;
  const accessToken = tokens.access_token;
  if (typeof accessToken === 'string' && accessToken.length > 0) return accessToken;
  const botToken = tokens.bot_token;
  if (typeof botToken === 'string' && botToken.length > 0) return botToken;
  return null;
}

async function postSlackMessage(
  token: string,
  options: { channelId: string; text: string; threadTs?: string },
): Promise<{ ok: boolean; error?: string; channel?: string; ts?: string }> {
  const body: Record<string, unknown> = {
    channel: options.channelId,
    text: options.text,
  };
  if (options.threadTs) body.thread_ts = options.threadTs;

  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '1', 10);
      await sleep(Math.min(retryAfter * 1000, 30_000));
      continue;
    }

    const payload = await response.json().catch(() => null) as SlackPostResponse | null;
    if (!response.ok || !payload?.ok) {
      return { ok: false, error: payload?.error ?? `http_${response.status}` };
    }
    return { ok: true, channel: payload.channel, ts: payload.ts };
  }

  return { ok: false, error: 'rate_limited_exhausted' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
