import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '@eve/shared';
import { createAppCredentialProvisioners } from '../app-credential-provisioner/factory.js';
import {
  GCP_APP_BUCKET_ROLE,
  GcpWorkloadIdentityAppCredentialProvisioner,
} from '../app-credential-provisioner/gcp-workload-identity.js';
import { BucketProvisioner } from '../bucket-provisioner.js';
import { DeployerService } from '../deployer.service.js';

const POOL = 'projects/123456789012/locations/global/workloadIdentityPools/acme-eve-prod.svc.id.goog';
const NAMESPACE = 'eve-acme-media-prod';
const SERVICE_ACCOUNT = 'eve-app-env-01jabcdefghjkmnpqrstvwxyz0';
const MEMBER = `principal://iam.googleapis.com/${POOL}/subject/ns/${NAMESPACE}/sa/${SERVICE_ACCOUNT}`;

const scope = {
  orgId: 'org_123',
  projectId: 'proj_123',
  envId: 'env_01jabcdefghjkmnpqrstvwxyz0',
  envName: 'prod',
  orgSlug: 'acme',
  projectSlug: 'media',
  namespace: NAMESPACE,
};

function bucketIam(supports = true) {
  return {
    supportsBucketIamMembers: supports,
    addBucketIamMember: vi.fn().mockResolvedValue(undefined),
    removeBucketIamMember: vi.fn().mockResolvedValue(undefined),
  };
}

describe('GcpWorkloadIdentityAppCredentialProvisioner', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, EVE_GKE_WORKLOAD_IDENTITY_POOL: POOL };
    delete process.env.EVE_APP_BUCKET_AUTH_MODE;
    delete process.env.EVE_APP_STORAGE_PUBLIC_ENDPOINT;
    delete process.env.EVE_APP_STORAGE_ENDPOINT;
    delete process.env.EVE_STORAGE_PUBLIC_ENDPOINT;
    delete process.env.EVE_STORAGE_ENDPOINT;
    delete process.env.EVE_APP_STORAGE_REGION;
    delete process.env.EVE_STORAGE_REGION;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('is available with a valid pool and a GCS-native worker client', () => {
    expect(new GcpWorkloadIdentityAppCredentialProvisioner(bucketIam()).availability()).toEqual({ available: true });
  });

  it.each([
    [{ EVE_GKE_WORKLOAD_IDENTITY_POOL: '' }, true, 'missing EVE_GKE_WORKLOAD_IDENTITY_POOL'],
    [{ EVE_GKE_WORKLOAD_IDENTITY_POOL: 'acme-eve-prod.svc.id.goog' }, true, 'invalid EVE_GKE_WORKLOAD_IDENTITY_POOL'],
    [{ EVE_APP_BUCKET_AUTH_MODE: 'shared' }, true, 'EVE_APP_BUCKET_AUTH_MODE=shared'],
    [{}, false, 'cannot manage bucket IAM'],
  ])('reports why it is unavailable (%o)', (env, supports, reason) => {
    Object.assign(process.env, env);
    const availability = new GcpWorkloadIdentityAppCredentialProvisioner(bucketIam(supports)).availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain(reason);
  });

  it('is picked by auto only when the operator opts the cluster in', () => {
    const provisioner = new GcpWorkloadIdentityAppCredentialProvisioner(bucketIam());
    expect(provisioner.autoSelectable).toBe(false);
    process.env.EVE_APP_BUCKET_AUTH_MODE = 'workload-identity';
    expect(provisioner.autoSelectable).toBe(true);
    expect(provisioner.availability()).toEqual({ available: true });
  });

  it('binds the env to its namespace service account with no keys', async () => {
    process.env.EVE_STORAGE_REGION = 'europe-west2';
    const provisioner = new GcpWorkloadIdentityAppCredentialProvisioner(bucketIam());

    const binding = await provisioner.ensureForEnv(scope, ['eve-app-acme-media-prod-b', 'eve-app-acme-media-prod-a']);

    expect(binding).toEqual({
      mode: 'gcp-workload-identity',
      envVars: [
        { name: 'STORAGE_ENDPOINT', value: 'https://storage.googleapis.com' },
        { name: 'STORAGE_AUTH_MODE', value: 'gcp-workload-identity' },
        { name: 'GOOGLE_CLOUD_PROJECT', value: 'acme-eve-prod' },
        { name: 'STORAGE_REGION', value: 'europe-west2' },
      ],
      credentialSecret: null,
      bindingHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      iamRoleArn: null,
      iamRoleName: null,
      serviceAccount: { name: SERVICE_ACCOUNT, namespace: NAMESPACE, annotations: {} },
      bucketMember: MEMBER,
    });
    expect(provisioner.memberFor(scope)).toBe(MEMBER);
  });

  it('gives a re-created env with the same names a different principal', () => {
    const provisioner = new GcpWorkloadIdentityAppCredentialProvisioner(bucketIam());
    const recreated = provisioner.memberFor({ namespace: NAMESPACE, envId: 'env_01jzzzzzzzzzzzzzzzzzzzzzzz' });
    expect(recreated).not.toBe(MEMBER);
    expect(recreated).toContain(`/subject/ns/${NAMESPACE}/sa/eve-app-env-01jzzzzzzzzzzzzzzzzzzzzzzz`);
  });

  it('changes the binding hash when the bucket set changes', async () => {
    const provisioner = new GcpWorkloadIdentityAppCredentialProvisioner(bucketIam());
    const one = await provisioner.ensureForEnv(scope, ['eve-app-acme-media-prod-a']);
    const same = await provisioner.ensureForEnv(scope, ['eve-app-acme-media-prod-a']);
    const two = await provisioner.ensureForEnv(scope, ['eve-app-acme-media-prod-a', 'eve-app-acme-media-prod-b']);
    expect(same.bindingHash).toBe(one.bindingHash);
    expect(two.bindingHash).not.toBe(one.bindingHash);
  });

  it('grants the env principal on its buckets and leaves revocation to recorded rows', async () => {
    const iam = bucketIam();
    const provisioner = new GcpWorkloadIdentityAppCredentialProvisioner(iam);

    await provisioner.grantBucketAccess(scope, ['eve-app-acme-media-prod-b', 'eve-app-acme-media-prod-a']);
    await provisioner.removeForEnv(scope);

    expect(GCP_APP_BUCKET_ROLE).toBe('roles/storage.objectUser');
    expect(iam.addBucketIamMember.mock.calls).toEqual([
      ['eve-app-acme-media-prod-a', 'roles/storage.objectUser', MEMBER],
      ['eve-app-acme-media-prod-b', 'roles/storage.objectUser', MEMBER],
    ]);
    expect(iam.removeBucketIamMember).not.toHaveBeenCalled();
  });
});

describe('DeployerService workload-identity object-store binding', () => {
  const originalEnv = { ...process.env };

  function setup(options: { previous?: unknown[]; backend?: string } = {}) {
    const deployer = new DeployerService(null as any, null as any);
    const calls: string[] = [];
    const record = (name: string) => vi.fn(async (...args: any[]) => {
      calls.push(`${name}:${args.slice(0, 1).join(',')}`);
    });
    const bucketProvisioner = {
      isConfigured: true,
      backend: options.backend ?? 'gcs',
      supportsBucketIamMembers: true,
      getAppBucketName: vi.fn((_o, _p, env, bucket) => `eve-app-acme-media-${env}-${bucket}`),
      ensureBucket: record('ensureBucket'),
      setBucketPublicReadPolicy: record('setBucketPublicReadPolicy'),
      removeBucketPublicReadPolicy: record('removeBucketPublicReadPolicy'),
      setBucketCors: record('setBucketCors'),
      addBucketIamMember: record('addBucketIamMember'),
      removeBucketIamMember: record('removeBucketIamMember'),
    };
    const storageBuckets = {
      upsert: vi.fn(async (input: unknown) => input),
      deleteMissingForEnv: vi.fn().mockResolvedValue(0),
      deleteByEnv: vi.fn().mockResolvedValue(0),
      listByEnv: vi.fn().mockResolvedValue(options.previous ?? []),
      listByPhysicalNames: vi.fn().mockResolvedValue([]),
    };
    const k8s = { createSecret: vi.fn(), deleteSecret: vi.fn() };
    Object.assign((deployer as any).objectStoreProvisioner, {
      bucketProvisioner,
      storageBuckets,
      k8s,
      appCredentialProvisioners: createAppCredentialProvisioners(bucketProvisioner as any),
    });
    const prepare = (services: Record<string, Service>) =>
      (deployer as any).objectStoreProvisioner.prepareObjectStorePlan({ services, envWorkers: [], scope });
    return { deployer, calls, storageBuckets, k8s, prepare };
  }

  const api = (isolation?: string): Service => ({
    image: 'ghcr.io/example/api:latest',
    'x-eve': { object_store: { ...(isolation ? { isolation } : {}), buckets: [{ name: 'uploads' }] } },
  } as Service);

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      EVE_GKE_WORKLOAD_IDENTITY_POOL: POOL,
      EVE_APP_STORAGE_PUBLIC_ENDPOINT: 'https://storage.googleapis.com',
      EVE_APP_STORAGE_REGION: 'europe-west2',
      EVE_APP_STORAGE_ACCESS_KEY_ID: 'shared-access-key',
      EVE_APP_STORAGE_SECRET_ACCESS_KEY: 'shared-secret-key',
    };
    delete process.env.EVE_APP_BUCKET_AUTH_MODE;
    delete process.env.EVE_OIDC_PROVIDER_ARN;
    delete process.env.EVE_OIDC_PROVIDER_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses workload identity when the manifest asks for it and grants after the bucket exists', async () => {
    const { deployer, calls, storageBuckets, k8s, prepare } = setup();
    const services = { api: api('workload-identity'), web: { image: 'ghcr.io/example/web:latest' } as Service };

    const plan = await prepare(services);

    expect(plan.binding.mode).toBe('gcp-workload-identity');
    expect(calls).toEqual([
      'ensureBucket:eve-app-acme-media-prod-uploads',
      'addBucketIamMember:eve-app-acme-media-prod-uploads',
    ]);
    expect((deployer as any).objectStoreProvisioner.bucketProvisioner.addBucketIamMember)
      .toHaveBeenCalledWith('eve-app-acme-media-prod-uploads', 'roles/storage.objectUser', MEMBER);
    // Keyless: no static credentials Secret is left in the namespace.
    expect(k8s.createSecret).not.toHaveBeenCalled();
    expect(k8s.deleteSecret).toHaveBeenCalledWith(NAMESPACE, 'eve-app-storage-credentials');
    expect(storageBuckets.upsert).toHaveBeenCalledWith(expect.objectContaining({
      isolation_mode: 'gcp-workload-identity',
      service_account_name: SERVICE_ACCOUNT,
      service_account_namespace: NAMESPACE,
      iam_member: MEMBER,
    }));

    const provisioner = (deployer as any).objectStoreProvisioner;
    expect(provisioner.buildObjectStoreServiceAccount(plan)).toEqual({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: SERVICE_ACCOUNT, namespace: NAMESPACE },
    });
    expect(provisioner.resolveObjectStoreServiceAccountName(plan, 'api')).toBe(SERVICE_ACCOUNT);
    expect(provisioner.resolveObjectStoreServiceAccountName(plan, 'web')).toBeUndefined();
    const envVars = await provisioner.resolveObjectStoreBuckets(services.api, { envName: 'prod', componentName: 'api' }, plan);
    expect(envVars).toEqual([
      { name: 'STORAGE_ENDPOINT', value: 'https://storage.googleapis.com' },
      { name: 'STORAGE_AUTH_MODE', value: 'gcp-workload-identity' },
      { name: 'GOOGLE_CLOUD_PROJECT', value: 'acme-eve-prod' },
      { name: 'STORAGE_REGION', value: 'europe-west2' },
      { name: 'STORAGE_BUCKET_UPLOADS', value: 'eve-app-acme-media-prod-uploads' },
    ]);
    expect((deployer as any).buildPodAnnotations({ objectStorePlan: plan, serviceName: 'api' }))
      .toEqual({ 'eve.app_bucket_binding_hash': plan.binding.bindingHash });
  });

  const row = (name: string, extra: Record<string, unknown> = {}) => ({
    project_id: 'proj_123',
    env_name: 'prod',
    service_name: 'api',
    name,
    physical_name: `eve-app-acme-media-prod-${name}`,
    visibility: 'private',
    iam_member: MEMBER,
    ...extra,
  });

  it('revokes the recorded member from buckets the env no longer declares', async () => {
    const { calls, prepare } = setup({ previous: [row('old'), row('uploads')] });

    await prepare({ api: api('workload-identity') });

    expect(calls).toEqual([
      'removeBucketIamMember:eve-app-acme-media-prod-old',
      'ensureBucket:eve-app-acme-media-prod-uploads',
      'addBucketIamMember:eve-app-acme-media-prod-uploads',
    ]);
  });

  it('revokes recorded grants when the env switches to the shared key', async () => {
    const { deployer, calls, storageBuckets, prepare } = setup({ previous: [row('uploads')] });

    const plan = await prepare({ api: api('shared') });

    expect(plan.binding.mode).toBe('shared');
    expect(calls[0]).toBe('removeBucketIamMember:eve-app-acme-media-prod-uploads');
    expect((deployer as any).objectStoreProvisioner.bucketProvisioner.removeBucketIamMember)
      .toHaveBeenCalledWith('eve-app-acme-media-prod-uploads', 'roles/storage.objectUser', MEMBER);
    expect(storageBuckets.upsert).toHaveBeenCalledWith(expect.objectContaining({ isolation_mode: 'shared', iam_member: null }));
  });

  it('replaces a grant recorded for another member', async () => {
    const stale = MEMBER.replace(SERVICE_ACCOUNT, 'eve-app');
    const { calls, prepare } = setup({ previous: [row('uploads', { iam_member: stale })] });

    await prepare({ api: api('workload-identity') });

    expect(calls).toEqual([
      'removeBucketIamMember:eve-app-acme-media-prod-uploads',
      'ensureBucket:eve-app-acme-media-prod-uploads',
      'addBucketIamMember:eve-app-acme-media-prod-uploads',
    ]);
  });

  it('keeps the rows and fails the deploy when a revocation fails, so the next deploy retries', async () => {
    const { deployer, calls, storageBuckets, prepare } = setup({ previous: [row('old')] });
    (deployer as any).objectStoreProvisioner.bucketProvisioner.removeBucketIamMember =
      vi.fn().mockRejectedValue(new Error('HTTP 503'));

    await expect(prepare({ api: api('workload-identity') })).rejects.toThrow(
      'Failed to revoke object_store bucket access for env "prod": eve-app-acme-media-prod-old: HTTP 503',
    );
    expect(calls).toEqual([]);
    expect(storageBuckets.upsert).not.toHaveBeenCalled();
    expect(storageBuckets.deleteMissingForEnv).not.toHaveBeenCalled();
  });

  it('keeps auto on the shared key unless the operator opts the cluster in', async () => {
    const { prepare } = setup();
    expect((await prepare({ api: api() })).binding.mode).toBe('shared');

    process.env.EVE_APP_BUCKET_AUTH_MODE = 'workload-identity';
    const optedIn = setup();
    expect((await optedIn.prepare({ api: api() })).binding.mode).toBe('gcp-workload-identity');
  });

  it('fails fast when workload identity is requested but not configured', async () => {
    delete process.env.EVE_GKE_WORKLOAD_IDENTITY_POOL;
    const { calls, prepare } = setup();

    await expect(prepare({ api: api('workload-identity') })).rejects.toThrow(
      `Service "api" declares object_store.isolation='workload-identity' but isolation mode 'workload-identity' ` +
      'is not available on this cluster: missing EVE_GKE_WORKLOAD_IDENTITY_POOL',
    );
    expect(calls).toEqual([]);
  });

  it('revokes every recorded grant on env deletion and fails it when one cannot be revoked', async () => {
    const { deployer, calls } = setup({ previous: [row('uploads'), row('media'), row('plain', { iam_member: null })] });

    await (deployer as any).objectStoreProvisioner.revokeEnvGrants(scope);

    expect(calls).toEqual([
      'removeBucketIamMember:eve-app-acme-media-prod-uploads',
      'removeBucketIamMember:eve-app-acme-media-prod-media',
    ]);

    (deployer as any).objectStoreProvisioner.bucketProvisioner.removeBucketIamMember =
      vi.fn().mockRejectedValue(new Error('HTTP 403'));
    await expect((deployer as any).objectStoreProvisioner.revokeEnvGrants(scope)).rejects.toThrow('HTTP 403');
  });

  it('revokes before the rows are dropped when an env removes all its buckets', async () => {
    const { deployer, calls, storageBuckets } = setup({ previous: [row('uploads')] });
    // Only the real-DB path prunes rows for an env with no bucket declarations.
    Object.assign((deployer as any).objectStoreProvisioner, { db: () => undefined });
    storageBuckets.deleteByEnv.mockImplementation(async () => {
      calls.push('deleteByEnv');
      return 1;
    });

    await (deployer as any).objectStoreProvisioner.prepareObjectStorePlan({
      services: { web: { image: 'ghcr.io/example/web:latest' } },
      envWorkers: [],
      scope,
    });

    expect(calls).toEqual(['removeBucketIamMember:eve-app-acme-media-prod-uploads', 'deleteByEnv']);
  });
});

describe('BucketProvisioner public bucket refusals', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function provisionerFailingWith(message: string, code?: number) {
    const provisioner = new BucketProvisioner();
    (provisioner as any).client = {
      setBucketPublicReadPolicy: vi.fn().mockRejectedValue(Object.assign(new Error(message), { code })),
    };
    return provisioner;
  }

  it('names the org policy when Google refuses the allUsers grant', async () => {
    const provisioner = provisionerFailingWith(
      'One or more users named in the policy do not belong to a permitted customer, perhaps due to an organization policy.',
      412,
    );

    await expect(provisioner.setBucketPublicReadPolicy('eve-app-acme-media-prod-assets')).rejects.toThrow(
      /declared public, but the Google Cloud organisation policy refuses the allUsers grant .*iam\.allowedPolicyMemberDomains/,
    );
  });

  it('names S3 Block Public Access when AWS refuses the public policy', async () => {
    const provisioner = provisionerFailingWith(
      'User is not authorized to perform: s3:PutBucketPolicy because public policies are blocked by the BlockPublicPolicy block public access setting.',
    );

    await expect(provisioner.setBucketPublicReadPolicy('assets')).rejects.toThrow(/S3 Block Public Access refuses/);
  });

  it('passes other failures through unchanged', async () => {
    const provisioner = provisionerFailingWith('Forbidden', 403);

    await expect(provisioner.setBucketPublicReadPolicy('assets')).rejects.toThrow(/^Forbidden$/);
  });

  it('reports per-bucket IAM support from the storage client', () => {
    process.env = { ...originalEnv, EVE_STORAGE_BACKEND: 'gcs' };
    delete process.env.EVE_STORAGE_ACCESS_KEY_ID;
    expect(new BucketProvisioner().supportsBucketIamMembers).toBe(true);

    process.env = { ...originalEnv, EVE_STORAGE_BACKEND: 'gcs', EVE_STORAGE_ACCESS_KEY_ID: 'hmac', EVE_STORAGE_SECRET_ACCESS_KEY: 's' };
    expect(new BucketProvisioner().supportsBucketIamMembers).toBe(false);
  });
});
