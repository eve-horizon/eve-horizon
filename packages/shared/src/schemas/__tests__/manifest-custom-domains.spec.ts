import { describe, expect, it } from 'vitest';
import {
  ManifestSchema,
  assertUniqueManifestCustomDomainDeclarations,
  getManifestCustomDomainDeclarations,
  getManifestCustomDomainDesiredState,
  getManifestCustomDomains,
} from '../manifest.js';

function parseManifest(input: unknown) {
  return ManifestSchema.parse(input);
}

describe('manifest custom domain extraction', () => {
  it('extracts top-level custom domains', () => {
    const manifest = parseManifest({
      services: {
        web: {
          'x-eve': {
            ingress: {
              domains: ['App.Example.COM'],
            },
          },
        },
      },
    });

    expect([...getManifestCustomDomains(manifest).entries()]).toEqual([
      ['app.example.com', 'web'],
    ]);
    expect(getManifestCustomDomainDeclarations(manifest)).toEqual([
      {
        hostname: 'app.example.com',
        service_name: 'web',
        scope: 'project',
        env_name: null,
        origin_path: 'services.web.x-eve.ingress.domains',
      },
    ]);
  });

  it('extracts env override custom domains', () => {
    const manifest = parseManifest({
      services: {
        web: {
          image: 'example/web:latest',
        },
      },
      environments: {
        sandbox: {
          overrides: {
            services: {
              web: {
                'x-eve': {
                  ingress: {
                    domains: ['sandbox.example.com'],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(getManifestCustomDomainDeclarations(manifest)).toEqual([
      {
        hostname: 'sandbox.example.com',
        service_name: 'web',
        scope: 'environment',
        env_name: 'sandbox',
        origin_path: 'environments.sandbox.overrides.services.web.x-eve.ingress.domains',
      },
    ]);
  });

  it('groups top-level and env-scoped declarations into desired state', () => {
    const manifest = parseManifest({
      services: {
        web: {
          'x-eve': {
            ingress: {
              domains: ['app.example.com'],
            },
          },
        },
      },
      environments: {
        sandbox: {
          overrides: {
            services: {
              web: {
                'x-eve': {
                  ingress: {
                    domains: ['sandbox.example.com', 'app.example.com'],
                  },
                },
              },
            },
          },
        },
        prod: {
          overrides: {
            services: {
              web: {
                'x-eve': {
                  ingress: {
                    domains: ['app.example.com'],
                  },
                },
              },
            },
          },
        },
      },
    });

    const desired = getManifestCustomDomainDesiredState(manifest);
    expect(desired.get('sandbox.example.com')).toMatchObject({
      hostname: 'sandbox.example.com',
      service_name: 'web',
      env_names: ['sandbox'],
      has_project_scope: false,
    });
    expect(desired.get('app.example.com')).toMatchObject({
      hostname: 'app.example.com',
      service_name: 'web',
      env_names: ['sandbox', 'prod'],
      has_project_scope: true,
    });
  });

  it('rejects the same hostname on different services', () => {
    const manifest = parseManifest({
      services: {
        web: {
          'x-eve': {
            ingress: {
              domains: ['app.example.com'],
            },
          },
        },
        api: {
          'x-eve': {
            ingress: {
              domains: ['APP.example.com'],
            },
          },
        },
      },
    });

    expect(() => assertUniqueManifestCustomDomainDeclarations(
      getManifestCustomDomainDeclarations(manifest),
    )).toThrow('Duplicate custom domain hostnames in manifest: app.example.com');
  });

  it('allows the same hostname on the same service in multiple envs', () => {
    const manifest = parseManifest({
      services: {
        web: {},
      },
      environments: {
        sandbox: {
          overrides: {
            services: {
              web: {
                'x-eve': { ingress: { domains: ['app.example.com'] } },
              },
            },
          },
        },
        prod: {
          overrides: {
            services: {
              web: {
                'x-eve': { ingress: { domains: ['app.example.com'] } },
              },
            },
          },
        },
      },
    });

    expect(() => assertUniqueManifestCustomDomainDeclarations(
      getManifestCustomDomainDeclarations(manifest),
    )).not.toThrow();
  });
});
