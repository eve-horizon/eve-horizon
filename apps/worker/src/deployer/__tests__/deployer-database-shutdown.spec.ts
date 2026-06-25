import { describe, it, expect, vi, beforeEach } from 'vitest';
import yaml from 'yaml';
import { DeployerService } from '../deployer.service.js';

// Mock loadConfig + resolveProjectSecrets — renderManifest reads domain/ingress config
// and calls resolveProjectSecrets internally (both now live in @eve/shared)
vi.mock('@eve/shared', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => ({
      EVE_DEFAULT_DOMAIN: '',
      EVE_DEFAULT_INGRESS_CLASS: undefined,
      EVE_DEFAULT_TLS_CLUSTER_ISSUER: undefined,
      EVE_DEFAULT_TLS_SECRET: undefined,
    }),
    resolveProjectSecrets: vi.fn().mockResolvedValue({
      resolved: true,
      secrets: [],
      error: null,
    }),
  };
});

// Minimal manifest YAML builders
function buildManifest(services: Record<string, unknown>): string {
  return yaml.stringify({ services });
}

function dbService(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    image: 'postgres:16',
    'x-eve': { role: 'database', storage: { size: '10Gi' } },
    ...overrides,
  };
}

function appService(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    image: 'myapp:latest',
    ports: ['3000'],
    ...overrides,
  };
}

const baseParams = {
  namespace: 'eve-myorg-myproj-test',
  envName: 'test',
  projectSlug: 'myproj',
  projectId: 'proj_123',
  orgId: 'org_456',
  orgSlug: 'myorg',
  releaseId: 'rel_789',
};

describe('DeployerService – database graceful shutdown', () => {
  let deployer: DeployerService;

  beforeEach(() => {
    // Construct with null deps — we only call private renderManifest which
    // doesn't touch DB or K8s directly (secrets are mocked above)
    deployer = new DeployerService(null as any, null as any);
  });

  function renderManifest(manifestYaml: string) {
    return (deployer as any).renderManifest({ manifestYaml, ...baseParams });
  }

  function parseDocuments(manifestYaml: string): any[] {
    return yaml.parseAllDocuments(manifestYaml).map((doc: any) => doc.toJSON());
  }

  // ── Strategy ────────────────────────────────────────────────────────

  it('sets Recreate strategy on database deployments', async () => {
    const result = await renderManifest(buildManifest({ db: dbService() }));
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');

    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
  });

  it('does not set strategy on non-database deployments', async () => {
    const result = await renderManifest(buildManifest({ web: appService() }));
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');

    expect(deployment.spec.strategy).toBeUndefined();
  });

  // ── terminationGracePeriodSeconds ───────────────────────────────────

  it('sets terminationGracePeriodSeconds=120 on database pods', async () => {
    const result = await renderManifest(buildManifest({ db: dbService() }));
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');

    expect(deployment.spec.template.spec.terminationGracePeriodSeconds).toBe(120);
  });

  it('does not set terminationGracePeriodSeconds on app pods', async () => {
    const result = await renderManifest(buildManifest({ web: appService() }));
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');

    expect(deployment.spec.template.spec.terminationGracePeriodSeconds).toBeUndefined();
  });

  // ── Resource requests ───────────────────────────────────────────────

  it('adds default resource requests to app containers for OpenCost allocation', async () => {
    const result = await renderManifest(buildManifest({ web: appService() }));
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');
    const container = deployment.spec.template.spec.containers[0];

    expect(container.resources).toEqual({
      requests: {
        cpu: '25m',
        memory: '64Mi',
      },
    });
  });

  it('preserves manifest resource overrides and only fills missing requests', async () => {
    const result = await renderManifest(buildManifest({
      web: appService({
        resources: {
          requests: { cpu: '100m', 'ephemeral-storage': '1Gi' },
          limits: { memory: '512Mi', 'nvidia.com/gpu': '1' },
        },
      }),
    }));
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');
    const container = deployment.spec.template.spec.containers[0];

    expect(container.resources).toEqual({
      requests: {
        cpu: '100m',
        'ephemeral-storage': '1Gi',
        memory: '64Mi',
      },
      limits: {
        memory: '512Mi',
        'nvidia.com/gpu': '1',
      },
    });
  });

  // ── preStop lifecycle hook ──────────────────────────────────────────

  it('adds preStop pg_ctl hook to database containers', async () => {
    const result = await renderManifest(buildManifest({ db: dbService() }));
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');
    const container = deployment.spec.template.spec.containers[0];

    expect(container.lifecycle).toBeDefined();
    expect(container.lifecycle.preStop.exec.command).toEqual([
      '/bin/sh', '-c',
      'pg_ctl stop -D /var/lib/postgresql/data -m fast 2>/dev/null || true',
    ]);
  });

  it('does not add lifecycle hook to app containers', async () => {
    const result = await renderManifest(buildManifest({ web: appService() }));
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');
    const container = deployment.spec.template.spec.containers[0];

    expect(container.lifecycle).toBeUndefined();
  });

  // ── RWO PVC + replicas > 1 validation ──────────────────────────────

  it('rejects RWO PVC with replicas > 1', async () => {
    const manifest = buildManifest({
      db: {
        ...dbService(),
        replicas: 2,
        'x-eve': {
          role: 'database',
          storage: { size: '10Gi', access_mode: 'ReadWriteOnce' },
        },
      },
    });

    await expect(renderManifest(manifest)).rejects.toThrow(
      /ReadWriteOnce PVC but 2 replicas/
    );
  });

  it('allows RWM PVC with replicas > 1', async () => {
    const manifest = buildManifest({
      db: {
        ...dbService(),
        replicas: 2,
        'x-eve': {
          role: 'database',
          storage: { size: '10Gi', access_mode: 'ReadWriteMany' },
        },
      },
    });

    // Should not throw
    const result = await renderManifest(manifest);
    expect(result.manifestYaml).toBeDefined();
  });

  it('allows single-replica RWO PVC (the normal case)', async () => {
    const manifest = buildManifest({ db: dbService() });

    const result = await renderManifest(manifest);
    expect(result.manifestYaml).toBeDefined();
  });

  // ── Mixed services ─────────────────────────────────────────────────

  it('applies database settings only to database services in a mixed manifest', async () => {
    const manifest = buildManifest({
      db: dbService(),
      web: appService(),
    });

    const result = await renderManifest(manifest);
    const docs = parseDocuments(result.manifestYaml);
    const deployments = docs.filter((d: any) => d.kind === 'Deployment');

    expect(deployments).toHaveLength(2);

    const dbDeploy = deployments.find((d: any) => d.spec.template.spec.containers[0].name === 'db');
    const webDeploy = deployments.find((d: any) => d.spec.template.spec.containers[0].name === 'web');

    // Database gets Recreate + graceful shutdown
    expect(dbDeploy.spec.strategy).toEqual({ type: 'Recreate' });
    expect(dbDeploy.spec.template.spec.terminationGracePeriodSeconds).toBe(120);
    expect(dbDeploy.spec.template.spec.containers[0].lifecycle).toBeDefined();

    // App gets defaults (no strategy override, no lifecycle)
    expect(webDeploy.spec.strategy).toBeUndefined();
    expect(webDeploy.spec.template.spec.terminationGracePeriodSeconds).toBeUndefined();
    expect(webDeploy.spec.template.spec.containers[0].lifecycle).toBeUndefined();
  });
});
