import { Injectable, Logger } from '@nestjs/common';
import {
  createStorageClient,
  resolveStorageConfig,
  type ObjectStorageClient,
  type PresignUploadOpts as SharedPresignOpts,
} from '@eve/shared';

export interface UploadUrlOpts {
  contentType?: string;
  maxBytes?: number;
  expiresInSeconds?: number;
}

export interface ObjectMetadata {
  contentType: string;
  contentLength: number;
  etag: string;
}

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_MAX_BYTES = 524288000; // 500 MB

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: ObjectStorageClient | null;

  readonly isConfigured: boolean;
  readonly orgBucketPrefix: string;
  readonly internalBucket: string;
  readonly publicEndpoint: string;
  readonly backend: string;

  constructor() {
    const config = resolveStorageConfig();

    if (!config.backend) {
      this.logger.warn(
        'EVE_STORAGE_BACKEND is not set — StorageService is disabled. ' +
          'Set EVE_STORAGE_BACKEND (e.g. "minio" or "s3") to enable object storage.',
      );
      this.isConfigured = false;
      this.backend = '';
      this.orgBucketPrefix = process.env.EVE_STORAGE_ORG_BUCKET_PREFIX ?? 'eve-org';
      this.internalBucket = process.env.EVE_STORAGE_INTERNAL_BUCKET ?? 'eve-internal';
      this.publicEndpoint = process.env.EVE_STORAGE_PUBLIC_ENDPOINT ?? '';
      this.client = null;
      return;
    }

    this.client = createStorageClient(config);
    this.isConfigured = true;
    this.backend = config.backend;
    this.orgBucketPrefix = process.env.EVE_STORAGE_ORG_BUCKET_PREFIX ?? 'eve-org';
    this.internalBucket = process.env.EVE_STORAGE_INTERNAL_BUCKET ?? 'eve-internal';
    this.publicEndpoint = config.publicEndpoint ?? config.endpoint ?? '';

    const authMode = config.backend === 'gcs' && !config.accessKeyId ? 'native-adc' : 'credentials';
    this.logger.log(
      `StorageService initialized (backend=${config.backend}, auth=${authMode}, ` +
        `endpoint=${config.endpoint ?? 'default'}, region=${config.region ?? 'default'})`,
    );
  }

  // Get org bucket name for an org slug
  getOrgBucketName(orgSlug: string): string {
    return `${this.orgBucketPrefix}-${orgSlug}`;
  }

  // Generate presigned PUT URL for upload
  async getPresignedUploadUrl(bucket: string, key: string, opts?: UploadUrlOpts): Promise<string> {
    this.requireConfigured();
    return this.client!.getPresignedUploadUrl(bucket, key, {
      contentType: opts?.contentType,
      expiresInSeconds: opts?.expiresInSeconds ?? DEFAULT_TTL_SECONDS,
    });
  }

  // Generate presigned GET URL for download
  async getPresignedDownloadUrl(bucket: string, key: string, ttlSeconds?: number): Promise<string> {
    this.requireConfigured();
    return this.client!.getPresignedDownloadUrl(bucket, key, ttlSeconds ?? DEFAULT_TTL_SECONDS);
  }

  // Get object content directly (internal cluster access, no presigning)
  async getObject(bucket: string, key: string): Promise<string> {
    this.requireConfigured();
    const result = await this.client!.getObject(bucket, key);
    return result.body.toString();
  }

  // Get object metadata (HEAD)
  async getObjectMetadata(bucket: string, key: string): Promise<ObjectMetadata | null> {
    this.requireConfigured();
    return this.client!.getObjectMetadata(bucket, key);
  }

  // Delete an object
  async deleteObject(bucket: string, key: string): Promise<void> {
    this.requireConfigured();
    await this.client!.deleteObject(bucket, key);
  }

  // Ensure bucket exists (create if not)
  async ensureBucket(name: string): Promise<void> {
    this.requireConfigured();
    await this.client!.ensureBucket(name);
    this.logger.log(`Bucket ensured: ${name}`);
  }

  // Ensure org bucket exists with CORS configured for browser access
  async ensureOrgBucket(orgSlug: string): Promise<string> {
    const name = this.getOrgBucketName(orgSlug);
    await this.ensureBucket(name);
    try {
      await this.setBucketCors(name, [
        {
          allowedOrigins: ['*'],
          allowedMethods: ['GET', 'PUT', 'HEAD'],
          allowedHeaders: ['*'],
          maxAgeSeconds: 3600,
        },
      ]);
    } catch (err) {
      // CORS setting may fail with older MinIO versions — non-fatal for ingest/upload
      this.logger.warn(`Failed to set CORS on bucket ${name}: ${(err as Error).message}`);
    }
    return name;
  }

  // Set bucket CORS policy
  async setBucketCors(
    name: string,
    rules: Array<{
      allowedOrigins: string[];
      allowedMethods: string[];
      allowedHeaders?: string[];
      maxAgeSeconds?: number;
    }>,
  ): Promise<void> {
    this.requireConfigured();
    await this.client!.setBucketCors(
      name,
      rules.map((r) => ({
        origins: r.allowedOrigins,
        methods: r.allowedMethods,
        headers: r.allowedHeaders,
        maxAgeSeconds: r.maxAgeSeconds,
      })),
    );
  }

  // Set bucket public read policy (makes all objects publicly readable)
  async setBucketPublicReadPolicy(name: string): Promise<void> {
    this.requireConfigured();
    await this.client!.setBucketPublicReadPolicy(name);
  }

  private requireConfigured(): void {
    if (!this.isConfigured || !this.client) {
      throw new Error(
        'StorageService is not configured. Set EVE_STORAGE_BACKEND to enable object storage.',
      );
    }
  }
}
