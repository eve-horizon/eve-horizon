import { describe, expect, it } from 'vitest';
import {
  ManifestSchema,
  getManifestAppLinks,
} from '../manifest.js';

describe('Manifest app_links schema', () => {
  it('accepts producer exports and consumer subscriptions', () => {
    const parsed = ManifestSchema.parse({
      services: {
        api: {
          image: 'example/api:latest',
          'x-eve': {
            api_spec: { spec_path: '/openapi.json' },
            cli: { name: 'obs', bin: '/usr/local/bin/obs', image: 'example/obs-cli:latest' },
          },
        },
      },
      environments: {
        staging: {},
      },
      'x-eve': {
        app_links: {
          exports: {
            apis: {
              observation: {
                service: 'api',
                cli: 'obs',
                scopes: ['observations:read', 'deployments:read'],
                consumers: [
                  {
                    project: 'acme',
                    scopes: ['observations:read'],
                    envs: ['staging'],
                  },
                ],
              },
            },
            events: {
              'observation-feed': {
                types: ['app.observation.created'],
                consumers: [{ project: 'acme' }],
              },
            },
          },
          consumes: {
            observation: {
              project: 'producer-app',
              api: 'observation',
              scopes: ['observations:read'],
              events: {
                feed: 'observation-feed',
                types: ['app.observation.created'],
              },
              inject_into: {
                services: ['api'],
                jobs: true,
              },
            },
          },
        },
      },
    });

    const appLinks = getManifestAppLinks(parsed);
    expect(appLinks?.exports?.apis.observation.service).toBe('api');
    expect(appLinks?.exports?.events['observation-feed'].consumers[0]?.types).toBeUndefined();
    expect(appLinks?.consumes?.observation.environment).toBe('same');
    expect(appLinks?.consumes?.observation.inject_into?.jobs).toBe(true);
  });

  it('rejects consume entries without api or events', () => {
    const parsed = ManifestSchema.safeParse({
      'x-eve': {
        app_links: {
          consumes: {
            broken: {
              project: 'producer',
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});
