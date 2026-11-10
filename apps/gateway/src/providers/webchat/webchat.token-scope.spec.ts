import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebChatToken } from './webchat.provider.js';

const API_URL = 'https://api.eve.test';
const INTEGRATION_ORG = 'org_webchat';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = keyPair.publicKey.export({ format: 'jwk' }) as JsonWebKey;

function sign(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, ...payload })).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(keyPair.privateKey).toString('base64url')}`;
}

const refused = { ok: false, closeReason: 'token_invalid' };

describe('verifyWebChatToken scope', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ keys: [{ kty: 'RSA', kid: 'test-key', alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e }] }),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['a user token bound to another org', { sub: 'user_1', type: 'user', org_id: 'org_other' }],
    [
      'a user token naming another org alongside a membership in this one',
      { sub: 'user_1', type: 'user', org_id: 'org_other', orgs: [{ id: INTEGRATION_ORG, role: 'member' }] },
    ],
    ['a user token for another org\'s member', { sub: 'user_1', type: 'user', orgs: [{ id: 'org_other', role: 'member' }] }],
    ['a job token for this org', { sub: 'user_1', user_id: 'user_1', type: 'job', org_id: INTEGRATION_ORG, job_id: 'alpha-1' }],
    ['a service token for this org', { sub: 'service:web', type: 'service', org_id: INTEGRATION_ORG }],
    ['a service principal token for this org', { sub: 'sp:sp_1', type: 'service_principal', org_id: INTEGRATION_ORG }],
  ])('refuses %s', async (_label, payload) => {
    await expect(verifyWebChatToken(sign(payload), API_URL, INTEGRATION_ORG)).resolves.toEqual(refused);
  });

  it('refuses any token when the integration org is missing', async () => {
    const token = sign({ sub: 'user_1', type: 'user', org_id: INTEGRATION_ORG });
    await expect(verifyWebChatToken(token, API_URL, '')).resolves.toEqual(refused);
  });

  it.each([
    ['bound to this org', { sub: 'user_1', type: 'user', org_id: INTEGRATION_ORG }],
    ['a member of this org', { sub: 'user_1', type: 'user', orgs: [{ id: INTEGRATION_ORG, role: 'member' }] }],
    [
      'a member of this org and others',
      { sub: 'user_1', type: 'user', orgs: [{ id: 'org_other', role: 'admin' }, { id: INTEGRATION_ORG, role: 'member' }] },
    ],
  ])('accepts a user token %s', async (_label, payload) => {
    await expect(verifyWebChatToken(sign(payload), API_URL, INTEGRATION_ORG)).resolves.toEqual({
      ok: true,
      claims: { user_id: 'user_1', org_id: INTEGRATION_ORG },
    });
  });
});
