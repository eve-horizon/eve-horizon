import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';
import { resolveProjectSecrets } from '@eve/shared';
import { DeployerService } from '../deployer.service.js';

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

const baseParams = {
  namespace: 'eve-myorg-myproj-test',
  envId: 'env_123',
  envName: 'test',
  projectSlug: 'myproj',
  projectId: 'proj_123',
  orgId: 'org_456',
  orgSlug: 'myorg',
  releaseId: 'rel_789',
};

const managedTrustContext = {
  enabled: true,
  checksum: 'trust-checksum',
  envEntries: [
    { name: 'NODE_EXTRA_CA_CERTS', value: '/etc/eve/trust/ca-bundle.pem' },
    { name: 'PGSSLROOTCERT', value: '/etc/eve/trust/ca-bundle.pem' },
  ],
  volumes: [{ name: 'eve-db-trust', configMap: { name: 'eve-db-trust' } }],
  volumeMounts: [{ name: 'eve-db-trust', mountPath: '/etc/eve/trust', readOnly: true }],
};

function buildManifest(services: Record<string, unknown>): string {
  return yaml.stringify({ services });
}

function parseDocuments(manifestYaml: string): any[] {
  return yaml.parseAllDocuments(manifestYaml).map((doc: any) => doc.toJSON());
}

describe('DeployerService managed DB trust', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.mocked(resolveProjectSecrets).mockResolvedValue({
      resolved: true,
      secrets: [],
      error: undefined,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it('does not create a trust ConfigMap when all managed DB providers are local', async () => {
    const createConfigMap = vi.fn();
    const deployer = new DeployerService(null as any, { createConfigMap } as any);

    const trust = await (deployer as any).ensureManagedDbTrustStore('eve-test', [
      { provider: 'local', region: 'local' },
    ]);

    expect(trust).toEqual({
      enabled: false,
      envEntries: [],
      volumes: [],
      volumeMounts: [],
    });
    expect(createConfigMap).not.toHaveBeenCalled();
  });

  it('creates a trust ConfigMap and env injection for cloud managed DB providers', async () => {
    process.env.EVE_MANAGED_DB_AWS_RDS_CA_BUNDLE_PEM = '-----BEGIN CERTIFICATE-----\nAWS\n-----END CERTIFICATE-----';
    const createConfigMap = vi.fn();
    const deployer = new DeployerService(null as any, { createConfigMap } as any);

    const trust = await (deployer as any).ensureManagedDbTrustStore('eve-test', [
      { provider: 'aws-rds', region: 'eu-west-1' },
    ]);

    expect(createConfigMap).toHaveBeenCalledWith('eve-test', 'eve-db-trust', {
      'ca-bundle.pem': expect.stringContaining('BEGIN CERTIFICATE'),
    });
    expect(trust.enabled).toBe(true);
    expect(trust.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(trust.envEntries).toEqual([
      { name: 'NODE_EXTRA_CA_CERTS', value: '/etc/eve/trust/ca-bundle.pem' },
      { name: 'PGSSLROOTCERT', value: '/etc/eve/trust/ca-bundle.pem' },
    ]);
  });

  it('injects trust volumes, mounts, and env vars into rendered deployments', async () => {
    const deployer = new DeployerService(null as any, null as any);
    vi.spyOn(deployer as any, 'resolveManagedDbTenants').mockResolvedValue({
      managedValues: new Map(),
      trustInputs: [{ provider: 'aws-rds', region: 'eu-west-1' }],
    });
    vi.spyOn(deployer as any, 'ensureManagedDbTrustStore').mockResolvedValue(managedTrustContext);

    const result = await (deployer as any).renderManifest({
      manifestYaml: buildManifest({
        web: {
          image: 'nginx:1.27',
          ports: ['3000'],
        },
      }),
      ...baseParams,
    });

    const deployment = parseDocuments(result.manifestYaml).find((doc: any) => doc.kind === 'Deployment');
    const container = deployment.spec.template.spec.containers[0];

    expect(deployment.spec.template.metadata.annotations['eve.managed_db_trust_hash']).toBe('trust-checksum');
    expect(deployment.spec.template.spec.volumes).toEqual(
      expect.arrayContaining([{ name: 'eve-db-trust', configMap: { name: 'eve-db-trust' } }]),
    );
    expect(container.volumeMounts).toEqual(
      expect.arrayContaining([{ name: 'eve-db-trust', mountPath: '/etc/eve/trust', readOnly: true }]),
    );
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'NODE_EXTRA_CA_CERTS', value: '/etc/eve/trust/ca-bundle.pem' },
      { name: 'PGSSLROOTCERT', value: '/etc/eve/trust/ca-bundle.pem' },
    ]));
  });

  it('injects the same trust configuration into job pods', async () => {
    const runJob = vi.fn().mockResolvedValue({
      jobName: 'test-job',
      success: true,
      exitCode: 0,
      logs: 'ok',
    });
    const deployer = new DeployerService(null as any, {
      createNamespace: vi.fn(),
      runJob,
    } as any);

    Object.assign(deployer, {
      environments: {
        findByProjectAndName: vi.fn().mockResolvedValue({
          id: 'env_123',
          project_id: 'proj_123',
          namespace: 'eve-myorg-myproj-test',
          name: 'test',
          overrides_json: null,
        }),
      },
      projects: {
        findById: vi.fn().mockResolvedValue({
          id: 'proj_123',
          org_id: 'org_456',
          slug: 'myproj',
          repo_url: null,
        }),
      },
      orgs: {
        findById: vi.fn().mockResolvedValue({
          id: 'org_456',
          slug: 'myorg',
        }),
      },
    });

    vi.spyOn(deployer as any, 'ensureImagePullSecret').mockResolvedValue(null);
    vi.spyOn(deployer as any, 'waitForJobDependencies').mockResolvedValue(undefined);
    vi.spyOn(deployer as any, 'resolveManagedDbTenants').mockResolvedValue({
      managedValues: new Map(),
      trustInputs: [{ provider: 'aws-rds', region: 'eu-west-1' }],
    });
    vi.spyOn(deployer as any, 'ensureManagedDbTrustStore').mockResolvedValue(managedTrustContext);

    await deployer.runJobService({
      projectId: 'proj_123',
      envName: 'test',
      manifestYaml: buildManifest({
        migrate: {
          image: 'node:22-slim',
          'x-eve': { role: 'job' },
        },
      }),
      serviceName: 'migrate',
      attemptId: 'attempt_12345678',
    });

    const job = runJob.mock.calls[0][1];
    const container = job.spec.template.spec.containers[0];

    expect(job.spec.template.metadata.annotations['eve.managed_db_trust_hash']).toBe('trust-checksum');
    expect(job.spec.template.spec.volumes).toEqual(
      expect.arrayContaining([{ name: 'eve-db-trust', configMap: { name: 'eve-db-trust' } }]),
    );
    expect(container.volumeMounts).toEqual(
      expect.arrayContaining([{ name: 'eve-db-trust', mountPath: '/etc/eve/trust', readOnly: true }]),
    );
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'NODE_EXTRA_CA_CERTS', value: '/etc/eve/trust/ca-bundle.pem' },
      { name: 'PGSSLROOTCERT', value: '/etc/eve/trust/ca-bundle.pem' },
    ]));
  });
});
