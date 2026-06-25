import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type {
  ObjectStorageClient,
  StorageGetObjectResult,
  StorageObjectMetadata,
  StorageCorsRule,
  PresignUploadOpts,
} from './storage-client.js';

const DEFAULT_TTL = 300;

/**
 * Native GCS storage client using Application Default Credentials.
 *
 * Used when EVE_STORAGE_BACKEND=gcs and no HMAC keys are provided.
 * On GKE this authenticates via Workload Identity — no static keys needed.
 *
 * Uses dynamic import so @google-cloud/storage is only loaded at runtime
 * when this code path is actually used. AWS deployments never load it.
 */
export class GcsStorageClient implements ObjectStorageClient {
  private storagePromise: Promise<any>;
  private readonly location: string;

  constructor(config: { region?: string }) {
    this.location = config.region ?? 'us';
    this.storagePromise = this.initStorage();
  }

  private async initStorage() {
    const { Storage } = await import('@google-cloud/storage');
    return new Storage();
  }

  private async getStorage() {
    return this.storagePromise;
  }

  async getObject(bucket: string, key: string): Promise<StorageGetObjectResult> {
    const storage = await this.getStorage();
    const [buf] = await storage.bucket(bucket).file(key).download();
    const [metadata] = await storage.bucket(bucket).file(key).getMetadata();
    return { body: buf, contentType: metadata.contentType };
  }

  async getObjectStream(bucket: string, key: string): Promise<Readable> {
    const storage = await this.getStorage();
    return storage.bucket(bucket).file(key).createReadStream();
  }

  async getObjectMetadata(bucket: string, key: string): Promise<StorageObjectMetadata | null> {
    try {
      const storage = await this.getStorage();
      const [metadata] = await storage.bucket(bucket).file(key).getMetadata();
      return {
        contentType: metadata.contentType ?? 'application/octet-stream',
        contentLength: Number(metadata.size) || 0,
        etag: metadata.etag ?? '',
      };
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      if (code === 404) return null;
      throw err;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const storage = await this.getStorage();
    await storage.bucket(bucket).file(key).delete({ ignoreNotFound: true });
  }

  async uploadStream(
    bucket: string,
    key: string,
    body: Readable,
    contentType?: string,
  ): Promise<number> {
    const storage = await this.getStorage();
    const file = storage.bucket(bucket).file(key);
    const writable = file.createWriteStream({
      resumable: true,
      contentType: contentType ?? 'application/octet-stream',
    });
    await pipeline(body, writable);
    const [metadata] = await file.getMetadata();
    return Number(metadata.size) || 0;
  }

  async getPresignedUploadUrl(
    bucket: string,
    key: string,
    opts?: PresignUploadOpts,
  ): Promise<string> {
    const storage = await this.getStorage();
    const [url] = await storage
      .bucket(bucket)
      .file(key)
      .getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + (opts?.expiresInSeconds ?? DEFAULT_TTL) * 1000,
        contentType: opts?.contentType,
      });
    return url;
  }

  async getPresignedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds?: number,
  ): Promise<string> {
    const storage = await this.getStorage();
    const [url] = await storage
      .bucket(bucket)
      .file(key)
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + (expiresInSeconds ?? DEFAULT_TTL) * 1000,
      });
    return url;
  }

  async ensureBucket(name: string): Promise<void> {
    const storage = await this.getStorage();
    try {
      await storage.createBucket(name, { location: this.location });
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      // 409 = bucket already exists
      if (code === 409) return;
      throw err;
    }
  }

  async setBucketCors(name: string, rules: StorageCorsRule[]): Promise<void> {
    const storage = await this.getStorage();
    await storage.bucket(name).setCorsConfiguration(
      rules.map((r) => ({
        origin: r.origins,
        method: r.methods,
        responseHeader: r.headers ?? ['*'],
        maxAgeSeconds: r.maxAgeSeconds ?? 3600,
      })),
    );
  }

  async setBucketPublicReadPolicy(name: string): Promise<void> {
    const storage = await this.getStorage();
    const bucket = storage.bucket(name);
    const [policy] = await bucket.iam.getPolicy({ requestedPolicyVersion: 3 });
    policy.bindings = policy.bindings || [];
    policy.bindings.push({
      role: 'roles/storage.objectViewer',
      members: ['allUsers'],
    });
    await bucket.iam.setPolicy(policy);
  }
}
