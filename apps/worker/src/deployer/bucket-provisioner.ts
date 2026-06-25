import {
  createStorageClient,
  type ObjectStorageClient,
  type StorageCorsRule,
} from '@eve/shared';

export interface BucketCorsRule {
  origins: string[];
  methods: string[];
  maxAgeSeconds?: number;
}

/**
 * Minimal bucket provisioner for app object stores.
 * Uses the shared storage client abstraction to talk to any supported backend
 * (S3, GCS native, MinIO, R2, Tigris).
 *
 * All methods are no-ops when storage is not configured.
 */
export class BucketProvisioner {
  private readonly client: ObjectStorageClient | null;
  readonly isConfigured: boolean;
  readonly backend: string;

  constructor() {
    const backend = process.env.EVE_STORAGE_BACKEND;
    if (!backend) {
      this.isConfigured = false;
      this.backend = '';
      this.client = null;
      return;
    }

    this.client = createStorageClient();
    this.isConfigured = !!this.client;
    this.backend = backend;
  }

  /**
   * Create a bucket if it does not already exist.
   * Idempotent — silently succeeds if the bucket already belongs to this account.
   */
  async ensureBucket(name: string): Promise<void> {
    if (!this.client) return;
    await this.client.ensureBucket(name);
  }

  /**
   * Apply a public-read bucket policy so any object in the bucket can be
   * fetched without authentication.  Used for `visibility: public` buckets.
   */
  async setBucketPublicReadPolicy(name: string): Promise<void> {
    if (!this.client) return;
    await this.client.setBucketPublicReadPolicy(name);
  }

  /**
   * Configure CORS rules on a bucket.
   */
  async setBucketCors(name: string, rules: BucketCorsRule[]): Promise<void> {
    if (!this.client) return;
    await this.client.setBucketCors(
      name,
      rules.map((r) => ({
        origins: r.origins,
        methods: r.methods,
        maxAgeSeconds: r.maxAgeSeconds,
      })),
    );
  }

  /**
   * Return the canonical physical name for an org-level bucket.
   * Pattern: `{prefix}-{orgSlug}`
   * Example: `eve-org-acme`
   */
  getOrgBucketName(orgSlug: string): string {
    const prefix = process.env.EVE_STORAGE_ORG_BUCKET_PREFIX ?? 'eve-org';
    return `${prefix}-${orgSlug}`;
  }

  /**
   * Return the canonical physical name for an app-level bucket.
   * Pattern: `{appPrefix}-{orgSlug}-{projectSlug}-{envName}-{bucketName}`
   * Example: `eve-app-acme-myapp-production-uploads`
   */
  getAppBucketName(
    orgSlug: string,
    projectSlug: string,
    envName: string,
    bucketName: string,
  ): string {
    const prefix =
      process.env.EVE_STORAGE_APP_BUCKET_PREFIX ??
      process.env.EVE_STORAGE_ORG_BUCKET_PREFIX ??
      'eve-org';
    return `${prefix}-${orgSlug}-${projectSlug}-${envName}-${bucketName}`;
  }
}
