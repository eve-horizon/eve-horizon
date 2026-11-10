import 'reflect-metadata';
import { createHmac } from 'crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  postJson: vi.fn(),
  getJson: vi.fn(),
}));

vi.mock('./api-client.js', () => api);

import { createGatewayHttpApp } from './http-app.js';
import { GatewayProviderRegistry } from './providers/provider-registry.js';
import { GatewayChatService } from './chat/gateway-chat.service.js';
import { WebhookController } from './webhook/webhook.controller.js';
import { DeliveryController } from './delivery/delivery.controller.js';

// The build (tsc) emits constructor parameter types for Nest's injector;
// vitest's transform does not, so supply them for the module's controllers.
Reflect.defineMetadata('design:paramtypes', [GatewayProviderRegistry, GatewayChatService], WebhookController);
Reflect.defineMetadata('design:paramtypes', [GatewayProviderRegistry], DeliveryController);

const TEAM_ID = 'T_WORKSPACE';
const ORG_ID = 'org_workspace';
const SIGNING_SECRET = 'workspace-signing-secret';

function signedHeaders(rawBody: string, contentType: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`;
  return {
    'content-type': contentType,
    'x-slack-signature': signature,
    'x-slack-request-timestamp': timestamp,
  };
}

describe('gateway HTTP stack accepts signed Slack requests', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // The same HTTP app main.ts serves.
    app = await createGatewayHttpApp(false);
    await app.get(GatewayProviderRegistry).initializeOne({
      id: 'int_workspace',
      org_id: ORG_ID,
      provider: 'slack',
      account_id: TEAM_ID,
      tokens_json: { access_token: 'xoxb-test' },
      settings_json: { signing_secret: SIGNING_SECRET },
      status: 'active',
    });
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    api.getJson.mockReset();
    api.getJson.mockResolvedValue({ channel_id: null });
    api.postJson.mockReset();
    api.postJson.mockImplementation(async (path: string) => {
      if (path === '/internal/integrations/resolve') {
        return { integration_id: 'int_workspace', org_id: ORG_ID };
      }
      return {};
    });
  });

  function inject(url: string, rawBody: string, contentType: string) {
    return app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url,
      headers: signedHeaders(rawBody, contentType),
      payload: rawBody,
    });
  }

  it('accepts a JSON event', async () => {
    const rawBody = JSON.stringify({
      type: 'event_callback',
      team_id: TEAM_ID,
      api_app_id: 'A_APP',
      event_id: 'Ev_http_json',
      event: {
        type: 'app_mention',
        user: 'U_SENDER',
        channel: 'C_CHAN',
        ts: '1700000000.000100',
        text: '<@U_BOT> mission-control status',
      },
    });

    const res = await inject('/gateway/providers/slack/webhook', rawBody, 'application/json');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('accepts a form-encoded slash command', async () => {
    const rawBody = new URLSearchParams({
      team_id: TEAM_ID,
      user_id: 'U_SENDER',
      channel_id: 'C_CHAN',
      command: '/eve',
      text: 'mission-control status',
    }).toString();

    const res = await inject(
      '/gateway/providers/slack/slash',
      rawBody,
      'application/x-www-form-urlencoded',
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ response_type: 'ephemeral' });
  });

  it('accepts a form-encoded interactive payload', async () => {
    const rawBody = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: TEAM_ID },
        user: { id: 'U_ADMIN' },
        actions: [{ action_id: 'membership_approve', value: 'mreq_http' }],
      }),
    }).toString();

    const res = await inject(
      '/gateway/providers/slack/interactive',
      rawBody,
      'application/x-www-form-urlencoded',
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(api.postJson).toHaveBeenCalledWith(
      '/internal/membership-requests/mreq_http/approve',
      expect.objectContaining({ org_id: ORG_ID }),
    );
  });
});
