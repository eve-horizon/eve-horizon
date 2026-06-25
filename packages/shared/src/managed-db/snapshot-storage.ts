import {
  createStorageClient,
  resolveSnapshotStorageConfig,
  type ObjectStorageClient,
} from '../storage/index.js';

export interface SnapshotStorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * Resolve snapshot storage configuration from environment variables.
 * Reuses the same EVE_STORAGE_* env vars as the BucketProvisioner.
 *
 * @deprecated Use resolveSnapshotStorageConfig() from @eve/shared storage module directly.
 */
export function resolveSnapshotStorageConfigLegacy(): SnapshotStorageConfig {
  const backend = process.env.EVE_STORAGE_BACKEND ?? 's3';
  const region = process.env.EVE_STORAGE_REGION ?? process.env.AWS_REGION ?? 'eu-west-1';
  const deploymentId = process.env.EVE_DEPLOYMENT_ID ?? 'eve-local';
  const bucket = process.env.EVE_DB_SNAPSHOT_BUCKET ?? `${deploymentId}-db-snapshots`;

  if (backend === 'minio') {
    return {
      bucket,
      region,
      endpoint: process.env.EVE_STORAGE_ENDPOINT ?? 'http://minio:9000',
      forcePathStyle: true,
      accessKeyId: process.env.EVE_STORAGE_ACCESS_KEY ?? 'minioadmin',
      secretAccessKey: process.env.EVE_STORAGE_SECRET_KEY ?? 'minioadmin',
    };
  }

  return {
    bucket,
    region,
    endpoint: process.env.EVE_STORAGE_ENDPOINT,
    forcePathStyle: !!process.env.EVE_STORAGE_ENDPOINT,
    accessKeyId: process.env.EVE_STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.EVE_STORAGE_SECRET_KEY,
  };
}

/**
 * Create a storage client configured for snapshot operations.
 * Returns { client, bucket } or null if storage is disabled.
 *
 * Accepts an optional legacy SnapshotStorageConfig for callers that
 * build config explicitly (e.g. managed-db reconciler with per-env overrides).
 */
export function createSnapshotStorageClient(config?: SnapshotStorageConfig): {
  client: ObjectStorageClient;
  bucket: string;
} | null {
  if (config) {
    const client = createStorageClient({
      backend: process.env.EVE_STORAGE_BACKEND ?? 's3',
      endpoint: config.endpoint,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
    return client ? { client, bucket: config.bucket } : null;
  }

  return resolveSnapshotStorageConfig();
}

/**
 * @deprecated Use createSnapshotStorageClient() instead.
 * Kept for callers that still expect an S3Client directly.
 */
export { createSnapshotStorageClient as createSnapshotS3Client };

/**
 * Build the S3 key for a snapshot.
 */
export function buildSnapshotS3Key(
  orgSlug: string,
  projectSlug: string,
  envName: string,
  snapshotId: string,
): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `${orgSlug}/${projectSlug}/${envName}/${timestamp}_${snapshotId}.dump`;
}
