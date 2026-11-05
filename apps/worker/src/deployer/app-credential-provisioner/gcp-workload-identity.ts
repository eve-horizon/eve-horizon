import * as crypto from 'crypto';
import type {
  AppCredentialProvisioner,
  AppCredentialProvisionerAvailability,
  AppObjectStoreBinding,
  AppObjectStoreEnvVar,
  AppObjectStoreScope,
} from './types';

const APP_SERVICE_ACCOUNT_NAME = 'eve-app';

/** Object read/write/delete and list, plus multipart uploads; no bucket or IAM admin. */
export const GCP_APP_BUCKET_ROLE = 'roles/storage.objectUser';

const WORKLOAD_POOL_PATTERN =
  /^projects\/(\d+)\/locations\/global\/workloadIdentityPools\/([a-z][a-z0-9-]{4,28}[a-z0-9])\.svc\.id\.goog$/;

/** The part of BucketProvisioner this mode needs: bucket IAM through the worker's own identity. */
export interface BucketIamMembers {
  readonly supportsBucketIamMembers: boolean;
  addBucketIamMember(bucket: string, role: string, member: string): Promise<void>;
  removeBucketIamMember(bucket: string, role: string, member: string): Promise<void>;
}

/**
 * Keyless app bucket access on GKE, the GCP counterpart of `irsa`.
 *
 * Each env's pods run as ServiceAccount/eve-app in the env namespace. With
 * Workload Identity Federation for GKE that Kubernetes service account is an
 * IAM principal in its own right, so the worker grants it
 * roles/storage.objectUser on the env's buckets only. No Google service
 * account or key is created: the worker needs nothing beyond the bucket IAM
 * permission it already uses for public buckets.
 *
 * Apps authenticate with Application Default Credentials and must use the
 * Google Cloud Storage client libraries; S3 SDKs need HMAC keys (`shared`).
 * See docs/plans/app-object-bucket-gcp-workload-identity-plan.md.
 */
export class GcpWorkloadIdentityAppCredentialProvisioner implements AppCredentialProvisioner {
  readonly mode = 'gcp-workload-identity' as const;

  constructor(private readonly buckets: BucketIamMembers) {}

  /**
   * The mode changes the app contract (GCS API instead of S3), so `auto`
   * picks it only when the operator says every app on the cluster is ready.
   */
  get autoSelectable(): boolean {
    return authModeSetting() === 'workload-identity';
  }

  availability(): AppCredentialProvisionerAvailability {
    const authMode = authModeSetting();
    if (authMode && !['auto', 'workload-identity'].includes(authMode)) {
      return { available: false, reason: `EVE_APP_BUCKET_AUTH_MODE=${process.env.EVE_APP_BUCKET_AUTH_MODE}` };
    }

    const pool = process.env.EVE_GKE_WORKLOAD_IDENTITY_POOL?.trim();
    if (!pool) {
      return { available: false, reason: 'missing EVE_GKE_WORKLOAD_IDENTITY_POOL' };
    }
    if (!WORKLOAD_POOL_PATTERN.test(pool)) {
      return {
        available: false,
        reason:
          `invalid EVE_GKE_WORKLOAD_IDENTITY_POOL "${pool}": expected ` +
          'projects/<project-number>/locations/global/workloadIdentityPools/<project-id>.svc.id.goog',
      };
    }
    if (!this.buckets.supportsBucketIamMembers) {
      return {
        available: false,
        reason:
          'the worker storage client cannot manage bucket IAM; it needs EVE_STORAGE_BACKEND=gcs ' +
          'with Workload Identity (no EVE_STORAGE_ACCESS_KEY_ID)',
      };
    }
    return { available: true };
  }

  async ensureForEnv(
    scope: AppObjectStoreScope,
    physicalBucketNames: string[],
  ): Promise<AppObjectStoreBinding> {
    const availability = this.availability();
    if (!availability.available) {
      throw new Error(`isolation mode 'workload-identity' not available on this cluster: ${availability.reason}`);
    }

    const member = this.memberFor(scope.namespace);
    const sortedBuckets = [...new Set(physicalBucketNames)].sort();
    const envVars: AppObjectStoreEnvVar[] = [
      { name: 'STORAGE_ENDPOINT', value: resolveEndpoint() },
      { name: 'STORAGE_AUTH_MODE', value: this.mode },
      { name: 'GOOGLE_CLOUD_PROJECT', value: this.projectId() },
    ];
    const region = process.env.EVE_APP_STORAGE_REGION ?? process.env.EVE_STORAGE_REGION;
    if (region) {
      envVars.push({ name: 'STORAGE_REGION', value: region });
    }

    return {
      mode: this.mode,
      envVars,
      credentialSecret: null,
      bindingHash: crypto
        .createHash('sha256')
        .update(JSON.stringify({ mode: this.mode, member, role: GCP_APP_BUCKET_ROLE, buckets: sortedBuckets }))
        .digest('hex')
        .slice(0, 16),
      iamRoleArn: null,
      iamRoleName: null,
      serviceAccount: {
        name: APP_SERVICE_ACCOUNT_NAME,
        namespace: scope.namespace,
        annotations: {},
      },
    };
  }

  async grantBucketAccess(
    scope: AppObjectStoreScope,
    physicalBucketNames: string[],
    droppedBucketNames: string[],
  ): Promise<void> {
    const member = this.memberFor(scope.namespace);
    for (const bucket of [...new Set(physicalBucketNames)].sort()) {
      await this.buckets.addBucketIamMember(bucket, GCP_APP_BUCKET_ROLE, member);
    }
    for (const bucket of [...new Set(droppedBucketNames)].sort()) {
      await this.buckets.removeBucketIamMember(bucket, GCP_APP_BUCKET_ROLE, member);
    }
  }

  async removeForEnv(scope: AppObjectStoreScope, physicalBucketNames: string[]): Promise<void> {
    if (physicalBucketNames.length === 0) return;
    await this.grantBucketAccess(scope, [], physicalBucketNames);
  }

  /** IAM principal of ServiceAccount/eve-app in the env namespace. */
  memberFor(namespace: string): string {
    const pool = process.env.EVE_GKE_WORKLOAD_IDENTITY_POOL!.trim();
    return `principal://iam.googleapis.com/${pool}/subject/ns/${namespace}/sa/${APP_SERVICE_ACCOUNT_NAME}`;
  }

  private projectId(): string {
    return WORKLOAD_POOL_PATTERN.exec(process.env.EVE_GKE_WORKLOAD_IDENTITY_POOL!.trim())![2];
  }
}

function authModeSetting(): string | undefined {
  return process.env.EVE_APP_BUCKET_AUTH_MODE?.trim().toLowerCase() || undefined;
}

function resolveEndpoint(): string {
  return (
    process.env.EVE_APP_STORAGE_PUBLIC_ENDPOINT ??
    process.env.EVE_APP_STORAGE_ENDPOINT ??
    process.env.EVE_STORAGE_PUBLIC_ENDPOINT ??
    process.env.EVE_STORAGE_ENDPOINT ??
    'https://storage.googleapis.com'
  );
}
