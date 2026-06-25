import { describe, it, expect, vi, beforeEach } from 'vitest';
import yaml from 'yaml';
import { DeployerService } from '../deployer.service.js';

// Tests for the platform side of docs/plans/app-stable-egress-v2-plan.md.
//
// Strategy: drive renderManifest end-to-end with null deps (no DB / K8s),
// vary EVE_COMPUTE_MODEL via the loadConfig mock, and assert on the rendered
// pod spec — that's the contract the deployer hands to the cluster.
//
// `defaultConfig` mirrors the keys renderManifest actually reads, plus the
// stable-egress label/taint defaults so the cases that exercise the EKS path
// can resolve them without test-specific overrides.

const defaultConfig = {
  EVE_DEFAULT_DOMAIN: '',
  EVE_DEFAULT_INGRESS_CLASS: undefined,
  EVE_DEFAULT_TLS_CLUSTER_ISSUER: undefined,
  EVE_DEFAULT_TLS_SECRET: undefined,
  EVE_COMPUTE_MODEL: 'eks',
  EVE_STABLE_EGRESS_NODE_LABEL_KEY: 'eve.io/egress-pool',
  EVE_STABLE_EGRESS_NODE_LABEL_VALUE: 'stable',
  EVE_STABLE_EGRESS_TAINT_KEY: 'eve.io/egress-pool',
  EVE_STABLE_EGRESS_TAINT_VALUE: 'stable',
  EVE_STABLE_EGRESS_TAINT_EFFECT: 'NoSchedule',
};

let configOverride: Record<string, unknown> = { ...defaultConfig };

vi.mock('@eve/shared', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => ({ ...defaultConfig, ...configOverride }),
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

const baseParams = {
  namespace: 'eve-myorg-myproj-test',
  envName: 'test',
  projectSlug: 'myproj',
  projectId: 'proj_123',
  orgId: 'org_456',
  orgSlug: 'myorg',
  releaseId: 'rel_789',
};

describe('DeployerService – stable egress (hostNetwork on EKS)', () => {
  let deployer: DeployerService;

  beforeEach(() => {
    configOverride = { ...defaultConfig };
    deployer = new DeployerService(null as any, null as any);
  });

  function renderManifest(manifestYaml: string) {
    return (deployer as any).renderManifest({ manifestYaml, ...baseParams });
  }

  function parseDocuments(manifestYaml: string): any[] {
    return yaml.parseAllDocuments(manifestYaml).map((doc: any) => doc.toJSON());
  }

  // ── Schema acceptance ────────────────────────────────────────────────

  it('accepts networking.egress=stable in the manifest', async () => {
    const manifest = buildManifest({
      api: {
        image: 'myapp:latest',
        ports: ['3000'],
        'x-eve': { networking: { egress: 'stable' } },
      },
    });
    const result = await renderManifest(manifest);
    expect(result.manifestYaml).toBeDefined();
  });

  it('rejects unknown networking.egress values', async () => {
    const manifest = buildManifest({
      api: {
        image: 'myapp:latest',
        ports: ['3000'],
        'x-eve': { networking: { egress: 'tailscale' } },
      },
    });
    await expect(renderManifest(manifest)).rejects.toThrow();
  });

  // ── Default services unchanged ───────────────────────────────────────

  it('renders default services (no networking config) without injection', async () => {
    const manifest = buildManifest({
      api: { image: 'myapp:latest', ports: ['3000'] },
    });
    const result = await renderManifest(manifest);
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');
    const podSpec = deployment.spec.template.spec;

    expect(podSpec.hostNetwork).toBeUndefined();
    expect(podSpec.dnsPolicy).toBeUndefined();
    expect(podSpec.nodeSelector).toBeUndefined();
    expect(podSpec.tolerations).toBeUndefined();
    const env = podSpec.containers[0].env ?? [];
    expect(env.find((e: any) => e.name === 'EVE_NETWORK_EGRESS')).toBeUndefined();
  });

  it('renders networking.egress=nat (the default explicitly) without injection', async () => {
    const manifest = buildManifest({
      api: {
        image: 'myapp:latest',
        ports: ['3000'],
        'x-eve': { networking: { egress: 'nat' } },
      },
    });
    const result = await renderManifest(manifest);
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');
    const podSpec = deployment.spec.template.spec;

    expect(podSpec.hostNetwork).toBeUndefined();
    expect(podSpec.dnsPolicy).toBeUndefined();
    expect(podSpec.nodeSelector).toBeUndefined();
  });

  // ── EKS injection ────────────────────────────────────────────────────

  it('injects hostNetwork, dnsPolicy, nodeSelector, toleration, and EVE_NETWORK_EGRESS on EKS', async () => {
    const manifest = buildManifest({
      api: {
        image: 'myapp:latest',
        ports: ['3000'],
        'x-eve': { networking: { egress: 'stable' } },
      },
    });
    const result = await renderManifest(manifest);
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');
    const podSpec = deployment.spec.template.spec;

    expect(podSpec.hostNetwork).toBe(true);
    expect(podSpec.dnsPolicy).toBe('ClusterFirstWithHostNet');
    expect(podSpec.nodeSelector).toEqual({ 'eve.io/egress-pool': 'stable' });
    expect(podSpec.tolerations).toEqual([
      { key: 'eve.io/egress-pool', operator: 'Equal', value: 'stable', effect: 'NoSchedule' },
    ]);

    const container = podSpec.containers[0];
    const env: any[] = container.env ?? [];
    const egressVar = env.find((e) => e.name === 'EVE_NETWORK_EGRESS');
    expect(egressVar).toEqual({ name: 'EVE_NETWORK_EGRESS', value: 'stable' });
  });

  it('uses Recreate strategy on EKS opt-in (single-node egress pool needs old pod gone before new one starts)', async () => {
    const manifest = buildManifest({
      api: {
        image: 'myapp:latest',
        ports: ['3000'],
        'x-eve': { networking: { egress: 'stable' } },
      },
    });
    const result = await renderManifest(manifest);
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');

    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
  });

  it('keeps default RollingUpdate strategy when not opted in', async () => {
    const manifest = buildManifest({
      api: { image: 'myapp:latest', ports: ['3000'] },
    });
    const result = await renderManifest(manifest);
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');

    // Undefined here means "rendered manifest doesn't override strategy" —
    // K8s defaults to RollingUpdate, which is what non-egress services want.
    expect(deployment.spec.strategy).toBeUndefined();
  });

  it('renders one container with no extra volumes, no Secret, no sidecar', async () => {
    const manifest = buildManifest({
      api: {
        image: 'myapp:latest',
        ports: ['3000'],
        'x-eve': { networking: { egress: 'stable' } },
      },
    });
    const result = await renderManifest(manifest);
    const docs = parseDocuments(result.manifestYaml);
    const deployment = docs.find((d: any) => d.kind === 'Deployment');

    expect(deployment.spec.template.spec.containers).toHaveLength(1);
    expect(deployment.spec.template.spec.volumes).toBeUndefined();

    // No Secret should be emitted alongside the Deployment.
    const secrets = docs.filter((d: any) => d?.kind === 'Secret');
    expect(secrets).toHaveLength(0);
  });

  // ── Compute-model branching ──────────────────────────────────────────

  it('logs and renders no injection when EVE_COMPUTE_MODEL=k3s', async () => {
    configOverride = { ...defaultConfig, EVE_COMPUTE_MODEL: 'k3s' };
    const manifest = buildManifest({
      api: {
        image: 'myapp:latest',
        ports: ['3000'],
        'x-eve': { networking: { egress: 'stable' } },
      },
    });
    const result = await renderManifest(manifest);
    const docs = parseDocuments(result.manifestYaml);
    const podSpec = docs.find((d: any) => d.kind === 'Deployment').spec.template.spec;

    expect(podSpec.hostNetwork).toBeUndefined();
    expect(podSpec.nodeSelector).toBeUndefined();
    const env: any[] = podSpec.containers[0].env ?? [];
    expect(env.find((e) => e.name === 'EVE_NETWORK_EGRESS')).toBeUndefined();
  });

  // ── Phase 1 fail-fasts ───────────────────────────────────────────────

  it('rejects networking.egress=stable with replicas > 1', async () => {
    const manifest = buildManifest({
      api: {
        image: 'myapp:latest',
        ports: ['3000'],
        replicas: 2,
        'x-eve': { networking: { egress: 'stable' } },
      },
    });
    await expect(renderManifest(manifest)).rejects.toThrow(/Phase 1 requires replicas=1/);
  });

  it('rejects networking.egress=stable with a port in the NodePort range (30000-32767)', async () => {
    const manifest = buildManifest({
      api: {
        image: 'myapp:latest',
        ports: ['31000'],
        'x-eve': { networking: { egress: 'stable' } },
      },
    });
    await expect(renderManifest(manifest)).rejects.toThrow(/NodePort range/);
  });

  it('allows networking.egress=stable with a port outside the NodePort range', async () => {
    const manifest = buildManifest({
      api: {
        image: 'myapp:latest',
        ports: ['3000'],
        'x-eve': { networking: { egress: 'stable' } },
      },
    });
    const result = await renderManifest(manifest);
    expect(result.manifestYaml).toBeDefined();
  });

  // ── Mixed manifest ───────────────────────────────────────────────────

  it('only injects on services that opted in, leaves others untouched', async () => {
    const manifest = buildManifest({
      api: {
        image: 'myapp:latest',
        ports: ['3000'],
        'x-eve': { networking: { egress: 'stable' } },
      },
      web: {
        image: 'web:latest',
        ports: ['8080'],
      },
    });
    const result = await renderManifest(manifest);
    const docs = parseDocuments(result.manifestYaml);
    const deployments = docs.filter((d: any) => d.kind === 'Deployment');

    const apiDeploy = deployments.find(
      (d: any) => d.spec.template.spec.containers[0].name === 'api',
    );
    const webDeploy = deployments.find(
      (d: any) => d.spec.template.spec.containers[0].name === 'web',
    );

    expect(apiDeploy.spec.template.spec.hostNetwork).toBe(true);
    expect(apiDeploy.spec.template.spec.nodeSelector).toEqual({
      'eve.io/egress-pool': 'stable',
    });

    expect(webDeploy.spec.template.spec.hostNetwork).toBeUndefined();
    expect(webDeploy.spec.template.spec.nodeSelector).toBeUndefined();
    expect(webDeploy.spec.template.spec.tolerations).toBeUndefined();
  });
});
