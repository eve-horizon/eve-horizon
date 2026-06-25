import { Readable } from 'stream';
import { createHash } from 'node:crypto';
import type {
  ObjectStorageClient,
  StorageGetObjectResult,
  StorageObjectMetadata,
  StorageCorsRule,
  PresignUploadOpts,
} from './storage-client.js';

export interface S3StorageClientConfig {
  endpoint?: string;
  publicEndpoint?: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

const DEFAULT_TTL = 300;

/**
 * S3-compatible storage client.
 *
 * Uses dynamic import so @aws-sdk is only loaded at runtime when this
 * code path is actually used. GCP deployments never load it.
 */
export class S3StorageClient implements ObjectStorageClient {
  private readonly config: S3StorageClientConfig;
  private clientPromise: Promise<any> | null = null;
  private presignClientPromise: Promise<any> | null = null;

  constructor(config: S3StorageClientConfig) {
    this.config = config;
  }

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = this.initClient(this.config.endpoint);
    }
    return this.clientPromise;
  }

  private async getPresignClient() {
    if (this.config.publicEndpoint && this.config.publicEndpoint !== this.config.endpoint) {
      if (!this.presignClientPromise) {
        this.presignClientPromise = this.initClient(this.config.publicEndpoint);
      }
      return this.presignClientPromise;
    }
    return this.getClient();
  }

  private async initClient(endpoint?: string) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const credentials =
      this.config.accessKeyId && this.config.secretAccessKey
        ? { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey }
        : undefined;
    return new S3Client({
      endpoint,
      region: this.config.region,
      credentials,
      forcePathStyle: this.config.forcePathStyle,
      // Disable flexible checksums — MinIO doesn't support them
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async getObject(bucket: string, key: string): Promise<StorageGetObjectResult> {
    const client = await this.getClient();
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty body for s3://${bucket}/${key}`);
    const buf = Buffer.from(await res.Body.transformToByteArray());
    return { body: buf, contentType: res.ContentType };
  }

  async getObjectStream(bucket: string, key: string): Promise<Readable> {
    const client = await this.getClient();
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty body for s3://${bucket}/${key}`);
    return res.Body as Readable;
  }

  async getObjectMetadata(bucket: string, key: string): Promise<StorageObjectMetadata | null> {
    try {
      const client = await this.getClient();
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        contentType: res.ContentType ?? 'application/octet-stream',
        contentLength: res.ContentLength ?? 0,
        etag: res.ETag ?? '',
      };
    } catch (err: unknown) {
      const code = (err as { name?: string })?.name;
      if (code === 'NotFound' || code === '404' || code === 'NoSuchKey') return null;
      throw err;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const client = await this.getClient();
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async uploadStream(
    bucket: string,
    key: string,
    body: Readable,
    contentType?: string,
  ): Promise<number> {
    const client = await this.getClient();
    const { Upload } = await import('@aws-sdk/lib-storage');
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType ?? 'application/octet-stream',
      },
      queueSize: 4,
      partSize: 10 * 1024 * 1024,
    });

    const result = await upload.done();
    const size = (result as any)?.ContentLength;
    if (typeof size === 'number') return size;

    // Fallback: query the object size
    const meta = await this.getObjectMetadata(bucket, key);
    return meta?.contentLength ?? 0;
  }

  async getPresignedUploadUrl(
    bucket: string,
    key: string,
    opts?: PresignUploadOpts,
  ): Promise<string> {
    const presignClient = await this.getPresignClient();
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: opts?.contentType,
    });
    return getSignedUrl(presignClient, command, {
      expiresIn: opts?.expiresInSeconds ?? DEFAULT_TTL,
    });
  }

  async getPresignedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds?: number,
  ): Promise<string> {
    const presignClient = await this.getPresignClient();
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(presignClient, command, {
      expiresIn: expiresInSeconds ?? DEFAULT_TTL,
    });
  }

  async ensureBucket(name: string): Promise<void> {
    try {
      const client = await this.getClient();
      const { CreateBucketCommand } = await import('@aws-sdk/client-s3');
      await client.send(new CreateBucketCommand({ Bucket: name }));
    } catch (err: unknown) {
      const code = (err as { name?: string })?.name;
      if (code === 'BucketAlreadyOwnedByYou' || code === 'BucketAlreadyExists') return;
      throw err;
    }
  }

  async setBucketCors(name: string, rules: StorageCorsRule[]): Promise<void> {
    const client = await this.getClient();
    const { PutBucketCorsCommand } = await import('@aws-sdk/client-s3');
    const command = new PutBucketCorsCommand({
      Bucket: name,
      CORSConfiguration: {
        CORSRules: rules.map((r) => ({
          AllowedOrigins: r.origins,
          AllowedMethods: r.methods,
          AllowedHeaders: r.headers ?? ['*'],
          MaxAgeSeconds: r.maxAgeSeconds ?? 3600,
        })),
      },
    });

    if (this.config.forcePathStyle) {
      addS3CompatibleMd5Middleware(command);
    }

    await client.send(command);
  }

  async setBucketPublicReadPolicy(name: string): Promise<void> {
    const client = await this.getClient();
    const { PutBucketPolicyCommand, PutPublicAccessBlockCommand } = await import(
      '@aws-sdk/client-s3'
    );
    // Relax bucket-level Block Public Access so the public-read policy is
    // accepted. AWS auto-applies BPA to all newly created buckets, which
    // rejects PutBucketPolicy with public principals unless BlockPublicPolicy
    // and RestrictPublicBuckets are first set to false. Keep the ACL toggles
    // enabled — the bucket exposes objects through the policy, not via ACLs.
    try {
      await client.send(
        new PutPublicAccessBlockCommand({
          Bucket: name,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: false,
            RestrictPublicBuckets: false,
          },
        }),
      );
    } catch (err: unknown) {
      // MinIO and other S3-compatible backends may not implement the
      // PublicAccessBlock APIs. Treat NotImplemented as a no-op so the
      // public-read policy can still be applied.
      const errName = (err as { name?: string })?.name ?? '';
      if (errName !== 'NotImplemented') {
        throw err;
      }
    }
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'PublicReadGetObject',
          Effect: 'Allow',
          Principal: '*',
          Action: 's3:GetObject',
          Resource: `arn:aws:s3:::${name}/*`,
        },
      ],
    });
    await client.send(new PutBucketPolicyCommand({ Bucket: name, Policy: policy }));
  }
}

function addS3CompatibleMd5Middleware(command: { middlewareStack?: { add?: Function } }): void {
  command.middlewareStack?.add?.(
    (next: Function) => async (args: { request?: unknown }) => {
      const request = args.request as { headers?: Record<string, string>; body?: unknown } | undefined;
      if (!request?.headers) {
        return next(args);
      }

      const headers = { ...request.headers };
      deleteHeader(headers, 'x-amz-sdk-checksum-algorithm');
      deleteHeader(headers, 'x-amz-checksum-crc32');
      deleteHeader(headers, 'x-amz-checksum-crc32c');
      deleteHeader(headers, 'x-amz-checksum-crc64nvme');
      deleteHeader(headers, 'x-amz-checksum-sha1');
      deleteHeader(headers, 'x-amz-checksum-sha256');

      if (!hasHeader(headers, 'content-md5')) {
        const body = bodyToBuffer(request.body);
        if (body) {
          headers['content-md5'] = createHash('md5').update(body).digest('base64');
        }
      }

      return next({
        ...args,
        request: {
          ...request,
          headers,
        },
      });
    },
    {
      name: 's3CompatibleMd5ForBucketCors',
      step: 'build',
      priority: 'low',
      override: true,
    },
  );
}

function deleteHeader(headers: Record<string, string>, header: string): void {
  const found = Object.keys(headers).find((key) => key.toLowerCase() === header);
  if (found) {
    delete headers[found];
  }
}

function hasHeader(headers: Record<string, string>, header: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === header);
}

function bodyToBuffer(body: unknown): Buffer | null {
  if (typeof body === 'string') {
    return Buffer.from(body);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return null;
}
