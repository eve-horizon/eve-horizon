import { describe, expect, it } from 'vitest';
import {
  IngressConfigSchema,
  assertUniqueManifestIngressAliases,
  getManifestIngressAliases,
  isReservedAlias,
} from '../../src/schemas/manifest.js';

describe('manifest ingress aliases', () => {
  it('extracts alias -> service mappings', () => {
    const manifest = {
      services: {
        web: {
          image: 'nginx:latest',
          'x-eve': {
            ingress: {
              public: true,
              alias: 'eve-pm',
            },
          },
        },
        api: {
          image: 'ghcr.io/acme/api:latest',
          x_eve: {
            ingress: {
              alias: 'eve-api',
            },
          },
        },
      },
    };

    const aliases = getManifestIngressAliases(manifest as any);
    expect(aliases.get('eve-pm')).toBe('web');
    expect(aliases.get('eve-api')).toBe('api');
  });

  it('detects duplicate aliases in one manifest', () => {
    const manifest = {
      services: {
        web: {
          image: 'nginx:latest',
          'x-eve': {
            ingress: {
              alias: 'shared-app',
            },
          },
        },
        worker: {
          image: 'ghcr.io/acme/worker:latest',
          x_eve: {
            ingress: {
              alias: 'shared-app',
            },
          },
        },
      },
    };

    const aliases = getManifestIngressAliases(manifest as any);
    expect(() => assertUniqueManifestIngressAliases(aliases)).toThrow('Duplicate ingress alias values');
  });

  it('validates alias format in ingress schema', () => {
    expect(
      IngressConfigSchema.safeParse({ alias: 'eve-pm', public: true }).success,
    ).toBe(true);
    expect(IngressConfigSchema.safeParse({ alias: 'Eve-Pm' }).success).toBe(false);
    expect(IngressConfigSchema.safeParse({ alias: '-bad' }).success).toBe(false);
    expect(IngressConfigSchema.safeParse({ alias: 'ab' }).success).toBe(false);
  });

  it('flags reserved aliases', () => {
    expect(isReservedAlias('api')).toBe(true);
    expect(isReservedAlias('eve')).toBe(true);
    expect(isReservedAlias('team-dashboard')).toBe(false);
  });
});
