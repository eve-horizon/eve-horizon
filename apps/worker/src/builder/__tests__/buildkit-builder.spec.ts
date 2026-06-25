import { describe, expect, it } from 'vitest';
import { shouldUseInsecureRegistryForHost } from '../buildkit-builder.js';

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
