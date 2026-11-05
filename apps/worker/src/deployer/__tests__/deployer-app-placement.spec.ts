import { beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';
import { DeployerService } from '../deployer.service.js';

// Rendered pod specs with and without the app placement contract
// (docs/plans/app-compute-classes-plan.md).

const baseConfig = {
  EVE_DEFAULT_DOMAIN: '',
  EVE_DEFAULT_INGRESS_CLASS: undefined,
  EVE_DEFAULT_TLS_CLUSTER_ISSUER: undefined,
  EVE_DEFAULT_TLS_SECRET: undefined,
  EVE_COMPUTE_MODEL: 'k3s',
  EVE_STABLE_EGRESS_NODE_LABEL_KEY: 'eve.io/egress-pool',
  EVE_STABLE_EGRESS_NODE_LABEL_VALUE: 'stable',
  EVE_STABLE_EGRESS_TAINT_KEY: 'eve.io/egress-pool',
  EVE_STABLE_EGRESS_TAINT_VALUE: 'stable',
  EVE_STABLE_EGRESS_TAINT_EFFECT: 'NoSchedule',
  EVE_APP_PLACEMENT_ENABLED: false,
};

const appPool = {
  EVE_APP_PLACEMENT_ENABLED: true,
  EVE_APP_NODE_SELECTOR_KEY: 'pool',
  EVE_APP_NODE_SELECTOR_VALUE: 'apps',
  EVE_APP_TAINT_KEY: 'pool',
  EVE_APP_TAINT_VALUE: 'apps',
  EVE_APP_TAINT_EFFECT: 'NoSchedule',
};

let configOverride: Record<string, unknown> = {};

vi.mock('@eve/shared', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => ({ ...baseConfig, ...configOverride }),
    resolveProjectSecrets: vi.fn().mockResolvedValue({ resolved: true, secrets: [], error: null }),
  };
});

const baseParams = {
  namespace: 'eve-myorg-myproj-test',
  envName: 'test',
  projectSlug: 'myproj',
  projectId: 'proj_123',
  orgId: 'org_456',
  orgSlug: 'myorg',
  releaseId: 'rel_789',
};

function buildManifest(services: Record<string, unknown>): string {
  return yaml.stringify({ services });
}

const appPoolToleration = { key: 'pool', operator: 'Equal', value: 'apps', effect: 'NoSchedule' };

describe('DeployerService - app node placement', () => {
  let deployer: DeployerService;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configOverride = {};
    deployer = new DeployerService(null as any, null as any);
    warn = vi.fn();
    (deployer as any).logger = { warn, log: vi.fn(), error: vi.fn(), debug: vi.fn() };
  });

  async function renderPodSpecs(services: Record<string, unknown>): Promise<Record<string, any>> {
    const result = await (deployer as any).renderManifest({ manifestYaml: buildManifest(services), ...baseParams });
    const docs = yaml.parseAllDocuments(result.manifestYaml).map((doc: any) => doc.toJSON());
    return Object.fromEntries(
      docs
        .filter((doc: any) => doc.kind === 'Deployment')
        .map((doc: any) => [doc.spec.template.spec.containers[0].name, doc.spec.template.spec]),
    );
  }

  it('renders no selector or toleration without the variables', async () => {
    const { web } = await renderPodSpecs({ web: { image: 'web:latest', ports: ['3000'] } });
    expect(web.nodeSelector).toBeUndefined();
    expect(web.tolerations).toBeUndefined();
    expect(warn.mock.calls.flat().filter((message) => /placement|EVE_APP_/.test(String(message)))).toEqual([]);
  });

  it('renders no placement while EVE_APP_PLACEMENT_ENABLED is off, even with the pool variables set', async () => {
    configOverride = { ...appPool, EVE_APP_PLACEMENT_ENABLED: false, EVE_COMPUTE_MODEL: 'gke' };
    const { web } = await renderPodSpecs({ web: { image: 'web:latest', ports: ['3000'] } });
    expect(web.nodeSelector).toBeUndefined();
    expect(web.tolerations).toBeUndefined();
  });

  it('pins every app Deployment to the app pool on GKE', async () => {
    configOverride = { ...appPool, EVE_COMPUTE_MODEL: 'gke' };
    const { web, worker } = await renderPodSpecs({
      web: { image: 'web:latest', ports: ['3000'] },
      worker: { image: 'worker:latest' },
    });
    for (const podSpec of [web, worker]) {
      expect(podSpec.nodeSelector).toEqual({ pool: 'apps' });
      expect(podSpec.tolerations).toEqual([appPoolToleration]);
    }
  });

  it('ignores the variables on k3s and logs why', async () => {
    configOverride = { ...appPool, EVE_COMPUTE_MODEL: 'k3s' };
    const { web } = await renderPodSpecs({ web: { image: 'web:latest', ports: ['3000'] } });
    expect(web.nodeSelector).toBeUndefined();
    expect(web.tolerations).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EVE_COMPUTE_MODEL=k3s'));
  });

  it('keeps stable-egress services on the egress pool only', async () => {
    configOverride = { ...appPool, EVE_COMPUTE_MODEL: 'eks' };
    const { api, web } = await renderPodSpecs({
      api: { image: 'api:latest', ports: ['3000'], 'x-eve': { networking: { egress: 'stable' } } },
      web: { image: 'web:latest', ports: ['8080'] },
    });
    expect(api.nodeSelector).toEqual({ 'eve.io/egress-pool': 'stable' });
    expect(api.tolerations).toEqual([
      { key: 'eve.io/egress-pool', operator: 'Equal', value: 'stable', effect: 'NoSchedule' },
    ]);
    expect(web.nodeSelector).toEqual({ pool: 'apps' });
  });

  it('applies the same placement to service job pods', async () => {
    configOverride = { ...appPool, EVE_COMPUTE_MODEL: 'gke' };
    const runJob = vi.fn().mockResolvedValue({ jobName: 'job', success: true, exitCode: 0, logs: '' });
    const jobDeployer = new DeployerService(null as any, { createNamespace: vi.fn(), runJob } as any);
    Object.assign(jobDeployer, {
      environments: {
        findByProjectAndName: vi.fn().mockResolvedValue({
          id: 'env_123', project_id: 'proj_123', namespace: baseParams.namespace, name: 'test', overrides_json: null,
        }),
      },
      projects: { findById: vi.fn().mockResolvedValue({ id: 'proj_123', org_id: 'org_456', slug: 'myproj', repo_url: null }) },
      orgs: { findById: vi.fn().mockResolvedValue({ id: 'org_456', slug: 'myorg' }) },
    });
    vi.spyOn(jobDeployer as any, 'ensureImagePullSecret').mockResolvedValue(null);
    vi.spyOn(jobDeployer as any, 'waitForJobDependencies').mockResolvedValue(undefined);

    await jobDeployer.runJobService({
      projectId: 'proj_123',
      envName: 'test',
      manifestYaml: buildManifest({ migrate: { image: 'node:22-slim', 'x-eve': { role: 'job' } } }),
      serviceName: 'migrate',
      attemptId: 'attempt_12345678',
    });

    const podSpec = runJob.mock.calls[0][1].spec.template.spec;
    expect(podSpec.nodeSelector).toEqual({ pool: 'apps' });
    expect(podSpec.tolerations).toEqual([appPoolToleration]);
  });
});
