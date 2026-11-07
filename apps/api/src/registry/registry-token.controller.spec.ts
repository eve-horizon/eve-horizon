import { createPrivateKey, generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  computeRfc7638ThumbprintFromPrivateKey,
  parseScopes,
  RegistryTokenController,
} from './registry-token.controller.js';

describe('registry signing key formats', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  // An internal caller never queries the database, so no DB client is needed.
  const internalCaller = { kind: 'internal' } as const;
  const noDb = (() => {
    throw new Error('internal callers must not query the database');
  }) as any;

  it.each([
    ['PEM', pem],
    ['\\n-escaped PEM', pem.trimEnd().replace(/\n/g, '\\n')],
    ['base64-encoded PEM', Buffer.from(pem).toString('base64')],
  ])('issues a token signed with a %s', async (_label, value) => {
    const controller = new RegistryTokenController(noDb);
    const response = await (controller as any).buildScopedToken(
      { EVE_REGISTRY_SIGNING_KEY: value },
      internalCaller,
      'repository:my-app:pull',
      'eve-registry',
    );
    const [header] = response.token.split('.');
    const { kid } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    expect(kid).toBe(computeRfc7638ThumbprintFromPrivateKey(createPrivateKey(pem)));
  });

  it('names the variable when the key cannot be read', async () => {
    const controller = new RegistryTokenController(noDb);
    await expect((controller as any).buildScopedToken(
      { EVE_REGISTRY_SIGNING_KEY: 'not-a-key' },
      internalCaller,
      'repository:my-app:pull',
      'eve-registry',
    )).rejects.toThrow(/EVE_REGISTRY_SIGNING_KEY is not a PEM key/);
  });
});

describe('registry token thumbprint', () => {
  it('computes a stable RFC7638 thumbprint for RSA signing keys', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const key = createPrivateKey(pem);

    const first = computeRfc7638ThumbprintFromPrivateKey(key);
    const second = computeRfc7638ThumbprintFromPrivateKey(key);

    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects non-RSA signing keys', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const key = createPrivateKey(pem);

    expect(() => computeRfc7638ThumbprintFromPrivateKey(key)).toThrow(
      /RSA/,
    );
  });
});

describe('parseScopes', () => {
  it('parses a single scope string', () => {
    const result = parseScopes('repository:my-app:pull,push');
    expect(result).toEqual([
      { type: 'repository', name: 'my-app', actions: ['pull', 'push'] },
    ]);
  });

  it('parses multiple scope strings (cross-repo blob mount)', () => {
    const result = parseScopes([
      'repository:bhiblee-web:pull,push',
      'repository:eve-horizon-showcase:pull',
    ]);
    expect(result).toEqual([
      { type: 'repository', name: 'bhiblee-web', actions: ['pull', 'push'] },
      { type: 'repository', name: 'eve-horizon-showcase', actions: ['pull'] },
    ]);
  });

  it('handles scope names with colons', () => {
    const result = parseScopes('repository:org/project:name:pull');
    expect(result).toEqual([
      { type: 'repository', name: 'org/project:name', actions: ['pull'] },
    ]);
  });

  it('handles registry catalog scope', () => {
    const result = parseScopes('registry:catalog:*');
    expect(result).toEqual([
      { type: 'registry', name: 'catalog', actions: ['*'] },
    ]);
  });

  it('wraps a single string in an array transparently', () => {
    const single = parseScopes('repository:foo:pull');
    const array = parseScopes(['repository:foo:pull']);
    expect(single).toEqual(array);
  });

  it('throws on invalid scope format', () => {
    expect(() => parseScopes('invalid')).toThrow(/Invalid scope format/);
    expect(() => parseScopes('only:two')).toThrow(/Invalid scope format/);
  });
});
