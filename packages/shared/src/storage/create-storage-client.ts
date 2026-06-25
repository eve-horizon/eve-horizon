import type { ObjectStorageClient } from './storage-client.js';
import { S3StorageClient } from './s3-storage-client.js';
import { GcsStorageClient } from './gcs-storage-client.js';

export interface StorageClientConfig {
  backend?: string;
  endpoint?: string;
  publicEndpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * Read storage configuration from EVE_STORAGE_* environment variables.
 */
export function resolveStorageConfig(): StorageClientConfig {
  return {
    backend: process.env.EVE_STORAGE_BACKEND,
    endpoint: process.env.EVE_STORAGE_ENDPOINT,
    publicEndpoint: process.env.EVE_STORAGE_PUBLIC_ENDPOINT,
    region: process.env.EVE_STORAGE_REGION ?? 'us-east-1',
    accessKeyId: process.env.EVE_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.EVE_STORAGE_SECRET_ACCESS_KEY,
  };
}

/**
 * Resolve snapshot-specific storage config.
 *
 * Snapshot env vars use EVE_STORAGE_ACCESS_KEY (not _ID suffix),
 * so we map them here for compatibility.
 */
export function resolveSnapshotStorageConfig(): {
  client: ObjectStorageClient;
  bucket: string;
} | null {
  const backend = process.env.EVE_STORAGE_BACKEND ?? 's3';
  const deploymentId = process.env.EVE_DEPLOYMENT_ID ?? 'eve-local';
  const bucket = process.env.EVE_DB_SNAPSHOT_BUCKET ?? `${deploymentId}-db-snapshots`;

  const config: StorageClientConfig = {
    backend,
    region: process.env.EVE_STORAGE_REGION ?? process.env.AWS_REGION ?? 'eu-west-1',
  };

  if (backend === 'minio') {
    config.endpoint = process.env.EVE_STORAGE_ENDPOINT ?? 'http://minio:9000';
    config.accessKeyId = process.env.EVE_STORAGE_ACCESS_KEY ?? 'minioadmin';
    config.secretAccessKey = process.env.EVE_STORAGE_SECRET_KEY ?? 'minioadmin';
  } else {
    config.endpoint = process.env.EVE_STORAGE_ENDPOINT;
    config.accessKeyId = process.env.EVE_STORAGE_ACCESS_KEY;
    config.secretAccessKey = process.env.EVE_STORAGE_SECRET_KEY;
  }

  const client = createStorageClient(config);
  if (!client) return null;
  return { client, bucket };
}

/**
 * Create a storage client based on configuration.
 *
 * Decision logic:
 *   - No backend set → null (storage disabled)
 *   - backend=gcs + no HMAC keys → GcsStorageClient (native ADC/Workload Identity)
 *   - Everything else → S3StorageClient (S3, GCS+HMAC, MinIO, R2, Tigris)
 *
 * Both implementations use dynamic imports internally so @aws-sdk and
 * @google-cloud/storage are only loaded at runtime when actually needed.
 */
export function createStorageClient(config?: StorageClientConfig): ObjectStorageClient | null {
  const resolved = config ?? resolveStorageConfig();

  if (!resolved.backend) return null;

  // GCS native path: Workload Identity / Application Default Credentials
  if (resolved.backend === 'gcs' && !resolved.accessKeyId) {
    return new GcsStorageClient({ region: resolved.region });
  }

  // S3-compatible path (covers all backends including GCS with HMAC keys)
  return new S3StorageClient({
    endpoint: resolved.endpoint,
    publicEndpoint: resolved.publicEndpoint,
    region: resolved.region ?? 'us-east-1',
    accessKeyId: resolved.accessKeyId,
    secretAccessKey: resolved.secretAccessKey,
    forcePathStyle: resolved.backend === 'minio',
  });
}
