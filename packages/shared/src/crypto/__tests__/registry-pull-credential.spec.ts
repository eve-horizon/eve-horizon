import { describe, expect, it } from 'vitest';
import {
  mintRegistryPullCredential,
  verifyRegistryPullCredential,
} from '../registry-pull-credential.ts';

const KEY = 'internal-key';
const CLAIMS = { projectId: 'proj_abc', environmentId: 'env_test', namespace: 'eve-acme-shop-test', epoch: 3 };

describe('registry pull credential', () => {
  it('round-trips its claims under the same key', () => {
    const credential = mintRegistryPullCredential(CLAIMS, KEY);
    expect(credential.startsWith('evepull1.')).toBe(true);
    expect(verifyRegistryPullCredential(credential, KEY)).toEqual(CLAIMS);
  });

  it('never contains the internal key', () => {
    const credential = mintRegistryPullCredential(CLAIMS, KEY);
    expect(credential).not.toContain(KEY);
    expect(Buffer.from(credential.split('.')[1], 'base64url').toString('utf8')).not.toContain(KEY);
  });

  it('is rejected under a different (rotated) key', () => {
    const credential = mintRegistryPullCredential(CLAIMS, KEY);
    expect(verifyRegistryPullCredential(credential, 'rotated-key')).toBeNull();
  });

  it('is rejected when the claims are altered', () => {
    const [prefix, , mac] = mintRegistryPullCredential(CLAIMS, KEY).split('.');
    const forged = Buffer.from(
      JSON.stringify({ p: 'proj_other', e: CLAIMS.environmentId, ns: CLAIMS.namespace, n: CLAIMS.epoch }),
    ).toString('base64url');
    expect(verifyRegistryPullCredential(`${prefix}.${forged}.${mac}`, KEY)).toBeNull();
  });

  it('rejects the internal key itself and other non-credentials', () => {
    expect(verifyRegistryPullCredential(KEY, KEY)).toBeNull();
    expect(verifyRegistryPullCredential('', KEY)).toBeNull();
    expect(verifyRegistryPullCredential(undefined, KEY)).toBeNull();
    expect(verifyRegistryPullCredential('evepull1..', KEY)).toBeNull();
    expect(verifyRegistryPullCredential('evepull2.e30.AAAA', KEY)).toBeNull();
  });

  it('fails closed without a key', () => {
    const credential = mintRegistryPullCredential(CLAIMS, KEY);
    expect(verifyRegistryPullCredential(credential, undefined)).toBeNull();
    expect(verifyRegistryPullCredential(credential, '')).toBeNull();
    expect(() => mintRegistryPullCredential(CLAIMS, undefined)).toThrow(/EVE_INTERNAL_API_KEY/);
  });

  it('requires a project, an environment, a namespace and an epoch', () => {
    expect(() => mintRegistryPullCredential({ ...CLAIMS, projectId: '' }, KEY)).toThrow();
    expect(() => mintRegistryPullCredential({ ...CLAIMS, environmentId: '' }, KEY)).toThrow();
    expect(() => mintRegistryPullCredential({ ...CLAIMS, namespace: '' }, KEY)).toThrow();
    expect(() => mintRegistryPullCredential({ ...CLAIMS, epoch: -1 }, KEY)).toThrow();
    expect(() => mintRegistryPullCredential({ ...CLAIMS, epoch: 1.5 }, KEY)).toThrow();
  });
});
