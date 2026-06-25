export type {
  ObjectStorageClient,
  StorageGetObjectResult,
  StorageObjectMetadata,
  StorageCorsRule,
  PresignUploadOpts,
} from './storage-client.js';

// Concrete implementations are NOT re-exported here.
// They are loaded lazily by createStorageClient() so services that
// don't use storage (e.g. gateway) never pull in @aws-sdk or @google-cloud.
export type { S3StorageClientConfig } from './s3-storage-client.js';

export {
  createStorageClient,
  resolveStorageConfig,
  resolveSnapshotStorageConfig,
} from './create-storage-client.js';
export type { StorageClientConfig } from './create-storage-client.js';
