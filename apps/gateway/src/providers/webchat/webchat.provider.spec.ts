import { generateKeyPairSync, createSign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebChatToken } from './webchat.provider.js';

const eveApiUrl = 'https://api.eve.test';

function base64url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(
  payload: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  header: Record<string, unknown> = {},
): string {
  const encodedHeader = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key', ...header }));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${encodedHeader}.${encodedPayload}`);
  const signature = signer.sign(privateKey);
  return `${encodedHeader}.${encodedPayload}.${base64url(signature)}`;
}

describe('verifyWebChatToken', () => {
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = keyPair.publicKey.export({ format: 'jwk' }) as JsonWebKey;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        keys: [
          {
            kty: 'RSA',
            kid: 'test-key',
            alg: 'RS256',
            use: 'sig',
            n: publicJwk.n,
            e: publicJwk.e,
          },
        ],
      }),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a valid RS256 Eve user token', async () => {
    const token = signJwt(
      {
        sub: 'usr_123',
        org_id: 'org_123',
        type: 'user',
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      keyPair.privateKey,
    );

    await expect(verifyWebChatToken(token, eveApiUrl)).resolves.toEqual({
      ok: true,
      claims: { user_id: 'usr_123', org_id: 'org_123' },
    });
  });

  it('accepts normal user tokens with org membership claims', async () => {
    const token = signJwt(
      {
        sub: 'usr_123',
        orgs: [{ id: 'org_123', role: 'admin' }],
        type: 'user',
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      keyPair.privateKey,
    );

    await expect(verifyWebChatToken(token, eveApiUrl, 'org_123')).resolves.toEqual({
      ok: true,
      claims: { user_id: 'usr_123', org_id: 'org_123' },
    });
  });

  it('rejects expired tokens with an explicit close reason', async () => {
    const token = signJwt(
      {
        sub: 'usr_123',
        org_id: 'org_123',
        type: 'user',
        exp: Math.floor(Date.now() / 1000) - 10,
      },
      keyPair.privateKey,
    );

    await expect(verifyWebChatToken(token, eveApiUrl)).resolves.toEqual({
      ok: false,
      closeReason: 'token_expired',
    });
  });

  it('rejects HS256 tokens instead of trusting decoded payloads', async () => {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'test-key' }));
    const payload = base64url(JSON.stringify({
      sub: 'usr_123',
      org_id: 'org_123',
      type: 'user',
      exp: Math.floor(Date.now() / 1000) + 300,
    }));
    const token = `${header}.${payload}.${base64url('fake-signature')}`;

    await expect(verifyWebChatToken(token, eveApiUrl)).resolves.toEqual({
      ok: false,
      closeReason: 'token_invalid',
    });
  });

  it('rejects tampered payloads with the original signature', async () => {
    const token = signJwt(
      {
        sub: 'usr_123',
        org_id: 'org_123',
        type: 'user',
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      keyPair.privateKey,
    );
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const originalPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const tamperedPayload = base64url(JSON.stringify({
      ...originalPayload,
      org_id: 'org_999',
    }));

    await expect(verifyWebChatToken(`${header}.${tamperedPayload}.${signature}`, eveApiUrl)).resolves.toEqual({
      ok: false,
      closeReason: 'token_invalid',
    });
  });
});
