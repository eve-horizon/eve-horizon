import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '@eve/shared';
import { createAppCredentialProvisioners } from '../app-credential-provisioner/factory.js';
import { BucketProvisioner } from '../bucket-provisioner.js';
import { DeployerService } from '../deployer.service.js';

describe('DeployerService object-store buckets', () => {
  const originalEnv = { ...process.env };

  const secretRef = (key: string) => ({
    name: key,
    valueFrom: { secretKeyRef: { name: 'eve-app-storage-credentials', key } },
  });

  function configureObjectStoreMocks(
    deployer: DeployerService,
    bucketProvisioner: Record<string, unknown>,
    storageBuckets: Record<string, unknown> = {},
    k8s: Record<string, unknown> = {},
  ) {
    Object.assign((deployer as any).objectStoreProvisioner, {
      bucketProvisioner,
      appCredentialProvisioners: createAppCredentialProvisioners(bucketProvisioner as any),
      k8s: {
        createSecret: vi.fn().mockResolvedValue(undefined),
        deleteSecret: vi.fn().mockResolvedValue(undefined),
        ...k8s,
      },
      storageBuckets: {
        upsert: vi.fn().mockResolvedValue(undefined),
        deleteMissingForEnv: vi.fn().mockResolvedValue(0),
        deleteByEnv: vi.fn().mockResolvedValue(0),
        listByEnv: vi.fn().mockResolvedValue([]),
        listByPhysicalNames: vi.fn().mockResolvedValue([]),
        ...storageBuckets,
      },
    });
  }

  async function resolveObjectStoreForService(
    deployer: DeployerService,
    service: Service,
    context: {
      orgId: string;
      projectId: string;
      orgSlug: string;
      projectSlug: string;
      envName: string;
      componentName: string;
    },
  ) {
    const plan = await (deployer as any).objectStoreProvisioner.prepareObjectStorePlan({
      services: { [context.componentName]: service },
      envWorkers: [],
      scope: {
        orgId: context.orgId,
        projectId: context.projectId,
        envName: context.envName,
        orgSlug: context.orgSlug,
        projectSlug: context.projectSlug,
        namespace: `eve-${context.orgSlug}-${context.projectSlug}-${context.envName}`,
      },
    });
    return (deployer as any).objectStoreProvisioner.resolveObjectStoreBuckets(
      service,
      { envName: context.envName, componentName: context.componentName },
      plan,
    );
  }

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      EVE_STORAGE_PUBLIC_ENDPOINT: 'http://storage.eve.lvh.me',
      EVE_STORAGE_REGION: 'us-east-1',
      EVE_STORAGE_ACCESS_KEY_ID: 'minio',
      EVE_STORAGE_SECRET_ACCESS_KEY: 'minio-secret',
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('provisions declared buckets, applies S3-compatible CORS, tracks them, and injects env vars', async () => {
    const deployer = new DeployerService(null as any, null as any);
    const ensureBucket = vi.fn().mockResolvedValue(undefined);
    const setBucketPublicReadPolicy = vi.fn().mockResolvedValue(undefined);
    const setBucketCors = vi.fn().mockResolvedValue(undefined);
    const upsert = vi.fn().mockResolvedValue(undefined);
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 's3',
      getAppBucketName: vi.fn().mockReturnValue('eve-org-acme-media-dev-uploads'),
      ensureBucket,
      setBucketPublicReadPolicy,
      setBucketCors,
    }, { upsert });

    const envVars = await resolveObjectStoreForService(
      deployer,
      {
        image: 'ghcr.io/example/api:latest',
        'x-eve': {
          object_store: {
            buckets: [
              {
                name: 'uploads',
                visibility: 'public',
                cors: {
                  origins: ['https://app.example.com'],
                  methods: ['PUT', 'HEAD', 'GET'],
                  max_age_seconds: 3600,
                },
              },
            ],
          },
        },
      },
      {
        orgId: 'org_123',
        projectId: 'proj_123',
        orgSlug: 'acme',
        projectSlug: 'media',
        envName: 'dev',
        componentName: 'api',
      },
    );

    expect(ensureBucket).toHaveBeenCalledWith('eve-org-acme-media-dev-uploads');
    expect(setBucketPublicReadPolicy).toHaveBeenCalledWith('eve-org-acme-media-dev-uploads');
    expect(setBucketCors).toHaveBeenCalledWith('eve-org-acme-media-dev-uploads', [
      {
        origins: ['https://app.example.com'],
        methods: ['PUT', 'HEAD', 'GET'],
        maxAgeSeconds: 3600,
      },
    ]);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      org_id: 'org_123',
      project_id: 'proj_123',
      env_name: 'dev',
      service_name: 'api',
      name: 'uploads',
      physical_name: 'eve-org-acme-media-dev-uploads',
      visibility: 'public',
      cors_json: {
        origins: ['https://app.example.com'],
        methods: ['PUT', 'HEAD', 'GET'],
        max_age_seconds: 3600,
      },
    }));
    expect(envVars).toEqual(expect.arrayContaining([
      { name: 'STORAGE_ENDPOINT', value: 'http://storage.eve.lvh.me' },
      { name: 'STORAGE_REGION', value: 'us-east-1' },
      secretRef('STORAGE_ACCESS_KEY_ID'),
      secretRef('STORAGE_SECRET_ACCESS_KEY'),
      { name: 'STORAGE_BUCKET_UPLOADS', value: 'eve-org-acme-media-dev-uploads' },
    ]));
    expect(envVars).not.toContainEqual({ name: 'STORAGE_FORCE_PATH_STYLE', value: 'true' });
  });

  it('uses MinIO server-wide CORS instead of unsupported per-bucket CORS for wildcard origins', async () => {
    const deployer = new DeployerService(null as any, null as any);
    const ensureBucket = vi.fn().mockResolvedValue(undefined);
    const setBucketCors = vi.fn().mockResolvedValue(undefined);
    const upsert = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const log = vi.fn();
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 'minio',
      getAppBucketName: vi.fn().mockReturnValue('eve-org-acme-media-dev-uploads'),
      ensureBucket,
      setBucketPublicReadPolicy: vi.fn().mockResolvedValue(undefined),
      setBucketCors,
    }, { upsert });
    Object.assign((deployer as any).objectStoreProvisioner, {
      logger: {
        log,
        warn,
      },
    });

    const envVars = await resolveObjectStoreForService(
      deployer,
      {
        image: 'ghcr.io/example/api:latest',
        'x-eve': {
          object_store: {
            buckets: [
              {
                name: 'uploads',
                cors: {
                  origins: ['*'],
                  methods: ['PUT', 'HEAD', 'GET'],
                },
              },
            ],
          },
        },
      },
      {
        orgId: 'org_123',
        projectId: 'proj_123',
        orgSlug: 'acme',
        projectSlug: 'media',
        envName: 'dev',
        componentName: 'api',
      },
    );

    expect(setBucketCors).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('uses MinIO server-wide CORS configuration'));
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'uploads',
      physical_name: 'eve-org-acme-media-dev-uploads',
      cors_json: {
        origins: ['*'],
        methods: ['PUT', 'HEAD', 'GET'],
      },
    }));
    expect(envVars).toEqual(expect.arrayContaining([
      { name: 'STORAGE_BUCKET_UPLOADS', value: 'eve-org-acme-media-dev-uploads' },
    ]));
  });

  it('warns when local MinIO cannot enforce restrictive per-bucket CORS origins', async () => {
    const deployer = new DeployerService(null as any, null as any);
    const setBucketCors = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 'minio',
      getAppBucketName: vi.fn().mockReturnValue('eve-org-acme-media-dev-uploads'),
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      setBucketPublicReadPolicy: vi.fn().mockResolvedValue(undefined),
      setBucketCors,
    });
    Object.assign((deployer as any).objectStoreProvisioner, {
      logger: {
        log: vi.fn(),
        warn,
      },
    });

    await resolveObjectStoreForService(
      deployer,
      {
        image: 'ghcr.io/example/api:latest',
        'x-eve': {
          object_store: {
            buckets: [
              {
                name: 'uploads',
                cors: {
                  origins: ['https://app.example.com'],
                  methods: ['PUT', 'HEAD', 'GET'],
                },
              },
            ],
          },
        },
      },
      {
        orgId: 'org_123',
        projectId: 'proj_123',
        orgSlug: 'acme',
        projectSlug: 'media',
        envName: 'dev',
        componentName: 'api',
      },
    );

    expect(setBucketCors).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('only supports server-wide CORS in local k3d'));
  });

  it('fails fast when bucket provisioning is not configured', async () => {
    const deployer = new DeployerService(null as any, null as any);
    configureObjectStoreMocks(deployer, {
      isConfigured: false,
      backend: '',
      getAppBucketName: vi.fn().mockReturnValue('eve-org-acme-media-dev-uploads'),
    });

    await expect(resolveObjectStoreForService(
      deployer,
      {
        image: 'ghcr.io/example/api:latest',
        'x-eve': {
          object_store: {
            buckets: [{ name: 'uploads' }],
          },
        },
      },
      {
        orgId: 'org_123',
        projectId: 'proj_123',
        orgSlug: 'acme',
        projectSlug: 'media',
        envName: 'dev',
        componentName: 'api',
      },
    )).rejects.toThrow('Eve object storage is not configured');
  });

  it('fails the deploy and records nothing when the bucket name belongs to another project', async () => {
    const deployer = new DeployerService(null as any, null as any);
    const upsert = vi.fn().mockResolvedValue(undefined);
    const setBucketPublicReadPolicy = vi.fn().mockResolvedValue(undefined);
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 'gcs',
      getAppBucketName: vi.fn().mockReturnValue('eve-app-acme-media-prod-uploads'),
      ensureBucket: vi.fn().mockRejectedValue(new Error(
        'Bucket "eve-app-acme-media-prod-uploads" already exists in another Google Cloud project ' +
        '(project number 999, expected 111). Refusing to use it.',
      )),
      setBucketPublicReadPolicy,
      setBucketCors: vi.fn().mockResolvedValue(undefined),
    }, { upsert });

    await expect(resolveObjectStoreForService(
      deployer,
      {
        image: 'ghcr.io/example/api:latest',
        'x-eve': { object_store: { buckets: [{ name: 'uploads', visibility: 'public' }] } },
      },
      {
        orgId: 'org_123',
        projectId: 'proj_123',
        orgSlug: 'acme',
        projectSlug: 'media',
        envName: 'prod',
        componentName: 'api',
      },
    )).rejects.toThrow(
      /Failed to provision object_store bucket "uploads" for service "api": .*another Google Cloud project/,
    );
    expect(setBucketPublicReadPolicy).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('injects EVE_APP_STORAGE credentials while leaving provisioner credentials unset', async () => {
    process.env = {
      ...originalEnv,
      EVE_STORAGE_PUBLIC_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
      EVE_STORAGE_REGION: 'eu-west-1',
      EVE_APP_STORAGE_PUBLIC_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
      EVE_APP_STORAGE_REGION: 'eu-west-1',
      EVE_APP_STORAGE_ACCESS_KEY_ID: 'app-access-key',
      EVE_APP_STORAGE_SECRET_ACCESS_KEY: 'app-secret-key',
    };

    const deployer = new DeployerService(null as any, null as any);
    const ensureBucket = vi.fn().mockResolvedValue(undefined);
    const upsert = vi.fn().mockResolvedValue(undefined);
    const createSecret = vi.fn().mockResolvedValue(undefined);
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 's3',
      getAppBucketName: vi.fn().mockReturnValue('demo-eve-app-acme-media-staging-uploads'),
      ensureBucket,
      setBucketPublicReadPolicy: vi.fn().mockResolvedValue(undefined),
      setBucketCors: vi.fn().mockResolvedValue(undefined),
    }, { upsert }, { createSecret });

    const envVars = await resolveObjectStoreForService(
      deployer,
      {
        image: 'ghcr.io/example/api:latest',
        'x-eve': {
          object_store: {
            buckets: [{ name: 'uploads' }],
          },
        },
      },
      {
        orgId: 'org_123',
        projectId: 'proj_123',
        orgSlug: 'acme',
        projectSlug: 'media',
        envName: 'staging',
        componentName: 'api',
      },
    );

    expect(process.env.EVE_STORAGE_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.EVE_STORAGE_SECRET_ACCESS_KEY).toBeUndefined();
    expect(ensureBucket).toHaveBeenCalledWith('demo-eve-app-acme-media-staging-uploads');
    expect(envVars).toEqual(expect.arrayContaining([
      { name: 'STORAGE_ENDPOINT', value: 'https://s3.eu-west-1.amazonaws.com' },
      { name: 'STORAGE_REGION', value: 'eu-west-1' },
      secretRef('STORAGE_ACCESS_KEY_ID'),
      secretRef('STORAGE_SECRET_ACCESS_KEY'),
      { name: 'STORAGE_BUCKET_UPLOADS', value: 'demo-eve-app-acme-media-staging-uploads' },
    ]));
    expect(envVars).not.toContainEqual({ name: 'STORAGE_FORCE_PATH_STYLE', value: 'true' });
    // The key pair is written to the namespace Secret and never into the pod spec.
    expect(createSecret).toHaveBeenCalledWith('eve-acme-media-staging', 'eve-app-storage-credentials', {
      STORAGE_ACCESS_KEY_ID: 'app-access-key',
      STORAGE_SECRET_ACCESS_KEY: 'app-secret-key',
    });
    expect(JSON.stringify(envVars)).not.toContain('app-secret-key');
    expect(JSON.stringify(envVars)).not.toContain('app-access-key');
  });

  it('rolls pods when the shared key is rotated', async () => {
    process.env = {
      ...originalEnv,
      EVE_APP_STORAGE_PUBLIC_ENDPOINT: 'https://storage.googleapis.com',
      EVE_APP_STORAGE_REGION: 'europe-west2',
      EVE_APP_STORAGE_ACCESS_KEY_ID: 'old-access-key',
      EVE_APP_STORAGE_SECRET_ACCESS_KEY: 'old-secret-key',
    };
    const deployer = new DeployerService(null as any, null as any);
    const createSecret = vi.fn().mockResolvedValue(undefined);
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 'gcs',
      getAppBucketName: vi.fn().mockReturnValue('eve-app-acme-media-prod-uploads'),
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      setBucketPublicReadPolicy: vi.fn().mockResolvedValue(undefined),
      setBucketCors: vi.fn().mockResolvedValue(undefined),
    }, {}, { createSecret });

    const services: Record<string, Service> = {
      api: {
        image: 'ghcr.io/example/api:latest',
        'x-eve': { object_store: { buckets: [{ name: 'uploads' }] } },
      },
      web: { image: 'ghcr.io/example/web:latest' },
    };
    const prepare = () => (deployer as any).objectStoreProvisioner.prepareObjectStorePlan({
      services,
      envWorkers: [],
      scope: {
        orgId: 'org_123',
        projectId: 'proj_123',
        envName: 'prod',
        orgSlug: 'acme',
        projectSlug: 'media',
        namespace: 'eve-acme-media-prod',
      },
    });
    const annotations = (plan: unknown, serviceName: string) => (deployer as any).buildPodAnnotations({
      objectStorePlan: plan,
      serviceName,
    });

    const before = await prepare();
    process.env.EVE_APP_STORAGE_ACCESS_KEY_ID = 'new-access-key';
    process.env.EVE_APP_STORAGE_SECRET_ACCESS_KEY = 'new-secret-key';
    const after = await prepare();

    expect(createSecret).toHaveBeenLastCalledWith('eve-acme-media-prod', 'eve-app-storage-credentials', {
      STORAGE_ACCESS_KEY_ID: 'new-access-key',
      STORAGE_SECRET_ACCESS_KEY: 'new-secret-key',
    });
    const hashBefore = annotations(before, 'api')['eve.app_bucket_binding_hash'];
    const hashAfter = annotations(after, 'api')['eve.app_bucket_binding_hash'];
    expect(hashBefore).toMatch(/^[0-9a-f]{16}$/);
    expect(hashAfter).toMatch(/^[0-9a-f]{16}$/);
    expect(hashAfter).not.toBe(hashBefore);
    expect(annotations(after, 'web')).toBeUndefined();
  });

  it('removes the credentials Secret when the env binding is removed', async () => {
    const deployer = new DeployerService(null as any, null as any);
    const deleteSecret = vi.fn().mockResolvedValue(undefined);
    configureObjectStoreMocks(deployer, { isConfigured: true, backend: 's3' }, {}, { deleteSecret });

    await (deployer as any).objectStoreProvisioner.removeObjectStoreBinding({
      orgId: 'org_123',
      projectId: 'proj_123',
      envName: 'prod',
      orgSlug: 'acme',
      projectSlug: 'media',
      namespace: 'eve-acme-media-prod',
    });

    expect(deleteSecret).toHaveBeenCalledWith('eve-acme-media-prod', 'eve-app-storage-credentials');
  });

  it('honors EVE_APP_BUCKET_AUTH_MODE=shared when auto isolation could use IRSA', async () => {
    process.env = {
      ...originalEnv,
      EVE_APP_BUCKET_AUTH_MODE: 'shared',
      EVE_OIDC_PROVIDER_ARN: 'arn:aws:iam::000000000000:oidc-provider/oidc.eks.example/id/abc',
      EVE_OIDC_PROVIDER_URL: 'https://oidc.eks.example/id/abc',
      EVE_STORAGE_PUBLIC_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
      EVE_STORAGE_REGION: 'eu-west-1',
      EVE_APP_STORAGE_PUBLIC_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
      EVE_APP_STORAGE_REGION: 'eu-west-1',
      EVE_APP_STORAGE_ACCESS_KEY_ID: 'app-access-key',
      EVE_APP_STORAGE_SECRET_ACCESS_KEY: 'app-secret-key',
    };

    const deployer = new DeployerService(null as any, null as any);
    const upsert = vi.fn().mockResolvedValue(undefined);
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 's3',
      getAppBucketName: vi.fn().mockReturnValue('demo-eve-app-acme-media-staging-uploads'),
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      setBucketPublicReadPolicy: vi.fn().mockResolvedValue(undefined),
      setBucketCors: vi.fn().mockResolvedValue(undefined),
    }, { upsert });

    const envVars = await resolveObjectStoreForService(
      deployer,
      {
        image: 'ghcr.io/example/api:latest',
        'x-eve': {
          object_store: {
            buckets: [{ name: 'uploads' }],
          },
        },
      },
      {
        orgId: 'org_123',
        projectId: 'proj_123',
        orgSlug: 'acme',
        projectSlug: 'media',
        envName: 'staging',
        componentName: 'api',
      },
    );

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      isolation_mode: 'shared',
      iam_role_arn: null,
      service_account_name: null,
    }));
    expect(envVars).toEqual(expect.arrayContaining([
      secretRef('STORAGE_ACCESS_KEY_ID'),
      secretRef('STORAGE_SECRET_ACCESS_KEY'),
      { name: 'STORAGE_BUCKET_UPLOADS', value: 'demo-eve-app-acme-media-staging-uploads' },
    ]));
    expect(envVars.some((entry: { name: string }) => entry.name === 'STORAGE_AUTH_MODE')).toBe(false);
  });

  it('fails fast when app storage credentials are missing', async () => {
    process.env = {
      ...originalEnv,
      EVE_STORAGE_PUBLIC_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
      EVE_STORAGE_REGION: 'eu-west-1',
    };

    const deployer = new DeployerService(null as any, null as any);
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 's3',
      getAppBucketName: vi.fn().mockReturnValue('demo-eve-app-acme-media-staging-uploads'),
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      setBucketPublicReadPolicy: vi.fn().mockResolvedValue(undefined),
      setBucketCors: vi.fn().mockResolvedValue(undefined),
    });

    await expect(resolveObjectStoreForService(
      deployer,
      {
        image: 'ghcr.io/example/api:latest',
        'x-eve': {
          object_store: {
            isolation: 'shared',
            buckets: [{ name: 'uploads' }],
          },
        },
      },
      {
        orgId: 'org_123',
        projectId: 'proj_123',
        orgSlug: 'acme',
        projectSlug: 'media',
        envName: 'staging',
        componentName: 'api',
      },
    )).rejects.toThrow('EVE_APP_STORAGE_ACCESS_KEY_ID / EVE_APP_STORAGE_SECRET_ACCESS_KEY');
  });

  it('aggregates all env buckets into one IRSA binding and records IAM metadata', async () => {
    process.env = {
      ...originalEnv,
      EVE_STORAGE_PUBLIC_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
      EVE_STORAGE_REGION: 'eu-west-1',
    };

    const deployer = new DeployerService(null as any, null as any);
    const upsert = vi.fn().mockResolvedValue(undefined);
    const deleteMissingForEnv = vi.fn().mockResolvedValue(0);
    const createSecret = vi.fn().mockResolvedValue(undefined);
    const deleteSecret = vi.fn().mockResolvedValue(undefined);
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 's3',
      getAppBucketName: vi.fn((_org, _project, _env, bucketName) => `demo-eve-app-acme-media-dev-${bucketName}`),
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      setBucketPublicReadPolicy: vi.fn().mockResolvedValue(undefined),
      setBucketCors: vi.fn().mockResolvedValue(undefined),
    }, { upsert, deleteMissingForEnv }, { createSecret, deleteSecret });

    const ensureForEnv = vi.fn().mockResolvedValue({
      mode: 'irsa',
      envVars: [
        { name: 'STORAGE_ENDPOINT', value: 'https://s3.eu-west-1.amazonaws.com' },
        { name: 'STORAGE_REGION', value: 'eu-west-1' },
        { name: 'STORAGE_AUTH_MODE', value: 'irsa' },
        { name: 'AWS_REGION', value: 'eu-west-1' },
      ],
      bindingHash: 'binding1234',
      iamRoleArn: 'arn:aws:iam::000000000000:role/demo-app-acme-media-dev',
      iamRoleName: 'demo-app-acme-media-dev',
      serviceAccount: {
        name: 'eve-app',
        namespace: 'eve-acme-media-dev',
        annotations: {
          'eks.amazonaws.com/role-arn': 'arn:aws:iam::000000000000:role/demo-app-acme-media-dev',
        },
      },
    });
    Object.assign((deployer as any).objectStoreProvisioner, {
      appCredentialProvisioners: [{
        mode: 'irsa',
        availability: () => ({ available: true }),
        ensureForEnv,
        removeForEnv: vi.fn().mockResolvedValue(undefined),
      }],
    });

    const services: Record<string, Service> = {
      api: {
        image: 'ghcr.io/example/api:latest',
        'x-eve': {
          object_store: {
            isolation: 'irsa',
            buckets: [{ name: 'uploads' }],
          },
        },
      },
      cleanup: {
        image: 'ghcr.io/example/cleanup:latest',
        'x-eve': {
          role: 'job',
          object_store: {
            buckets: [{ name: 'exports' }],
          },
        },
      },
    };

    const plan = await (deployer as any).objectStoreProvisioner.prepareObjectStorePlan({
      services,
      envWorkers: [],
      scope: {
        orgId: 'org_123',
        projectId: 'proj_123',
        envName: 'dev',
        orgSlug: 'acme',
        projectSlug: 'media',
        namespace: 'eve-acme-media-dev',
      },
    });

    expect(ensureForEnv).toHaveBeenCalledTimes(1);
    // A keyless binding leaves no static credentials behind in the namespace.
    expect(createSecret).not.toHaveBeenCalled();
    expect(deleteSecret).toHaveBeenCalledWith('eve-acme-media-dev', 'eve-app-storage-credentials');
    expect(ensureForEnv).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'eve-acme-media-dev' }),
      [
        'demo-eve-app-acme-media-dev-exports',
        'demo-eve-app-acme-media-dev-uploads',
      ],
    );
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      service_name: 'api',
      isolation_mode: 'irsa',
      iam_role_arn: 'arn:aws:iam::000000000000:role/demo-app-acme-media-dev',
      iam_role_name: 'demo-app-acme-media-dev',
      service_account_name: 'eve-app',
      service_account_namespace: 'eve-acme-media-dev',
    }));
    expect(deleteMissingForEnv).toHaveBeenCalledWith(
      'proj_123',
      'dev',
      expect.arrayContaining([
        { service_name: 'api', name: 'uploads' },
        { service_name: 'cleanup', name: 'exports' },
      ]),
    );

    const envVars = await (deployer as any).objectStoreProvisioner.resolveObjectStoreBuckets(
      services.api,
      { envName: 'dev', componentName: 'api' },
      plan,
    );
    expect(envVars).toEqual(expect.arrayContaining([
      { name: 'STORAGE_AUTH_MODE', value: 'irsa' },
      { name: 'AWS_REGION', value: 'eu-west-1' },
      { name: 'STORAGE_BUCKET_UPLOADS', value: 'demo-eve-app-acme-media-dev-uploads' },
    ]));
    expect(envVars.some((entry: { name: string }) => entry.name === 'STORAGE_ACCESS_KEY_ID')).toBe(false);
    expect((deployer as any).objectStoreProvisioner.resolveObjectStoreServiceAccountName(plan, 'api')).toBe('eve-app');
    expect((deployer as any).objectStoreProvisioner.buildObjectStoreServiceAccount(plan)).toEqual(expect.objectContaining({
      kind: 'ServiceAccount',
      metadata: expect.objectContaining({
        name: 'eve-app',
        annotations: expect.objectContaining({
          'eks.amazonaws.com/role-arn': 'arn:aws:iam::000000000000:role/demo-app-acme-media-dev',
        }),
      }),
    }));
  });

  it('fails fast when explicit IRSA is requested on a non-IRSA cluster', async () => {
    const deployer = new DeployerService(null as any, null as any);
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 's3',
      getAppBucketName: vi.fn().mockReturnValue('demo-eve-app-acme-media-dev-uploads'),
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      setBucketPublicReadPolicy: vi.fn().mockResolvedValue(undefined),
      setBucketCors: vi.fn().mockResolvedValue(undefined),
    });

    await expect(resolveObjectStoreForService(
      deployer,
      {
        image: 'ghcr.io/example/api:latest',
        'x-eve': {
          object_store: {
            isolation: 'irsa',
            buckets: [{ name: 'uploads' }],
          },
        },
      },
      {
        orgId: 'org_123',
        projectId: 'proj_123',
        orgSlug: 'acme',
        projectSlug: 'media',
        envName: 'dev',
        componentName: 'api',
      },
    )).rejects.toThrow("isolation mode 'irsa' is not available");
  });
});

describe('DeployerService object-store bucket lifecycle', () => {
  const originalEnv = { ...process.env };
  const scope = {
    orgId: 'org_123',
    projectId: 'proj_123',
    envName: 'prod',
    orgSlug: 'acme',
    projectSlug: 'media',
    namespace: 'eve-acme-media-prod',
  };

  function row(name: string, visibility: 'public' | 'private', extra: Record<string, unknown> = {}) {
    return {
      project_id: 'proj_123',
      env_name: 'prod',
      service_name: 'api',
      name,
      physical_name: `eve-app-acme-media-prod-${name}`,
      visibility,
      ...extra,
    };
  }

  function setup(options: {
    previous?: unknown[];
    claims?: unknown[];
    removeBucketPublicReadPolicy?: ReturnType<typeof vi.fn>;
  } = {}) {
    const deployer = new DeployerService(null as any, null as any);
    const calls: string[] = [];
    const track = (name: string, impl?: (...args: any[]) => unknown) =>
      vi.fn(async (...args: any[]) => {
        calls.push(`${name}:${args[0] ?? ''}`);
        return impl?.(...args);
      });
    const bucketProvisioner = {
      isConfigured: true,
      backend: 's3',
      getAppBucketName: vi.fn((_o, _p, env, bucket) => `eve-app-acme-media-${env}-${bucket}`),
      ensureBucket: track('ensureBucket'),
      setBucketPublicReadPolicy: track('setBucketPublicReadPolicy'),
      removeBucketPublicReadPolicy: options.removeBucketPublicReadPolicy ?? track('removeBucketPublicReadPolicy'),
      setBucketCors: track('setBucketCors'),
    };
    const storageBuckets = {
      upsert: track('upsert', (input: any) => input),
      deleteMissingForEnv: track('deleteMissingForEnv', () => 0),
      deleteByEnv: track('deleteByEnv', () => 0),
      listByEnv: vi.fn().mockResolvedValue(options.previous ?? []),
      listByPhysicalNames: vi.fn().mockResolvedValue(options.claims ?? []),
    };
    const ensureForEnv = vi.fn(async () => {
      calls.push('ensureForEnv');
      return { mode: 'shared', envVars: [], bindingHash: 'h', iamRoleArn: null, iamRoleName: null, serviceAccount: null };
    });
    Object.assign((deployer as any).objectStoreProvisioner, {
      bucketProvisioner,
      storageBuckets,
      k8s: { createSecret: vi.fn(), deleteSecret: vi.fn() },
      appCredentialProvisioners: [{
        mode: 'shared',
        availability: () => ({ available: true }),
        ensureForEnv,
        removeForEnv: vi.fn().mockResolvedValue(undefined),
      }],
    });
    const prepare = (buckets: Array<Record<string, unknown>>, envName = 'prod') =>
      (deployer as any).objectStoreProvisioner.prepareObjectStorePlan({
        services: {
          api: { image: 'ghcr.io/example/api:latest', 'x-eve': { object_store: { buckets } } },
        },
        envWorkers: [],
        scope: { ...scope, envName, namespace: `eve-acme-media-${envName}` },
      });
    return { deployer, calls, bucketProvisioner, storageBuckets, ensureForEnv, prepare };
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('removes the public grant when a public bucket turns private', async () => {
    const { calls, prepare } = setup({ previous: [row('assets', 'public')] });

    await prepare([{ name: 'assets', visibility: 'private' }]);

    expect(calls).toContain('removeBucketPublicReadPolicy:eve-app-acme-media-prod-assets');
    expect(calls).not.toContain('setBucketPublicReadPolicy:eve-app-acme-media-prod-assets');
    // Un-published before the row is rewritten as private, so a failure can be retried.
    expect(calls.indexOf('removeBucketPublicReadPolicy:eve-app-acme-media-prod-assets'))
      .toBeLessThan(calls.findIndex((call) => call.startsWith('upsert')));
  });

  it('keeps the grant on a bucket that stays public', async () => {
    const { calls, prepare } = setup({ previous: [row('assets', 'public')] });

    await prepare([{ name: 'assets', visibility: 'public' }]);

    expect(calls).toContain('setBucketPublicReadPolicy:eve-app-acme-media-prod-assets');
    expect(calls.some((call) => call.startsWith('removeBucketPublicReadPolicy'))).toBe(false);
  });

  it('un-publishes a public bucket removed from the manifest but keeps its data', async () => {
    const { calls, storageBuckets, prepare } = setup({
      previous: [row('assets', 'public'), row('uploads', 'private')],
    });

    await prepare([{ name: 'uploads' }]);

    expect(calls).toContain('removeBucketPublicReadPolicy:eve-app-acme-media-prod-assets');
    expect(calls.filter((call) => call.startsWith('removeBucketPublicReadPolicy'))).toHaveLength(1);
    expect(storageBuckets.deleteMissingForEnv).toHaveBeenCalledWith('proj_123', 'prod', [
      { service_name: 'api', name: 'uploads' },
    ]);
  });

  it('fails the deploy and keeps the rows when un-publishing fails', async () => {
    const { calls, storageBuckets, prepare } = setup({
      previous: [row('assets', 'public')],
      removeBucketPublicReadPolicy: vi.fn().mockRejectedValue(new Error('AccessDenied')),
    });

    await expect(prepare([{ name: 'uploads' }])).rejects.toThrow(
      /Failed to remove public read access .* env "prod": eve-app-acme-media-prod-assets: AccessDenied/,
    );
    expect(storageBuckets.deleteMissingForEnv).not.toHaveBeenCalled();
    expect(calls.some((call) => call.startsWith('upsert'))).toBe(false);
  });

  it('refuses a physical name another env of the project already uses', async () => {
    // env "test" + bucket "ab-cd" and env "test-ab" + bucket "cd" share one name.
    const { calls, ensureForEnv, prepare } = setup({
      claims: [row('ab-cd', 'private', { env_name: 'test', physical_name: 'eve-app-acme-media-test-ab-cd' })],
    });

    await expect(prepare([{ name: 'cd' }], 'test-ab')).rejects.toThrow(
      'Object-store bucket name collision in env "test-ab": bucket "cd" maps to "eve-app-acme-media-test-ab-cd", ' +
      'which env "test" (bucket "ab-cd") already uses. Rename the bucket or the environment.',
    );
    expect(ensureForEnv).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('does not name another project that holds the physical name', async () => {
    const { prepare } = setup({
      claims: [row('cd', 'private', { project_id: 'proj_other', env_name: 'test-ab', physical_name: 'eve-app-acme-media-test-ab-cd' })],
    });

    await expect(prepare([{ name: 'cd' }], 'test-ab')).rejects.toThrow(
      'bucket "cd" maps to "eve-app-acme-media-test-ab-cd", which another project already uses',
    );
  });

  it('accepts a physical name this env already tracks', async () => {
    const { calls, prepare } = setup({ claims: [row('uploads', 'private')] });

    await prepare([{ name: 'uploads' }]);

    expect(calls).toContain('ensureBucket:eve-app-acme-media-prod-uploads');
  });

  it('un-publishes the env buckets on env deletion without failing it', async () => {
    const removeBucketPublicReadPolicy = vi.fn()
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockResolvedValue(undefined);
    const { deployer } = setup({
      previous: [row('assets', 'public'), row('media', 'public'), row('uploads', 'private')],
      removeBucketPublicReadPolicy,
    });
    const warn = vi.spyOn((deployer as any).objectStoreProvisioner.logger, 'warn').mockImplementation(() => undefined);

    await (deployer as any).objectStoreProvisioner.unpublishEnvBuckets(scope);

    expect(removeBucketPublicReadPolicy.mock.calls.map(([name]) => name)).toEqual([
      'eve-app-acme-media-prod-assets',
      'eve-app-acme-media-prod-media',
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('eve-app-acme-media-prod-assets: AccessDenied'));
  });
});

describe('BucketProvisioner app bucket names', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses EVE_STORAGE_APP_BUCKET_PREFIX for app buckets', () => {
    process.env = {
      ...originalEnv,
      EVE_STORAGE_ORG_BUCKET_PREFIX: 'demo-eve-org',
      EVE_STORAGE_APP_BUCKET_PREFIX: 'demo-eve-app',
    };

    const provisioner = new BucketProvisioner();

    expect(provisioner.getOrgBucketName('acme')).toBe('demo-eve-org-acme');
    expect(provisioner.getAppBucketName('acme', 'media', 'staging', 'uploads'))
      .toBe('demo-eve-app-acme-media-staging-uploads');
  });

  it('falls back to EVE_STORAGE_ORG_BUCKET_PREFIX for local compatibility', () => {
    process.env = {
      ...originalEnv,
      EVE_STORAGE_ORG_BUCKET_PREFIX: 'eve-org',
    };

    const provisioner = new BucketProvisioner();

    expect(provisioner.getAppBucketName('acme', 'media', 'dev', 'uploads'))
      .toBe('eve-org-acme-media-dev-uploads');
  });
});
