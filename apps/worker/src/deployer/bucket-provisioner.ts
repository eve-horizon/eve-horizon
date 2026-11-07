import {
  createStorageClient,
  supportsBucketIamMembers,
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
    try {
      await this.client.setBucketPublicReadPolicy(name);
    } catch (err: unknown) {
      throw describePublicReadRefusal(name, err) ?? err;
    }
  }

  /** True when the storage backend has per-bucket IAM the worker can manage (native GCS). */
  get supportsBucketIamMembers(): boolean {
    return supportsBucketIamMembers(this.client);
  }

  async addBucketIamMember(name: string, role: string, member: string): Promise<void> {
    if (!supportsBucketIamMembers(this.client)) {
      throw new Error(`storage backend "${this.backend}" has no per-bucket IAM`);
    }
    await this.client.addBucketIamMember(name, role, member);
  }

  async removeBucketIamMember(name: string, role: string, member: string): Promise<void> {
    if (!supportsBucketIamMembers(this.client)) {
      throw new Error(`storage backend "${this.backend}" has no per-bucket IAM`);
    }
    await this.client.removeBucketIamMember(name, role, member);
  }

  /**
   * Remove anonymous read grants from a bucket that Eve made public.
   * Used when a bucket turns private or leaves the manifest.
   */
  async removeBucketPublicReadPolicy(name: string): Promise<void> {
    if (!this.client) return;
    await this.client.removeBucketPublicReadPolicy(name);
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

/**
 * Public buckets need an anonymous grant (GCS `allUsers`, an S3 policy for
 * `*`). Organisations often forbid that; name the policy instead of passing
 * on a bare 4xx.
 */
function describePublicReadRefusal(name: string, err: unknown): Error | null {
  const message = err instanceof Error ? err.message : String(err);
  if (/permitted customer|allowedPolicyMember|organi[sz]ation polic|constraints\/iam\./i.test(message)) {
    return new Error(
      `Bucket "${name}" is declared public, but the Google Cloud organisation policy refuses the allUsers grant ` +
      'it needs (iam.allowedPolicyMemberDomains or iam.managed.allowedPolicyMembers). Allow allUsers for the ' +
      'app bucket prefix, or declare the bucket private and serve its objects through the app, signed URLs ' +
      `or a CDN. (${message})`,
    );
  }
  if (/BlockPublicPolicy|public policies are blocked/i.test(message)) {
    return new Error(
      `Bucket "${name}" is declared public, but S3 Block Public Access refuses public bucket policies ` +
      '(likely the account-level setting). Allow public policies for the app bucket prefix, or declare the ' +
      `bucket private and serve its objects through the app, presigned URLs or a CDN. (${message})`,
    );
  }
  return null;
}
