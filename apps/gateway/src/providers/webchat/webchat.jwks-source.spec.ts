import { createSign, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebChatGatewayProvider } from './webchat.provider.js';
import type { GatewayChatService } from '../../chat/gateway-chat.service.js';

const PLATFORM_API_URL = 'http://api.platform.test';
const SETTING_API_URL = 'http://keys.elsewhere.test';
const KID = 'eve-key';

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function keyPair() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as JsonWebKey;
  return { privateKey: pair.privateKey, jwks: { keys: [{ kty: 'RSA', kid: KID, alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e }] } };
}

const platformKeys = keyPair();
const settingKeys = keyPair();

function signToken(privateKey: ReturnType<typeof keyPair>['privateKey'], payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const body = base64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${base64url(signer.sign(privateKey))}`;
}

function userToken(privateKey: ReturnType<typeof keyPair>['privateKey']): string {
  return signToken(privateKey, {
    sub: 'user_member',
    user_id: 'user_member',
    org_id: 'org_webchat',
    type: 'user',
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

/** Open a socket and report whether the provider accepted it. */
function connect(port: number, token: string): Promise<{ accepted: boolean; closeCode?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    ws.once('message', (data) => {
      const frame = JSON.parse(String(data)) as { type?: string };
      ws.close();
      resolve({ accepted: frame.type === 'connected' });
    });
    ws.once('close', (code) => resolve({ accepted: false, closeCode: code }));
    ws.once('error', reject);
  });
}

describe('WebChat token verification keys', () => {
  const fetchMock = vi.fn();
  let provider: WebChatGatewayProvider;
  let port: number;

  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: string) => {
      const jwks = String(input).startsWith(PLATFORM_API_URL) ? platformKeys.jwks : settingKeys.jwks;
      return { ok: true, status: 200, json: async () => jwks };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('EVE_API_URL', PLATFORM_API_URL);

    provider = new WebChatGatewayProvider({} as GatewayChatService);
    await provider.initialize({
      integration: {
        id: 'int_webchat',
        org_id: 'org_webchat',
        provider: 'webchat',
        account_id: 'webchat_account',
        tokens_json: null,
        status: 'active',
      } as never,
      settings: { port: 0, eve_api_url: SETTING_API_URL },
    });
    const server = (provider as unknown as { httpServer: import('http').Server }).httpServer;
    if (!server.listening) {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    }
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await provider.shutdown();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refuses a token signed with keys served from the integration setting URL', async () => {
    const result = await connect(port, userToken(settingKeys.privateKey));

    expect(result.accepted).toBe(false);
    expect(result.closeCode).toBe(4001);
    const fetched = fetchMock.mock.calls.map(([input]) => String(input));
    expect(fetched.some((url) => url.startsWith(SETTING_API_URL))).toBe(false);
  });

  it('accepts a platform-signed token, checked against the gateway EVE_API_URL', async () => {
    const result = await connect(port, userToken(platformKeys.privateKey));

    expect(result.accepted).toBe(true);
    const fetched = fetchMock.mock.calls.map(([input]) => String(input));
    expect(fetched.every((url) => url.startsWith(PLATFORM_API_URL))).toBe(true);
  });
});
