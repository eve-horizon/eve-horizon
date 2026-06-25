import { describe, test, expect } from 'vitest';
import {
  ManifestSchema,
  isEveRegistry,
  isRegistryNone,
  getRegistryConfig,
  type Manifest,
} from '../../src/schemas/manifest.js';

// --- isEveRegistry ---

describe('isEveRegistry', () => {
  test('returns true when registry is "eve"', () => {
    const manifest: Manifest = { registry: 'eve' };
    expect(isEveRegistry(manifest)).toBe(true);
  });

  test('returns false when registry is "none"', () => {
    const manifest: Manifest = { registry: 'none' };
    expect(isEveRegistry(manifest)).toBe(false);
  });

  test('returns false when registry is an object (BYO)', () => {
    const manifest: Manifest = { registry: { host: 'ghcr.io' } };
    expect(isEveRegistry(manifest)).toBe(false);
  });

  test('returns false when registry is undefined', () => {
    const manifest: Manifest = {};
    expect(isEveRegistry(manifest)).toBe(false);
  });
});

// --- isRegistryNone ---

describe('isRegistryNone', () => {
  test('returns true when registry is "none"', () => {
    const manifest: Manifest = { registry: 'none' };
    expect(isRegistryNone(manifest)).toBe(true);
  });

  test('returns false when registry is "eve"', () => {
    const manifest: Manifest = { registry: 'eve' };
    expect(isRegistryNone(manifest)).toBe(false);
  });

  test('returns false when registry is an object', () => {
    const manifest: Manifest = { registry: { host: 'ghcr.io' } };
    expect(isRegistryNone(manifest)).toBe(false);
  });

  test('returns false when registry is undefined', () => {
    const manifest: Manifest = {};
    expect(isRegistryNone(manifest)).toBe(false);
  });
});

// --- getRegistryConfig ---

describe('getRegistryConfig', () => {
  test('returns null when registry is "eve"', () => {
    const manifest: Manifest = { registry: 'eve' };
    expect(getRegistryConfig(manifest)).toBeNull();
  });

  test('returns null when registry is "none"', () => {
    const manifest: Manifest = { registry: 'none' };
    expect(getRegistryConfig(manifest)).toBeNull();
  });

  test('returns null when registry is undefined', () => {
    const manifest: Manifest = {};
    expect(getRegistryConfig(manifest)).toBeNull();
  });

  test('returns config object when registry has a host', () => {
    const manifest: Manifest = {
      registry: { host: 'ghcr.io', namespace: 'acme' },
    };
    const config = getRegistryConfig(manifest);
    expect(config).toEqual({
      host: 'ghcr.io',
      namespace: 'acme',
      auth: undefined,
    });
  });

  test('returns config with auth when registry includes auth credentials', () => {
    const manifest: Manifest = {
      registry: {
        host: 'ghcr.io',
        auth: { username_secret: 'USER', token_secret: 'TOKEN' },
      },
    };
    const config = getRegistryConfig(manifest);
    expect(config).toEqual({
      host: 'ghcr.io',
      namespace: undefined,
      auth: { username_secret: 'USER', token_secret: 'TOKEN' },
    });
  });

  test('returns null when registry is an empty object (no host)', () => {
    const manifest: Manifest = { registry: {} };
    expect(getRegistryConfig(manifest)).toBeNull();
  });
});

// --- ManifestSchema validation ---

describe('ManifestSchema registry validation', () => {
  test('accepts registry: "eve"', () => {
    const result = ManifestSchema.parse({ registry: 'eve' });
    expect(result.registry).toBe('eve');
  });

  test('accepts registry: "none"', () => {
    const result = ManifestSchema.parse({ registry: 'none' });
    expect(result.registry).toBe('none');
  });

  test('accepts registry as an object with host', () => {
    const result = ManifestSchema.parse({ registry: { host: 'ghcr.io' } });
    expect(result.registry).toEqual({ host: 'ghcr.io' });
  });

  test('accepts manifest with no registry field', () => {
    const result = ManifestSchema.parse({ project: 'my-app' });
    expect(result.registry).toBeUndefined();
  });

  test('rejects registry with an invalid string literal', () => {
    expect(() => ManifestSchema.parse({ registry: 'docker' })).toThrow();
  });
});
