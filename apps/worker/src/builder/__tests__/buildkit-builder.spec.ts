import { describe, expect, it } from 'vitest';
import { resolveBuildkitCacheRepo, shouldUseInsecureRegistryForHost } from '../buildkit-builder.js';

describe('shouldUseInsecureRegistryForHost', () => {
  it('treats in-cluster service hosts as insecure by default', () => {
    expect(shouldUseInsecureRegistryForHost('eve-registry.eve.svc:5000')).toBe(true);
    expect(
      shouldUseInsecureRegistryForHost('registry.eve-system.svc.cluster.local:5000'),
    ).toBe(true);
  });

  it('supports explicit insecure host allowlist', () => {
    expect(
      shouldUseInsecureRegistryForHost(
        'registry.example.com',
        new Set(['registry.example.com']),
      ),
    ).toBe(true);
    expect(
      shouldUseInsecureRegistryForHost(
        'registry.safe.example.com',
        new Set(['registry.example.com']),
      ),
    ).toBe(false);
  });

  it('keeps public registry hosts secure by default', () => {
    expect(shouldUseInsecureRegistryForHost('ghcr.io')).toBe(false);
    expect(shouldUseInsecureRegistryForHost('registry.example.com')).toBe(false);
  });
});

describe('resolveBuildkitCacheRepo', () => {
  const host = 'registry.eve.example.com';

  it('gives each project its own cache on the Eve registry', () => {
    expect(resolveBuildkitCacheRepo(`${host}/eve-cache:buildcache`, host, 'proj_01hshop')).toBe(
      `${host}/proj_01hshop/eve-cache:buildcache`,
    );
  });

  it('leaves caches elsewhere, and non-Eve builds, unchanged', () => {
    expect(resolveBuildkitCacheRepo('ghcr.io/acme/cache', host, 'proj_01hshop')).toBe('ghcr.io/acme/cache');
    expect(resolveBuildkitCacheRepo(`${host}/eve-cache`, host, undefined)).toBe(`${host}/eve-cache`);
    expect(resolveBuildkitCacheRepo(undefined, host, 'proj_01hshop')).toBeUndefined();
  });
});
