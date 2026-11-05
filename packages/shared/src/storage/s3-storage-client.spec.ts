import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3StorageClient } from './s3-storage-client.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send })),
  CreateBucketCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

function s3Error(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

describe('S3StorageClient.ensureBucket', () => {
  beforeEach(() => {
    send.mockReset();
  });

  const client = () => new S3StorageClient({ region: 'eu-west-1' });

  it('creates a new bucket', async () => {
    send.mockResolvedValue({});
    await expect(client().ensureBucket('eve-app-acme-web-prod-uploads')).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith({ input: { Bucket: 'eve-app-acme-web-prod-uploads' } });
  });

  it('adopts a bucket the backend says this account already owns', async () => {
    send.mockRejectedValue(s3Error('BucketAlreadyOwnedByYou'));
    await expect(client().ensureBucket('eve-app-acme-web-prod-uploads')).resolves.toBeUndefined();
  });

  it.each(['BucketAlreadyExists', 'BucketNameUnavailable'])(
    'refuses a bucket name held by another account (%s)',
    async (code) => {
      send.mockRejectedValue(s3Error(code));
      await expect(client().ensureBucket('eve-app-acme-web-prod-uploads')).rejects.toThrow(
        `Bucket name "eve-app-acme-web-prod-uploads" is already owned by another account (${code})`,
      );
    },
  );

  it('passes through other errors', async () => {
    send.mockRejectedValue(s3Error('AccessDenied'));
    await expect(client().ensureBucket('eve-app-acme-web-prod-uploads')).rejects.toThrow('AccessDenied');
  });
});
