import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough, Readable } from 'stream';
import { executeSnapshot, executeRestore } from '../snapshot-executor.js';
import type { ObjectStorageClient } from '../../storage/index.js';

const dbConfig = {
  host: 'localhost',
  port: 5432,
  username: 'test',
  password: 'test',
  database: 'test',
};

/**
 * Storage stub whose uploadStream consumes the source stream and resolves
 * once it ends — mirroring the real S3 client closely enough to exercise
 * the executor's process-error handling.
 */
function stubStorageClient(): ObjectStorageClient {
  return {
    uploadStream: async (_bucket: string, _key: string, stream: Readable) => {
      let size = 0;
      for await (const chunk of stream) size += (chunk as Buffer).length;
      return size;
    },
    getObjectStream: async () => {
      const s = new PassThrough();
      s.end('not-a-real-dump');
      return s;
    },
  } as unknown as ObjectStorageClient;
}

describe('snapshot executor spawn failures', () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    // Empty PATH makes spawn('pg_dump')/spawn('pg_restore') fail with ENOENT,
    // reproducing a container image without postgres client tools.
    originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('executeSnapshot rejects (not process crash) when pg_dump is missing', async () => {
    await expect(
      executeSnapshot(dbConfig, {
        client: stubStorageClient(),
        bucket: 'test-bucket',
        key: 'test-key',
      }),
    ).rejects.toThrow(/pg_dump is not installed/);
  });

  it('executeRestore rejects (not process crash) when pg_restore is missing', async () => {
    await expect(
      executeRestore(dbConfig, {
        client: stubStorageClient(),
        bucket: 'test-bucket',
        key: 'test-key',
      }),
    ).rejects.toThrow(/pg_restore is not installed/);
  });
});
