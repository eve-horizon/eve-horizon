import { describe, expect, it } from 'vitest';
import {
  ManifestSchema,
  requiresTcpIngress,
  resolveTcpIngressConfig,
} from '../manifest.js';

describe('manifest TCP ingress', () => {
  it('validates service tcp_ingress listener declarations', () => {
    const parsed = ManifestSchema.parse({
      services: {
        'device-edge': {
          image: 'ghcr.io/example/device-edge:latest',
          ports: ['33334', '33400'],
          'x-eve': {
            tcp_ingress: {
              hostname: 'trackers',
              allow_cidrs: ['0.0.0.0/0'],
              listeners: [
                { name: 'bd-starlink', port: 33334 },
                { name: 'a1-gt06', port: 33400 },
              ],
            },
          },
        },
      },
    });

    const service = parsed.services?.['device-edge'];
    expect(service).toBeDefined();
    expect(requiresTcpIngress(service!)).toBe(true);
    expect(resolveTcpIngressConfig(service!)).toEqual({
      hostname: 'trackers',
      allow_cidrs: ['0.0.0.0/0'],
      listeners: [
        { name: 'bd-starlink', port: 33334 },
        { name: 'a1-gt06', port: 33400 },
      ],
    });
  });

  it('rejects unknown tcp_ingress fields', () => {
    expect(() => ManifestSchema.parse({
      services: {
        api: {
          image: 'api:latest',
          ports: ['33334'],
          'x-eve': {
            tcp_ingress: {
              listeners: [{ name: 'raw', port: 33334 }],
              typo: true,
            },
          },
        },
      },
    })).toThrow();
  });

  it('rejects unknown listener fields and malformed listener names', () => {
    expect(() => ManifestSchema.parse({
      services: {
        api: {
          image: 'api:latest',
          ports: ['33334'],
          'x-eve': {
            tcp_ingress: {
              listeners: [{ name: 'Bad_Name', port: 33334, extra: 'nope' }],
            },
          },
        },
      },
    })).toThrow();
  });
});
