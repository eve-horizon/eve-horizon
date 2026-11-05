import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';
import { eveRegistryRepositoryPrefix, verifyRegistryPullCredential } from '@eve/shared';
import { createAppCredentialProvisioners } from '../app-credential-provisioner/factory.js';
import { DeployerService } from '../deployer.service.js';

vi.mock('@eve/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveProjectSecrets: vi.fn().mockResolvedValue({ resolved: true, secrets: [], error: null }),
}));

/**
 * One app pod, four features: the image ref under the project's registry
 * prefix, the environment-bound pull credential that kubelet presents for it,
 * the per-env workload-identity ServiceAccount and the app-pool placement.
 * Each has its own tests; this checks that the pod the deployer renders
 * carries all of them and that they agree:
 * the pull secret is for the image's registry host, and the credential's
 * project is the one whose prefix holds the image (the only repositories the
 * token endpoint lets that credential pull).
 */
const REGISTRY = 'registry.eve.example.com';
const POOL = 'projects/123456789012/locations/global/workloadIdentityPools/acme-eve-prod.svc.id.goog';
const PROJECT_ID = 'proj_01jabcdefghjkmnpqrstvwxyz0';
const ENV_ID = 'env_01jabcdefghjkmnpqrstvwxyz0';
const NAMESPACE = 'eve-acme-media-prod';
const DIGEST = `sha256:${'a'.repeat(64)}`;
// The env id as a Kubernetes name (underscore is not allowed there).
const SERVICE_ACCOUNT = 'eve-app-env-01jabcdefghjkmnpqrstvwxyz0';

const manifestYaml = yaml.stringify({
  registry: 'eve',
  services: {
    api: {
      build: { context: '.' },
      ports: ['3000'],
      'x-eve': { object_store: { isolation: 'workload-identity', buckets: [{ name: 'uploads' }] } },
    },
  },
});

describe('DeployerService - Eve registry app pod composition', () => {
  const originalEnv = { ...process.env };
  const applyManifest = vi.fn();
  let deployer: DeployerService;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'postgres://user:pass@localhost:5432/eve_test',
      EVE_REGISTRY_HOST: REGISTRY,
      EVE_INTERNAL_API_KEY: 'internal-key',
      EVE_GKE_WORKLOAD_IDENTITY_POOL: POOL,
      EVE_APP_STORAGE_PUBLIC_ENDPOINT: 'https://storage.googleapis.com',
      EVE_APP_STORAGE_REGION: 'europe-west2',
      EVE_COMPUTE_MODEL: 'gke',
      EVE_APP_PLACEMENT_ENABLED: 'true',
      EVE_APP_NODE_SELECTOR_KEY: 'pool',
      EVE_APP_NODE_SELECTOR_VALUE: 'apps',
      EVE_APP_TAINT_KEY: 'pool',
      EVE_APP_TAINT_VALUE: 'apps',
      EVE_APP_TAINT_EFFECT: 'NoSchedule',
    };
    delete process.env.EVE_APP_BUCKET_AUTH_MODE;
    applyManifest.mockReset();
    deployer = new DeployerService(null as any, { applyManifest } as any);
    (deployer as any).logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() };
    (deployer as any).environments = { bumpRegistryPullEpoch: vi.fn().mockResolvedValue(3) };
    const bucketProvisioner = {
      isConfigured: true,
      backend: 'gcs',
      supportsBucketIamMembers: true,
      getAppBucketName: vi.fn((_o, _p, env, bucket) => `eve-app-acme-media-${env}-${bucket}`),
      ensureBucket: vi.fn(),
      setBucketPublicReadPolicy: vi.fn(),
      removeBucketPublicReadPolicy: vi.fn(),
      setBucketCors: vi.fn(),
      addBucketIamMember: vi.fn(),
      removeBucketIamMember: vi.fn(),
    };
    Object.assign((deployer as any).objectStoreProvisioner, {
      bucketProvisioner,
      storageBuckets: {
        upsert: vi.fn(async (input: unknown) => input),
        deleteMissingForEnv: vi.fn().mockResolvedValue(0),
        deleteByEnv: vi.fn().mockResolvedValue(0),
        listByEnv: vi.fn().mockResolvedValue([]),
        listByPhysicalNames: vi.fn().mockResolvedValue([]),
      },
      k8s: { createSecret: vi.fn(), deleteSecret: vi.fn() },
      appCredentialProvisioners: createAppCredentialProvisioners(bucketProvisioner as any),
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('pulls the image from the project prefix with the env pull secret, as the env service account, on the app pool', async () => {
    // Same order as deploy(): the pull secret first, then the render.
    const imagePullSecret = await (deployer as any).ensureImagePullSecret({
      namespace: NAMESPACE, projectId: PROJECT_ID, environmentId: ENV_ID, manifestYaml,
    });
    const rendered = await (deployer as any).renderManifest({
      manifestYaml, namespace: NAMESPACE, envId: ENV_ID, envName: 'prod',
      projectSlug: 'media', projectId: PROJECT_ID, orgId: 'org_123', orgSlug: 'acme',
      releaseId: 'rel_1', imageDigests: { api: DIGEST }, imagePullSecret,
    });
    const docs = yaml.parseAllDocuments(rendered.manifestYaml).map((doc) => doc.toJSON());
    const pod = docs.find((doc: any) => doc.kind === 'Deployment').spec.template.spec;
    const serviceAccount = docs.find((doc: any) => doc.kind === 'ServiceAccount');

    // The image lives under the project's prefix on the Eve registry.
    const image: string = pod.containers[0].image;
    expect(image).toBe(`${REGISTRY}/${PROJECT_ID}/api@${DIGEST}`);
    const repository = image.slice(REGISTRY.length + 1).split('@')[0];
    expect(repository.startsWith(eveRegistryRepositoryPrefix(PROJECT_ID))).toBe(true);

    // The pod pulls with the env's secret, for that registry host, and
    // its credential names this project and environment.
    expect(pod.imagePullSecrets).toEqual([{ name: imagePullSecret }]);
    const [, secretYaml] = applyManifest.mock.calls[0] as [string, string];
    const secret = yaml.parse(secretYaml);
    expect(secret.metadata.name).toBe(imagePullSecret);
    const auths = JSON.parse(Buffer.from(secret.data['.dockerconfigjson'], 'base64').toString('utf8')).auths;
    expect(Object.keys(auths)).toEqual([image.split('/')[0]]);
    expect(verifyRegistryPullCredential(auths[REGISTRY].password, 'internal-key')).toMatchObject({
      projectId: PROJECT_ID, environmentId: ENV_ID, namespace: NAMESPACE,
    });

    // The same pod runs as the env's own workload-identity account.
    expect(pod.serviceAccountName).toBe(SERVICE_ACCOUNT);
    expect(serviceAccount.metadata).toEqual({ name: SERVICE_ACCOUNT, namespace: NAMESPACE });

    // And it is placed on the app pool.
    expect(pod.nodeSelector).toEqual({ pool: 'apps' });
    expect(pod.tolerations).toEqual([{ key: 'pool', operator: 'Equal', value: 'apps', effect: 'NoSchedule' }]);
  });
});
