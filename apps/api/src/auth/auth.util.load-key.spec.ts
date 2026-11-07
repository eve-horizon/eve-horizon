import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterAll, describe, expect, it } from 'vitest';
import { createJwtRs256, loadKeyRing, loadKeyValue, verifyJwtRs256 } from './auth.util.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

const escaped = (pem: string) => pem.trimEnd().replace(/\n/g, '\\n');
const base64 = (pem: string) => Buffer.from(pem).toString('base64');

const dir = mkdtempSync(join(tmpdir(), 'eve-pem-'));
const keyFile = join(dir, 'auth.key');
writeFileSync(keyFile, privatePem);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function samePrivateKey(loaded: string | undefined): boolean {
  return createPrivateKey(loaded!).export({ format: 'pem', type: 'pkcs8' }).toString() === privatePem;
}

describe('loadKeyValue', () => {
  it.each([
    ['a PEM with real newlines', privatePem],
    ['a PEM flattened with \\n escapes (env file)', escaped(privatePem)],
    ['a PEM flattened with \\r\\n escapes', privatePem.trimEnd().replace(/\n/g, '\\r\\n')],
    ['a double-quoted escaped PEM', `"${escaped(privatePem)}"`],
    ["a single-quoted escaped PEM", `'${escaped(privatePem)}'`],
    ['a base64-encoded PEM', base64(privatePem)],
    ['a base64-encoded PEM wrapped at 76 columns', base64(privatePem).replace(/(.{76})/g, '$1\n')],
    ['a base64url-encoded PEM', Buffer.from(privatePem).toString('base64url')],
    ['a base64-encoded escaped PEM', base64(escaped(privatePem))],
    ['a key file path', keyFile],
    ['a padded, quoted key file path', `  "${keyFile}"  `],
  ])('reads %s', (_label, value) => {
    expect(samePrivateKey(loadKeyValue(value))).toBe(true);
  });

  it('reads public keys in the same forms', () => {
    for (const value of [publicPem, escaped(publicPem), base64(publicPem)]) {
      expect(createPublicKey(loadKeyValue(value)!).export({ format: 'pem', type: 'spki' }).toString()).toBe(publicPem);
    }
  });

  it('returns undefined for unset or blank values', () => {
    expect(loadKeyValue(undefined)).toBeUndefined();
    expect(loadKeyValue('')).toBeUndefined();
    expect(loadKeyValue('  ""  ')).toBeUndefined();
  });

  it.each([
    ['a missing file path', join(dir, 'missing.key')],
    ['a bare word', 'notakey'],
    ['base64 that is not a PEM', Buffer.from('hello world, not a key').toString('base64')],
  ])('names the variable when given %s', (_label, value) => {
    expect(() => loadKeyValue(value, 'EVE_AUTH_PRIVATE_KEY')).toThrow(
      'EVE_AUTH_PRIVATE_KEY is not a PEM key, a readable key file path, or a base64-encoded PEM key',
    );
  });
});

describe('loadKeyRing with env-file friendly keys', () => {
  it('signs and verifies tokens with an escaped private key and a base64 public key', () => {
    const keys = loadKeyRing({
      EVE_AUTH_PRIVATE_KEY: escaped(privatePem),
      EVE_AUTH_PUBLIC_KEY: base64(publicPem),
      EVE_AUTH_KEY_ID: 'kid-1',
    } as never);

    expect(keys).toHaveLength(1);
    const token = createJwtRs256({ sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 60 }, keys[0]);
    expect(verifyJwtRs256(token, keys).sub).toBe('user_1');
  });
});
