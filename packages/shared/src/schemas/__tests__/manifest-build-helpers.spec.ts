import { describe, it, expect } from 'vitest';
import { getBuildableServices, getRegistryConfig, getServicesWithBuildButNoImage, hasUsableRegistry, getBuildableServicesWithDefaults, analyzeManifestCoherence, type Manifest } from '../manifest.js';

describe('getBuildableServices', () => {
  it('returns services with both build and image fields', () => {
    const manifest: Manifest = {
      services: {
        api: {
          image: 'myorg/api',
          build: {
            context: './api',
            dockerfile: 'Dockerfile',
          },
        },
        web: {
          image: 'myorg/web',
          build: {
            context: './web',
          },
        },
      },
    };

    const result = getBuildableServices(manifest);

    expect(result).toEqual({
      api: {
        image: 'myorg/api',
        build: {
          context: './api',
          dockerfile: 'Dockerfile',
        },
      },
      web: {
        image: 'myorg/web',
        build: {
          context: './web',
        },
      },
    });
  });

  it('excludes services without build field', () => {
    const manifest: Manifest = {
      services: {
        api: {
          image: 'myorg/api',
          build: {
            context: './api',
          },
        },
        postgres: {
          image: 'postgres:15',
        },
      },
    };

    const result = getBuildableServices(manifest);

    expect(result).toEqual({
      api: {
        image: 'myorg/api',
        build: {
          context: './api',
        },
      },
    });
    expect(result).not.toHaveProperty('postgres');
  });

  it('excludes services without image field', () => {
    const manifest: Manifest = {
      services: {
        api: {
          image: 'myorg/api',
          build: {
            context: './api',
          },
        },
        worker: {
          build: {
            context: './worker',
          },
        },
      },
    };

    const result = getBuildableServices(manifest);

    expect(result).toEqual({
      api: {
        image: 'myorg/api',
        build: {
          context: './api',
        },
      },
    });
    expect(result).not.toHaveProperty('worker');
  });

  it('excludes services with x-eve.external: true', () => {
    const manifest: Manifest = {
      services: {
        api: {
          image: 'myorg/api',
          build: {
            context: './api',
          },
        },
        'external-db': {
          image: 'postgres:15',
          build: {
            context: './db',
          },
          'x-eve': {
            external: true,
          },
        },
      },
    };

    const result = getBuildableServices(manifest);

    expect(result).toEqual({
      api: {
        image: 'myorg/api',
        build: {
          context: './api',
        },
      },
    });
    expect(result).not.toHaveProperty('external-db');
  });

  it('excludes services with x_eve.external: true (underscore variant)', () => {
    const manifest: Manifest = {
      services: {
        api: {
          image: 'myorg/api',
          build: {
            context: './api',
          },
        },
        'external-cache': {
          image: 'redis:7',
          build: {
            context: './cache',
          },
          x_eve: {
            external: true,
          },
        },
      },
    };

    const result = getBuildableServices(manifest);

    expect(result).toEqual({
      api: {
        image: 'myorg/api',
        build: {
          context: './api',
        },
      },
    });
    expect(result).not.toHaveProperty('external-cache');
  });

  it('returns empty object when no services match', () => {
    const manifest: Manifest = {
      services: {
        postgres: {
          image: 'postgres:15',
        },
        redis: {
          image: 'redis:7',
        },
      },
    };

    const result = getBuildableServices(manifest);

    expect(result).toEqual({});
  });

  it('returns empty object when manifest has no services', () => {
    const manifest: Manifest = {};

    const result = getBuildableServices(manifest);

    expect(result).toEqual({});
  });

  it('handles services with external: false as buildable', () => {
    const manifest: Manifest = {
      services: {
        api: {
          image: 'myorg/api',
          build: {
            context: './api',
          },
          'x-eve': {
            external: false,
          },
        },
      },
    };

    const result = getBuildableServices(manifest);

    expect(result).toEqual({
      api: {
        image: 'myorg/api',
        build: {
          context: './api',
        },
        'x-eve': {
          external: false,
        },
      },
    });
  });

  it('handles mixed buildable and non-buildable services', () => {
    const manifest: Manifest = {
      services: {
        api: {
          image: 'myorg/api',
          build: {
            context: './api',
          },
        },
        worker: {
          image: 'myorg/worker',
          build: {
            context: './worker',
          },
        },
        postgres: {
          image: 'postgres:15',
        },
        'external-service': {
          image: 'external/service',
          build: {
            context: './external',
          },
          'x-eve': {
            external: true,
          },
        },
        'no-image': {
          build: {
            context: './no-image',
          },
        },
      },
    };

    const result = getBuildableServices(manifest);

    expect(result).toEqual({
      api: {
        image: 'myorg/api',
        build: {
          context: './api',
        },
      },
      worker: {
        image: 'myorg/worker',
        build: {
          context: './worker',
        },
      },
    });
    expect(Object.keys(result)).toHaveLength(2);
  });
});

describe('getRegistryConfig', () => {
  it('returns registry config when manifest has registry section', () => {
    const manifest: Manifest = {
      registry: {
        host: 'ghcr.io',
        namespace: 'myorg',
      },
    };

    const result = getRegistryConfig(manifest);

    expect(result).toEqual({
      host: 'ghcr.io',
      namespace: 'myorg',
      auth: undefined,
    });
  });

  it('returns null when no registry configured', () => {
    const manifest: Manifest = {};

    const result = getRegistryConfig(manifest);

    expect(result).toBeNull();
  });

  it('returns null when registry section exists but has no host', () => {
    const manifest: Manifest = {
      registry: {
        namespace: 'myorg',
      },
    };

    const result = getRegistryConfig(manifest);

    expect(result).toBeNull();
  });

  it('includes auth settings when present', () => {
    const manifest: Manifest = {
      registry: {
        host: 'ghcr.io',
        namespace: 'myorg',
        auth: {
          username_secret: 'GHCR_USERNAME',
          token_secret: 'GITHUB_TOKEN',
        },
      },
    };

    const result = getRegistryConfig(manifest);

    expect(result).toEqual({
      host: 'ghcr.io',
      namespace: 'myorg',
      auth: {
        username_secret: 'GHCR_USERNAME',
        token_secret: 'GITHUB_TOKEN',
      },
    });
  });

  it('handles namespace correctly when present', () => {
    const manifest: Manifest = {
      registry: {
        host: 'registry.example.com',
        namespace: 'my-custom-namespace',
      },
    };

    const result = getRegistryConfig(manifest);

    expect(result).toEqual({
      host: 'registry.example.com',
      namespace: 'my-custom-namespace',
      auth: undefined,
    });
  });

  it('handles registry config without namespace', () => {
    const manifest: Manifest = {
      registry: {
        host: 'docker.io',
      },
    };

    const result = getRegistryConfig(manifest);

    expect(result).toEqual({
      host: 'docker.io',
      namespace: undefined,
      auth: undefined,
    });
  });

  it('handles partial auth settings', () => {
    const manifest: Manifest = {
      registry: {
        host: 'ghcr.io',
        auth: {
          username_secret: 'GHCR_USERNAME',
        },
      },
    };

    const result = getRegistryConfig(manifest);

    expect(result).toEqual({
      host: 'ghcr.io',
      namespace: undefined,
      auth: {
        username_secret: 'GHCR_USERNAME',
        token_secret: undefined,
      },
    });
  });

  it('handles empty auth object', () => {
    const manifest: Manifest = {
      registry: {
        host: 'ghcr.io',
        auth: {},
      },
    };

    const result = getRegistryConfig(manifest);

    expect(result).toEqual({
      host: 'ghcr.io',
      namespace: undefined,
      auth: {
        username_secret: undefined,
        token_secret: undefined,
      },
    });
  });

  it('returns null when registry is explicitly null', () => {
    const manifest: Manifest = {
      registry: null as any,
    };

    const result = getRegistryConfig(manifest);

    expect(result).toBeNull();
  });

  it('handles complete registry configuration', () => {
    const manifest: Manifest = {
      registry: {
        host: 'registry.gitlab.com',
        namespace: 'group/project',
        auth: {
          username_secret: 'GITLAB_USER',
          token_secret: 'GITLAB_TOKEN',
        },
      },
    };

    const result = getRegistryConfig(manifest);

    expect(result).toEqual({
      host: 'registry.gitlab.com',
      namespace: 'group/project',
      auth: {
        username_secret: 'GITLAB_USER',
        token_secret: 'GITLAB_TOKEN',
      },
    });
  });
});

describe('getServicesWithBuildButNoImage', () => {
  it('returns services with build but no image', () => {
    const manifest: Manifest = {
      services: {
        app: { build: { context: '.' } },
        api: { image: 'myorg/api', build: { context: './api' } },
        db: { image: 'postgres:16' },
      },
    };
    const result = getServicesWithBuildButNoImage(manifest);
    expect(Object.keys(result)).toEqual(['app']);
    expect(result.app.build).toEqual({ context: '.' });
  });

  it('excludes external services', () => {
    const manifest: Manifest = {
      services: {
        app: { build: { context: '.' }, 'x-eve': { external: true } },
      },
    };
    expect(Object.keys(getServicesWithBuildButNoImage(manifest))).toEqual([]);
  });

  it('returns empty when all services have image', () => {
    const manifest: Manifest = {
      services: {
        api: { image: 'myorg/api', build: { context: './api' } },
      },
    };
    expect(Object.keys(getServicesWithBuildButNoImage(manifest))).toEqual([]);
  });
});

describe('hasUsableRegistry', () => {
  it('returns true for registry: "eve"', () => {
    expect(hasUsableRegistry({ registry: 'eve' })).toBe(true);
  });

  it('returns true for registry with host', () => {
    expect(hasUsableRegistry({ registry: { host: 'ghcr.io' } })).toBe(true);
  });

  it('returns false for registry: "none"', () => {
    expect(hasUsableRegistry({ registry: 'none' })).toBe(false);
  });

  it('returns false for no registry', () => {
    expect(hasUsableRegistry({})).toBe(false);
  });

  it('returns false for registry without host', () => {
    expect(hasUsableRegistry({ registry: { namespace: 'myorg' } })).toBe(false);
  });
});

describe('getBuildableServicesWithDefaults', () => {
  it('derives image from service name when registry: "eve"', () => {
    const manifest: Manifest = {
      registry: 'eve',
      services: {
        app: { build: { context: '.' } },
      },
    };
    const result = getBuildableServicesWithDefaults(manifest);
    expect(result.app.image).toBe('app');
    expect(result.app.build).toEqual({ context: '.' });
  });

  it('derives image when registry has host', () => {
    const manifest: Manifest = {
      registry: { host: 'ghcr.io' },
      services: {
        web: { build: { context: './web' } },
      },
    };
    const result = getBuildableServicesWithDefaults(manifest);
    expect(result.web.image).toBe('web');
  });

  it('does not derive when registry: "none"', () => {
    const manifest: Manifest = {
      registry: 'none',
      services: {
        app: { build: { context: '.' } },
      },
    };
    const result = getBuildableServicesWithDefaults(manifest);
    expect(Object.keys(result)).toEqual([]);
  });

  it('does not derive when no registry', () => {
    const manifest: Manifest = {
      services: {
        app: { build: { context: '.' } },
      },
    };
    const result = getBuildableServicesWithDefaults(manifest);
    expect(Object.keys(result)).toEqual([]);
  });

  it('preserves explicit image field', () => {
    const manifest: Manifest = {
      registry: 'eve',
      services: {
        api: { image: 'custom/api', build: { context: './api' } },
      },
    };
    const result = getBuildableServicesWithDefaults(manifest);
    expect(result.api.image).toBe('custom/api');
  });

  it('excludes external services even with registry', () => {
    const manifest: Manifest = {
      registry: 'eve',
      services: {
        app: { build: { context: '.' }, 'x-eve': { external: true } },
      },
    };
    const result = getBuildableServicesWithDefaults(manifest);
    expect(Object.keys(result)).toEqual([]);
  });

  it('mixes explicit and derived services', () => {
    const manifest: Manifest = {
      registry: 'eve',
      services: {
        api: { image: 'custom/api', build: { context: './api' } },
        worker: { build: { context: './worker' } },
        db: { image: 'postgres:16' },
      },
    };
    const result = getBuildableServicesWithDefaults(manifest);
    expect(Object.keys(result).sort()).toEqual(['api', 'worker']);
    expect(result.api.image).toBe('custom/api');
    expect(result.worker.image).toBe('worker');
  });
});

describe('analyzeManifestCoherence', () => {
  it('returns error for service with build but no image and no registry', () => {
    const manifest: Manifest = {
      services: {
        app: { build: { context: '.' } },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'build_no_image', severity: 'error' }),
    ]);
  });

  it('returns clean for service with build but no image when registry: "eve"', () => {
    const manifest: Manifest = {
      registry: 'eve',
      services: {
        app: { build: { context: '.' } },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual([]);
  });

  it('warns about deploy-only pipeline with buildable services', () => {
    const manifest: Manifest = {
      registry: 'eve',
      services: {
        app: { build: { context: '.' } },
      },
      pipelines: {
        deploy: {
          steps: [
            { name: 'deploy', action: { type: 'deploy', env_name: 'sandbox' } },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'deploy_without_build', severity: 'warning' }),
    ]);
  });

  it('no warning for deploy-only pipeline without buildable services', () => {
    const manifest: Manifest = {
      services: {
        db: { image: 'postgres:16' },
      },
      pipelines: {
        deploy: {
          steps: [
            { name: 'deploy', action: { type: 'deploy', env_name: 'sandbox' } },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual([]);
  });

  it('no warning for complete build-release-deploy pipeline', () => {
    const manifest: Manifest = {
      registry: 'eve',
      services: {
        app: { build: { context: '.' } },
      },
      pipelines: {
        deploy: {
          steps: [
            { name: 'build', action: { type: 'build' } },
            { name: 'release', action: { type: 'release' }, depends_on: ['build'] },
            { name: 'deploy', action: { type: 'deploy', env_name: 'sandbox' }, depends_on: ['release'] },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual([]);
  });

  it('returns error for environment referencing nonexistent pipeline', () => {
    const manifest: Manifest = {
      environments: {
        sandbox: { pipeline: 'nonexistent' },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'missing_pipeline', severity: 'error' }),
    ]);
  });

  it('no error for environment referencing existing pipeline', () => {
    const manifest: Manifest = {
      environments: {
        sandbox: { pipeline: 'deploy' },
      },
      pipelines: {
        deploy: {
          steps: [
            { name: 'deploy', action: { type: 'deploy', env_name: 'sandbox' } },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    // May have deploy_without_build warning, but no missing_pipeline error
    expect(warnings.filter(w => w.code === 'missing_pipeline')).toEqual([]);
  });

  it('returns error for duplicate step names in workflow', () => {
    const manifest: Manifest = {
      workflows: {
        ingest: {
          steps: [
            { name: 'extract', agent: { name: 'extractor' } },
            { name: 'extract', agent: { name: 'loader' } },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'workflow_duplicate_step', severity: 'error' }),
      ]),
    );
  });

  it('returns error for invalid depends_on reference in workflow', () => {
    const manifest: Manifest = {
      workflows: {
        ingest: {
          steps: [
            { name: 'extract', agent: { name: 'extractor' } },
            { name: 'load', agent: { name: 'loader' }, depends_on: ['nonexistent'] },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'workflow_invalid_dep', severity: 'error' }),
      ]),
    );
  });

  it('returns error for dependency cycle in workflow', () => {
    const manifest: Manifest = {
      workflows: {
        loopy: {
          steps: [
            { name: 'a', agent: { name: 'bot' }, depends_on: ['c'] },
            { name: 'b', agent: { name: 'bot' }, depends_on: ['a'] },
            { name: 'c', agent: { name: 'bot' }, depends_on: ['b'] },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'workflow_cycle', severity: 'error' }),
      ]),
    );
  });

  it('returns clean for valid workflow dependency graph', () => {
    const manifest: Manifest = {
      workflows: {
        ingest: {
          steps: [
            { name: 'extract', agent: { name: 'extractor' } },
            { name: 'transform', agent: { name: 'transformer' }, depends_on: ['extract'] },
            { name: 'load', agent: { name: 'loader' }, depends_on: ['transform'] },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const workflowWarnings = warnings.filter(w =>
      w.code.startsWith('workflow_'),
    );
    expect(workflowWarnings).toEqual([]);
  });

  it('returns clean for workflow with diamond dependency pattern', () => {
    const manifest: Manifest = {
      workflows: {
        diamond: {
          steps: [
            { name: 'start', agent: { name: 'bot' } },
            { name: 'left', agent: { name: 'bot' }, depends_on: ['start'] },
            { name: 'right', agent: { name: 'bot' }, depends_on: ['start'] },
            { name: 'end', agent: { name: 'bot' }, depends_on: ['left', 'right'] },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const workflowWarnings = warnings.filter(w =>
      w.code.startsWith('workflow_'),
    );
    expect(workflowWarnings).toEqual([]);
  });

  it('validates pipeline step graphs too (not just workflows)', () => {
    const manifest: Manifest = {
      pipelines: {
        deploy: {
          steps: [
            { name: 'build', action: { type: 'build' } },
            { name: 'deploy', action: { type: 'deploy' }, depends_on: ['nonexistent'] },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'workflow_invalid_dep', severity: 'error' }),
      ]),
    );
  });

  // Trigger validation tests

  it('warns when trigger has no recognized type', () => {
    const manifest: Manifest = {
      workflows: {
        broken: {
          trigger: { bogus: { event: 'something' } },
          steps: [{ name: 'go', agent: { name: 'bot' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'trigger_no_recognized_type', severity: 'warning' }),
      ]),
    );
  });

  it('warns for unknown GitHub event type', () => {
    const manifest: Manifest = {
      pipelines: {
        ci: {
          trigger: { github: { event: 'release' } },
          steps: [{ name: 'build', action: { type: 'build' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'trigger_invalid_github_event', severity: 'warning' }),
      ]),
    );
  });

  it('no warning for valid GitHub push trigger', () => {
    const manifest: Manifest = {
      pipelines: {
        ci: {
          trigger: { github: { event: 'push', branch: 'main' } },
          steps: [{ name: 'build', action: { type: 'build' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const triggerWarnings = warnings.filter(w => w.code.startsWith('trigger_'));
    expect(triggerWarnings).toEqual([]);
  });

  it('no warning for valid GitHub pull_request trigger', () => {
    const manifest: Manifest = {
      pipelines: {
        ci: {
          trigger: { github: { event: 'pull_request' } },
          steps: [{ name: 'test', action: { type: 'build' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const triggerWarnings = warnings.filter(w => w.code.startsWith('trigger_'));
    expect(triggerWarnings).toEqual([]);
  });

  it('warns for unknown system event type', () => {
    const manifest: Manifest = {
      workflows: {
        remediate: {
          trigger: { system: { event: 'typo.event' } },
          steps: [{ name: 'fix', agent: { name: 'fixer' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'trigger_unknown_system_event', severity: 'warning' }),
      ]),
    );
  });

  it('no warning for known system event types', () => {
    const manifest: Manifest = {
      workflows: {
        remediate: {
          trigger: { system: { event: 'job.failed' } },
          steps: [{ name: 'fix', agent: { name: 'fixer' } }],
        },
        ingest: {
          trigger: { system: { event: 'doc.ingest' } },
          steps: [{ name: 'process', agent: { name: 'ingestor' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const triggerWarnings = warnings.filter(w => w.code.startsWith('trigger_'));
    expect(triggerWarnings).toEqual([]);
  });

  it('warns when cron trigger has no schedule', () => {
    const manifest: Manifest = {
      workflows: {
        nightly: {
          trigger: { cron: {} },
          steps: [{ name: 'run', agent: { name: 'bot' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'trigger_cron_no_schedule', severity: 'warning' }),
      ]),
    );
  });

  it('no warning for cron trigger with schedule', () => {
    const manifest: Manifest = {
      workflows: {
        nightly: {
          trigger: { cron: { schedule: '0 0 * * *' } },
          steps: [{ name: 'run', agent: { name: 'bot' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const triggerWarnings = warnings.filter(w => w.code.startsWith('trigger_'));
    expect(triggerWarnings).toEqual([]);
  });

  it('no warning for manual trigger', () => {
    const manifest: Manifest = {
      pipelines: {
        deploy: {
          trigger: { manual: true },
          steps: [{ name: 'deploy', action: { type: 'deploy', env_name: 'prod' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const triggerWarnings = warnings.filter(w => w.code.startsWith('trigger_'));
    expect(triggerWarnings).toEqual([]);
  });

  it('no warning for app trigger', () => {
    const manifest: Manifest = {
      workflows: {
        respond: {
          trigger: { app: { event: 'question.answered' } },
          steps: [{ name: 'process', agent: { name: 'bot' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const triggerWarnings = warnings.filter(w => w.code.startsWith('trigger_'));
    expect(triggerWarnings).toEqual([]);
  });

  it('no warning for generic event trigger', () => {
    const manifest: Manifest = {
      workflows: {
        handler: {
          trigger: { event: { source: 'app', type: 'doc.uploaded' } },
          steps: [{ name: 'handle', agent: { name: 'bot' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const triggerWarnings = warnings.filter(w => w.code.startsWith('trigger_'));
    expect(triggerWarnings).toEqual([]);
  });

  it('does not warn for pipelines/workflows without triggers', () => {
    const manifest: Manifest = {
      pipelines: {
        deploy: {
          steps: [{ name: 'deploy', action: { type: 'deploy', env_name: 'sandbox' } }],
        },
      },
      workflows: {
        ingest: {
          steps: [{ name: 'extract', agent: { name: 'extractor' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const triggerWarnings = warnings.filter(w => w.code.startsWith('trigger_'));
    expect(triggerWarnings).toEqual([]);
  });

  it('warns for cron trigger with empty string schedule', () => {
    const manifest: Manifest = {
      workflows: {
        nightly: {
          trigger: { cron: { schedule: '  ' } },
          steps: [{ name: 'run', agent: { name: 'bot' } }],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'trigger_cron_no_schedule', severity: 'warning' }),
      ]),
    );
  });

  // 4d. Condition validation tests
  it('returns error for condition with invalid format', () => {
    const manifest: Manifest = {
      workflows: {
        test: {
          steps: [
            { name: 'triage', agent: { name: 'bot' } },
            { name: 'deep', depends_on: ['triage'], condition: 'invalid condition', agent: { name: 'bot' } },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'workflow_invalid_condition', severity: 'error' }),
      ]),
    );
  });

  it('returns error for condition referencing nonexistent step', () => {
    const manifest: Manifest = {
      workflows: {
        test: {
          steps: [
            { name: 'triage', agent: { name: 'bot' } },
            { name: 'deep', depends_on: ['triage'], condition: "ghost.status == 'complex'", agent: { name: 'bot' } },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'workflow_condition_unknown_step', severity: 'error' }),
      ]),
    );
  });

  it('returns error for condition referencing step not in depends_on', () => {
    const manifest: Manifest = {
      workflows: {
        test: {
          steps: [
            { name: 'triage', agent: { name: 'bot' } },
            { name: 'other', agent: { name: 'bot' } },
            { name: 'deep', depends_on: ['other'], condition: "triage.status == 'complex'", agent: { name: 'bot' } },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'workflow_condition_not_dependency', severity: 'error' }),
      ]),
    );
  });

  it('accepts valid condition with == operator', () => {
    const manifest: Manifest = {
      workflows: {
        test: {
          steps: [
            { name: 'triage', agent: { name: 'bot' } },
            { name: 'deep', depends_on: ['triage'], condition: "triage.status == 'complex'", agent: { name: 'bot' } },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const conditionWarnings = warnings.filter(w => w.code.startsWith('workflow_condition'));
    expect(conditionWarnings).toEqual([]);
  });

  it('accepts valid condition with != operator', () => {
    const manifest: Manifest = {
      workflows: {
        test: {
          steps: [
            { name: 'triage', agent: { name: 'bot' } },
            { name: 'deep', depends_on: ['triage'], condition: "triage.status != 'simple'", agent: { name: 'bot' } },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const conditionWarnings = warnings.filter(w => w.code.startsWith('workflow_condition'));
    expect(conditionWarnings).toEqual([]);
  });

  it('accepts valid condition with double quotes', () => {
    const manifest: Manifest = {
      workflows: {
        test: {
          steps: [
            { name: 'triage', agent: { name: 'bot' } },
            { name: 'deep', depends_on: ['triage'], condition: 'triage.status == "complex"', agent: { name: 'bot' } },
          ],
        },
      },
    };
    const warnings = analyzeManifestCoherence(manifest);
    const conditionWarnings = warnings.filter(w => w.code.startsWith('workflow_condition'));
    expect(conditionWarnings).toEqual([]);
  });
});
