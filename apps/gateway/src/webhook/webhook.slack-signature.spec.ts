import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  postJson: vi.fn(),
  getJson: vi.fn(),
}));

vi.mock('../api-client.js', () => api);

import { WebhookController } from './webhook.controller.js';
import { GatewayProviderRegistry } from '../providers/provider-registry.js';
import { SlackGatewayProvider } from '../providers/slack/slack.provider.js';
import type { GatewayChatService } from '../chat/gateway-chat.service.js';

const TEAMS = {
  T_ALPHA: { org_id: 'org_alpha', integration_id: 'int_alpha', secret: 'alpha-signing-secret' },
  T_BETA: { org_id: 'org_beta', integration_id: 'int_beta', secret: 'beta-signing-secret' },
} as const;

type TeamId = keyof typeof TEAMS;

function slackHeaders(secret: string, rawBody: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  return { 'x-slack-signature': signature, 'x-slack-request-timestamp': timestamp };
}

function jsonRequest(secret: string, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return { headers: slackHeaders(secret, rawBody), body, rawBody };
}

function formRequest(secret: string, fields: Record<string, string>) {
  const rawBody = new URLSearchParams(fields).toString();
  return { headers: slackHeaders(secret, rawBody), body: { ...fields }, rawBody };
}

function mentionEvent(teamId: string) {
  return {
    type: 'event_callback',
    team_id: teamId,
    api_app_id: 'A_APP',
    event_id: `Ev_${teamId}_${Math.random().toString(36).slice(2)}`,
    event: {
      type: 'app_mention',
      user: 'U_SENDER',
      channel: 'C_CHAN',
      ts: '1700000000.000100',
      text: '<@U_BOT> mission-control status',
    },
  };
}

function membershipApproval(teamId: string) {
  return {
    payload: JSON.stringify({
      type: 'block_actions',
      team: { id: teamId },
      user: { id: 'U_ADMIN' },
      actions: [{ action_id: 'membership_approve', value: 'mreq_123' }],
    }),
  };
}

function slashCommand(teamId: string) {
  return {
    team_id: teamId,
    user_id: 'U_SENDER',
    channel_id: 'C_CHAN',
    command: '/eve',
    text: 'mission-control status',
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('Slack request verification uses the named integration', () => {
  let registry: GatewayProviderRegistry;
  let controller: WebhookController;
  const resolveAndRoute = vi.fn();

  async function connect(teamId: TeamId): Promise<void> {
    const team = TEAMS[teamId];
    await registry.initializeOne({
      id: team.integration_id,
      org_id: team.org_id,
      provider: 'slack',
      account_id: teamId,
      tokens_json: { access_token: 'xoxb-test' },
      settings_json: { signing_secret: team.secret },
      status: 'active',
    });
  }

  beforeEach(async () => {
    vi.unstubAllEnvs();
    resolveAndRoute.mockReset();
    resolveAndRoute.mockResolvedValue({});
    api.getJson.mockReset();
    api.getJson.mockResolvedValue({ channel_id: null });
    api.postJson.mockReset();
    api.postJson.mockImplementation(async (path: string, body: Record<string, unknown>) => {
      if (path === '/internal/integrations/resolve') {
        const team = TEAMS[body.account_id as TeamId];
        if (!team) throw new Error('Integration not found');
        return { integration_id: team.integration_id, org_id: team.org_id };
      }
      return {};
    });

    registry = new GatewayProviderRegistry();
    registry.registerFactory('slack', { create: () => new SlackGatewayProvider() });
    await connect('T_ALPHA');
    await connect('T_BETA');
    controller = new WebhookController(
      registry,
      { resolveAndRoute } as unknown as GatewayChatService,
    );
  });

  function postedPaths(): string[] {
    return api.postJson.mock.calls.map(([path]) => path as string);
  }

  describe('events', () => {
    it('refuses an event naming one team that was signed with another team\'s secret', async () => {
      const req = jsonRequest(TEAMS.T_ALPHA.secret, mentionEvent('T_BETA'));

      await expect(controller.handleWebhook('slack', req)).rejects.toThrow(UnauthorizedException);
      await settle();
      expect(resolveAndRoute).not.toHaveBeenCalled();
    });

    it('refuses an event naming a team with no integration', async () => {
      const req = jsonRequest(TEAMS.T_ALPHA.secret, mentionEvent('T_UNKNOWN'));

      await expect(controller.handleWebhook('slack', req)).rejects.toThrow(UnauthorizedException);
      await settle();
      expect(resolveAndRoute).not.toHaveBeenCalled();
    });

    it.each(['T_ALPHA', 'T_BETA'] as const)(
      'accepts an event for %s signed with its own secret',
      async (teamId) => {
        const req = jsonRequest(TEAMS[teamId].secret, mentionEvent(teamId));

        await expect(controller.handleWebhook('slack', req)).resolves.toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(resolveAndRoute).toHaveBeenCalledWith(
            expect.objectContaining({ accountId: teamId }),
            registry.getInstance('slack', teamId),
          ),
        );
      },
    );

    it('answers the URL verification handshake signed with any connected app\'s secret', async () => {
      const req = jsonRequest(TEAMS.T_BETA.secret, {
        type: 'url_verification',
        token: 'legacy-token',
        challenge: 'challenge-value',
      });

      await expect(controller.handleWebhook('slack', req)).resolves.toEqual({
        challenge: 'challenge-value',
      });
    });

    it('refuses the URL verification handshake with an unknown secret', async () => {
      const req = jsonRequest('some-other-secret', {
        type: 'url_verification',
        token: 'legacy-token',
        challenge: 'challenge-value',
      });

      await expect(controller.handleWebhook('slack', req)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('interactive actions', () => {
    it('refuses an action naming one team that was signed with another team\'s secret', async () => {
      const req = formRequest(TEAMS.T_ALPHA.secret, membershipApproval('T_BETA'));

      await expect(controller.handleSlackInteractive(req)).rejects.toThrow(UnauthorizedException);
      expect(postedPaths()).not.toContain('/internal/membership-requests/mreq_123/approve');
    });

    it('refuses an action when no Slack integration is connected', async () => {
      const empty = new WebhookController(
        new GatewayProviderRegistry(),
        { resolveAndRoute } as unknown as GatewayChatService,
      );
      const req = formRequest(TEAMS.T_BETA.secret, membershipApproval('T_BETA'));

      await expect(empty.handleSlackInteractive(req)).rejects.toThrow(UnauthorizedException);
      expect(postedPaths()).not.toContain('/internal/membership-requests/mreq_123/approve');
    });

    it.each(['T_ALPHA', 'T_BETA'] as const)(
      'accepts an action for %s signed with its own secret',
      async (teamId) => {
        const req = formRequest(TEAMS[teamId].secret, membershipApproval(teamId));

        await expect(controller.handleSlackInteractive(req)).resolves.toEqual({ ok: true });
        expect(api.postJson).toHaveBeenCalledWith(
          '/internal/membership-requests/mreq_123/approve',
          expect.objectContaining({ org_id: TEAMS[teamId].org_id }),
        );
      },
    );
  });

  describe('slash commands', () => {
    it('refuses a command naming one team that was signed with another team\'s secret', async () => {
      const req = formRequest(TEAMS.T_ALPHA.secret, slashCommand('T_BETA'));

      await expect(controller.handleSlackSlash(req)).rejects.toThrow(UnauthorizedException);
      await settle();
      expect(postedPaths().some((path) => path.endsWith('/chat/route'))).toBe(false);
    });

    it('refuses a command when no Slack integration is connected', async () => {
      const empty = new WebhookController(
        new GatewayProviderRegistry(),
        { resolveAndRoute } as unknown as GatewayChatService,
      );
      const req = formRequest(TEAMS.T_BETA.secret, slashCommand('T_BETA'));

      await expect(empty.handleSlackSlash(req)).rejects.toThrow(UnauthorizedException);
      await settle();
      expect(postedPaths().some((path) => path.endsWith('/chat/route'))).toBe(false);
    });

    it.each(['T_ALPHA', 'T_BETA'] as const)(
      'accepts a command for %s signed with its own secret',
      async (teamId) => {
        const req = formRequest(TEAMS[teamId].secret, slashCommand(teamId));

        await expect(controller.handleSlackSlash(req)).resolves.toMatchObject({
          response_type: 'ephemeral',
        });
        await settle();
        expect(postedPaths()).toContain(`/internal/orgs/${TEAMS[teamId].org_id}/chat/route`);
      },
    );
  });
});
