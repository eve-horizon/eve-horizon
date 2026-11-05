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
const METADATA_TIMEOUT_MS = 3000;

export interface GcsStorageClientConfig {
  region?: string;
  /**
   * Numeric ID of the Google Cloud project that must own every bucket this
   * client creates or adopts. Defaults to EVE_STORAGE_GCP_PROJECT_NUMBER, then
   * to the project the GKE/GCE metadata server reports.
   */
  projectNumber?: string;
}

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
  private readonly configuredProjectNumber?: string;
  private projectNumberPromise: Promise<string | null> | null = null;

  constructor(config: GcsStorageClientConfig) {
    this.location = config.region ?? 'us';
    this.configuredProjectNumber =
      config.projectNumber?.trim() || process.env.EVE_STORAGE_GCP_PROJECT_NUMBER?.trim() || undefined;
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

  /**
   * Create a bucket, or adopt an existing one only when this platform's
   * project owns it. Bucket names are global, so GCS answers 409 both for a
   * bucket we already own and for a name another project holds; adopting the
   * latter would let an outsider pre-create a predictable app bucket name and
   * receive the app's writes.
   */
  async ensureBucket(name: string): Promise<void> {
    const storage = await this.getStorage();
    try {
      await storage.createBucket(name, { location: this.location });
    } catch (err: unknown) {
      if (gcsErrorCode(err) !== 409) throw err;
      await this.assertBucketOwnedByPlatform(storage, name);
    }
  }

  private async assertBucketOwnedByPlatform(storage: any, name: string): Promise<void> {
    let metadata: { projectNumber?: string | number } | undefined;
    try {
      [metadata] = await storage.bucket(name).getMetadata();
    } catch (err: unknown) {
      const code = gcsErrorCode(err);
      if (code === 401 || code === 403 || code === 404) {
        throw new Error(
          `Bucket name "${name}" already exists but this platform cannot read it (HTTP ${code}); ` +
            'it belongs to another Google Cloud project. Refusing to use it.',
        );
      }
      throw err;
    }

    const expected = await this.resolveProjectNumber();
    if (!expected) {
      throw new Error(
        `Bucket "${name}" already exists and its owner cannot be verified: ` +
          'set EVE_STORAGE_GCP_PROJECT_NUMBER to the numeric ID of the project that owns Eve buckets ' +
          '(the GCE/GKE metadata server was not reachable).',
      );
    }

    const actual = metadata?.projectNumber == null ? '' : String(metadata.projectNumber);
    if (actual !== expected) {
      throw new Error(
        `Bucket "${name}" already exists in another Google Cloud project ` +
          `(project number ${actual || 'unknown'}, expected ${expected}). Refusing to use it.`,
      );
    }
  }

  private resolveProjectNumber(): Promise<string | null> {
    if (this.configuredProjectNumber) {
      return Promise.resolve(this.configuredProjectNumber);
    }
    if (!this.projectNumberPromise) {
      this.projectNumberPromise = fetchMetadataProjectNumber().then((value) => {
        if (!value) this.projectNumberPromise = null; // retry on the next call
        return value;
      });
    }
    return this.projectNumberPromise;
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

function gcsErrorCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Numeric project ID from the GCE/GKE metadata server (Workload Identity
 * serves it too). Returns null off Google Cloud or on any failure.
 */
async function fetchMetadataProjectNumber(): Promise<string | null> {
  const host = process.env.GCE_METADATA_HOST?.trim() || 'metadata.google.internal';
  try {
    const res = await fetch(`http://${host}/computeMetadata/v1/project/numeric-project-id`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.text()).trim();
    return /^\d+$/.test(body) ? body : null;
  } catch {
    return null;
  }
}
