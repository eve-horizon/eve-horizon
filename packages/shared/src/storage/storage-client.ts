import type { Readable } from 'stream';

/**
 * Unified object storage interface.
 *
 * Two implementations:
 *   - S3StorageClient  — AWS S3, GCS via HMAC, MinIO, R2, Tigris
 *   - GcsStorageClient — native GCS via Application Default Credentials
 *
 * Consumers never import the concrete classes directly; they call
 * `createStorageClient()` from the factory module.
 */

export interface StorageGetObjectResult {
  body: Buffer;
  contentType?: string;
}

export interface StorageObjectMetadata {
  contentType: string;
  contentLength: number;
  etag: string;
}

export interface StorageCorsRule {
  origins: string[];
  methods: string[];
  headers?: string[];
  maxAgeSeconds?: number;
}

export interface PresignUploadOpts {
  contentType?: string;
  expiresInSeconds?: number;
}

export interface ObjectStorageClient {
  /** Download an object and return its body as a Buffer. */
  getObject(bucket: string, key: string): Promise<StorageGetObjectResult>;

  /** Download an object as a readable stream. */
  getObjectStream(bucket: string, key: string): Promise<Readable>;

  /** HEAD an object. Returns null if the object does not exist. */
  getObjectMetadata(bucket: string, key: string): Promise<StorageObjectMetadata | null>;

  /** Delete an object. */
  deleteObject(bucket: string, key: string): Promise<void>;

  /** Stream upload. Returns the uploaded object size in bytes. */
  uploadStream(
    bucket: string,
    key: string,
    body: Readable,
    contentType?: string,
  ): Promise<number>;

  /** Generate a presigned PUT URL for client-side upload. */
  getPresignedUploadUrl(
    bucket: string,
    key: string,
    opts?: PresignUploadOpts,
  ): Promise<string>;

  /** Generate a presigned GET URL for client-side download. */
  getPresignedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds?: number,
  ): Promise<string>;

  /** Create a bucket (idempotent). */
  ensureBucket(name: string): Promise<void>;

  /** Set CORS rules on a bucket. */
  setBucketCors(name: string, rules: StorageCorsRule[]): Promise<void>;

  /** Make a bucket publicly readable. */
  setBucketPublicReadPolicy(name: string): Promise<void>;
}
