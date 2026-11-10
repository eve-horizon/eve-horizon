import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedInbound } from '../providers/gateway-provider.interface.js';

const api = vi.hoisted(() => ({
  postJson: vi.fn(),
  getJson: vi.fn(),
}));

vi.mock('../api-client.js', () => api);

import { GatewayChatService } from './gateway-chat.service.js';

function inboundWithSenderEmail(): NormalizedInbound {
  return {
    rawType: 'app_mention',
    provider: 'api',
    accountId: 'T_TEAM',
    externalUserId: 'U_SENDER',
    channel: 'C_CHAN',
    threadId: '1700000000.000001',
    text: '',
    externalEmail: 'member@example.com',
    raw: {},
  } as NormalizedInbound;
}

function identityResolveBody(): Record<string, unknown> | undefined {
  const call = api.postJson.mock.calls.find(
    ([path]) => path === '/internal/integrations/external-identities/resolve',
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

describe('GatewayChatService sender email', () => {
  const service = new GatewayChatService();

  beforeEach(() => {
    api.postJson.mockReset();
    api.postJson.mockImplementation(async (path: string) => {
      if (path === '/internal/integrations/resolve') {
        return { integration_id: 'int_1', org_id: 'org_1' };
      }
      if (path === '/internal/integrations/external-identities/resolve') {
        return { external_identity_id: 'xid_1', eve_user_id: null, membership_request_id: null };
      }
      return {};
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ignores a sender email on the inbound message when simulate is off', async () => {
    vi.stubEnv('EVE_SIMULATE_ENABLED', 'false');

    await service.resolveAndRoute(inboundWithSenderEmail());

    const body = identityResolveBody();
    expect(body).toBeDefined();
    expect(body?.external_email).toBeUndefined();
  });

  it('passes a sender email on the inbound message when simulate is on', async () => {
    vi.stubEnv('EVE_SIMULATE_ENABLED', 'true');

    await service.resolveAndRoute(inboundWithSenderEmail());

    expect(identityResolveBody()?.external_email).toBe('member@example.com');
  });
});
