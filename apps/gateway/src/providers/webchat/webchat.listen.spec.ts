import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import type * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebChatGatewayProvider } from './webchat.provider.js';
import type { GatewayChatService } from '../../chat/gateway-chat.service.js';

function occupyPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    // All interfaces, as the webchat listener binds.
    server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

function webchatIntegration() {
  return {
    id: 'int_webchat',
    org_id: 'org_webchat',
    provider: 'webchat',
    account_id: 'webchat_account',
    tokens_json: null,
    status: 'active',
  } as never;
}

function serverOf(provider: WebChatGatewayProvider): http.Server {
  return (provider as unknown as { httpServer: http.Server }).httpServer;
}

describe('WebChat listener port', () => {
  let occupied: { server: Server; port: number };
  let provider: WebChatGatewayProvider;
  let errorLines: string[];

  beforeEach(async () => {
    occupied = await occupyPort();
    errorLines = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('EVE_API_URL', 'http://api.platform.test');
    provider = new WebChatGatewayProvider({} as GatewayChatService);
  });

  afterEach(async () => {
    await provider.shutdown();
    await new Promise<void>((resolve) => occupied.server.close(() => resolve()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('ignores a port from the integration settings', async () => {
    vi.stubEnv('EVE_WEBCHAT_PORT', '0');

    await provider.initialize({ integration: webchatIntegration(), settings: { port: occupied.port } });

    const server = serverOf(provider);
    await vi.waitFor(() => expect(server.listening).toBe(true));
    expect((server.address() as AddressInfo).port).not.toBe(occupied.port);
  });

  it('logs a failed listen instead of failing the gateway', async () => {
    vi.stubEnv('EVE_WEBCHAT_PORT', String(occupied.port));

    await provider.initialize({ integration: webchatIntegration(), settings: { port: occupied.port } });

    await vi.waitFor(() => expect(errorLines.some((line) => line.includes('webchat.listen_failed'))).toBe(true));
    expect(serverOf(provider).listening).toBe(false);
  });
});
