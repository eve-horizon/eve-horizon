import 'reflect-metadata';
import { createHmac } from 'crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayHttpApp } from './http-app.js';
import { GatewayProviderRegistry } from './providers/provider-registry.js';
import { GatewayChatService } from './chat/gateway-chat.service.js';
import { WebhookController } from './webhook/webhook.controller.js';
import { DeliveryController } from './delivery/delivery.controller.js';

// The build (tsc) emits constructor parameter types for Nest's injector;
// vitest's transform does not, so supply them for the module's controllers.
Reflect.defineMetadata('design:paramtypes', [GatewayProviderRegistry, GatewayChatService], WebhookController);
Reflect.defineMetadata('design:paramtypes', [GatewayProviderRegistry], DeliveryController);

const API_URL = 'http://api.internal.test';
const TEAM_ID = 'T_WORKSPACE';
const ORG_ID = 'org_workspace';
const SIGNING_SECRET = 'workspace-signing-secret';

/** Every request the gateway sends to the API, as a parsed URL. */
const sent: URL[] = [];

function recordingFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  sent.push(url);
  const body = url.pathname === '/internal/integrations/resolve'
    ? { integration_id: 'int_workspace', org_id: ORG_ID }
    : {};
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

function signedForm(fields: Record<string, string>) {
  const rawBody = new URLSearchParams(fields).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`;
  return {
    payload: rawBody,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp,
    },
  };
}

function buttonPress(actionId: string, value: string) {
  return signedForm({
    payload: JSON.stringify({
      type: 'block_actions',
      team: { id: TEAM_ID },
      user: { id: 'U_ADMIN' },
      actions: [{ action_id: actionId, value }],
    }),
  });
}

describe('Slack interactive actions through the HTTP stack', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
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
    sent.length = 0;
    vi.stubGlobal('fetch', vi.fn(recordingFetch));
    vi.stubEnv('EVE_API_URL', API_URL);
    vi.stubEnv('EVE_INTERNAL_API_KEY', 'internal-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function press(actionId: string, value: string) {
    const { payload, headers } = buttonPress(actionId, value);
    return app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/gateway/providers/slack/interactive',
      headers,
      payload,
    });
  }

  it.each([
    ['dot segments', '../../projects/proj_other/workflows/deploy/invoke?x='],
    ['encoded dot segments', '%2e%2e/%2e%2e/projects/proj_other/workflows/deploy/invoke?x='],
  ])('sends no API request for a button value with %s', async (_label, value) => {
    for (const actionId of ['membership_approve', 'membership_deny']) {
      const res = await press(actionId, value);
      expect(res.statusCode).toBe(200);
    }
    expect(sent.map((url) => url.pathname + url.search)).toEqual([]);
  });

  it('acknowledges a membership button with a well-formed id without an API request', async () => {
    const res = await press('membership_approve', 'mreq_01h2xcejqtf2nbrexx3vqjhp41');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(sent).toEqual([]);
  });
});
