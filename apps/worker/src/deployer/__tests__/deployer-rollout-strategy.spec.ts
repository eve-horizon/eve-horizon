import { describe, it, expect, vi, beforeEach } from 'vitest';
import yaml from 'yaml';
import { DeployerService } from '../deployer.service.js';

// Deployment rollout strategy selection.
//
// A ReadWriteOnce volume can only be mounted by one pod, so a RollingUpdate
// whose surge pod lands on another node blocks on the PVC. Services that
// resolve such a volume must deploy with Recreate; `x-eve.rollout` is an
// explicit override in either direction.

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

function buildManifest(services: Record<string, unknown>): string {
  return yaml.stringify({ services });
}

function appService(xeve: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    image: 'myapp:latest',
    ports: ['3000'],
    'x-eve': xeve,
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

describe('DeployerService – rollout strategy', () => {
  let deployer: DeployerService;

  beforeEach(() => {
    deployer = new DeployerService(null as any, null as any);
  });

  async function renderDeployment(services: Record<string, unknown>) {
    const result = await (deployer as any).renderManifest({
      manifestYaml: buildManifest(services),
      ...baseParams,
    });
    const docs = yaml.parseAllDocuments(result.manifestYaml).map((doc: any) => doc.toJSON());
    return docs.find((d: any) => d.kind === 'Deployment');
  }

  it('uses Recreate for a service with ReadWriteOnce storage', async () => {
    const deployment = await renderDeployment({
      api: appService({ storage: { mount_path: '/data', access_mode: 'ReadWriteOnce' } }),
    });

    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
  });

  it('uses Recreate when storage omits access_mode (defaults to ReadWriteOnce)', async () => {
    const deployment = await renderDeployment({
      api: appService({ storage: { mount_path: '/data', size: '10Gi' } }),
    });

    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
  });

  it('keeps the default RollingUpdate for ReadWriteMany storage', async () => {
    const deployment = await renderDeployment({
      api: appService({ storage: { mount_path: '/data', access_mode: 'ReadWriteMany' } }),
    });

    // Undefined means the rendered manifest does not override the strategy,
    // so Kubernetes applies its RollingUpdate default.
    expect(deployment.spec.strategy).toBeUndefined();
  });

  it('honours x-eve.rollout: rolling over ReadWriteOnce storage', async () => {
    const deployment = await renderDeployment({
      api: appService({
        rollout: 'rolling',
        storage: { mount_path: '/data', access_mode: 'ReadWriteOnce' },
      }),
    });

    expect(deployment.spec.strategy).toBeUndefined();
  });

  it('honours x-eve.rollout: rolling over the database role', async () => {
    const deployment = await renderDeployment({
      db: { image: 'postgres:16', 'x-eve': { role: 'database', rollout: 'rolling' } },
    });

    expect(deployment.spec.strategy).toBeUndefined();
  });

  it('honours x-eve.rollout: recreate for a service without storage', async () => {
    const deployment = await renderDeployment({
      api: appService({ rollout: 'recreate' }),
    });

    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
  });

  it('does not add database shutdown handling to a non-database service with ReadWriteOnce storage', async () => {
    const deployment = await renderDeployment({
      api: appService({ storage: { mount_path: '/data', access_mode: 'ReadWriteOnce' } }),
    });

    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
    expect(deployment.spec.template.spec.terminationGracePeriodSeconds).toBeUndefined();
    expect(deployment.spec.template.spec.containers[0].lifecycle).toBeUndefined();
  });
});
