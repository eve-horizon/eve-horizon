import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '@eve/shared';
import { createAppCredentialProvisioners } from '../app-credential-provisioner/factory.js';
import { BucketProvisioner } from '../bucket-provisioner.js';
import { DeployerService } from '../deployer.service.js';

describe('DeployerService object-store buckets', () => {
  const originalEnv = { ...process.env };

  function configureObjectStoreMocks(
    deployer: DeployerService,
    bucketProvisioner: Record<string, unknown>,
    storageBuckets: Record<string, unknown> = {},
  ) {
    Object.assign((deployer as any).objectStoreProvisioner, {
      bucketProvisioner,
      appCredentialProvisioners: createAppCredentialProvisioners(bucketProvisioner as any),
      storageBuckets: {
        upsert: vi.fn().mockResolvedValue(undefined),
        deleteMissingForEnv: vi.fn().mockResolvedValue(0),
        deleteByEnv: vi.fn().mockResolvedValue(0),
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
      { name: 'STORAGE_ACCESS_KEY_ID', value: 'minio' },
      { name: 'STORAGE_SECRET_ACCESS_KEY', value: 'minio-secret' },
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
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 's3',
      getAppBucketName: vi.fn().mockReturnValue('demo-eve-app-acme-media-staging-uploads'),
      ensureBucket,
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

    expect(process.env.EVE_STORAGE_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.EVE_STORAGE_SECRET_ACCESS_KEY).toBeUndefined();
    expect(ensureBucket).toHaveBeenCalledWith('demo-eve-app-acme-media-staging-uploads');
    expect(envVars).toEqual(expect.arrayContaining([
      { name: 'STORAGE_ENDPOINT', value: 'https://s3.eu-west-1.amazonaws.com' },
      { name: 'STORAGE_REGION', value: 'eu-west-1' },
      { name: 'STORAGE_ACCESS_KEY_ID', value: 'app-access-key' },
      { name: 'STORAGE_SECRET_ACCESS_KEY', value: 'app-secret-key' },
      { name: 'STORAGE_BUCKET_UPLOADS', value: 'demo-eve-app-acme-media-staging-uploads' },
    ]));
    expect(envVars).not.toContainEqual({ name: 'STORAGE_FORCE_PATH_STYLE', value: 'true' });
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
      { name: 'STORAGE_ACCESS_KEY_ID', value: 'app-access-key' },
      { name: 'STORAGE_SECRET_ACCESS_KEY', value: 'app-secret-key' },
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
    configureObjectStoreMocks(deployer, {
      isConfigured: true,
      backend: 's3',
      getAppBucketName: vi.fn((_org, _project, _env, bucketName) => `demo-eve-app-acme-media-dev-${bucketName}`),
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      setBucketPublicReadPolicy: vi.fn().mockResolvedValue(undefined),
      setBucketCors: vi.fn().mockResolvedValue(undefined),
    }, { upsert, deleteMissingForEnv });

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
