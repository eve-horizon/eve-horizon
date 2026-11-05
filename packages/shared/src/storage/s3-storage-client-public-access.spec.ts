import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3StorageClient } from './s3-storage-client.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => {
  const command = (type: string) => vi.fn().mockImplementation((input: unknown) => ({ type, input }));
  return {
    S3Client: vi.fn().mockImplementation(() => ({ send })),
    PutPublicAccessBlockCommand: command('PutPublicAccessBlock'),
    GetBucketPolicyCommand: command('GetBucketPolicy'),
    PutBucketPolicyCommand: command('PutBucketPolicy'),
    DeleteBucketPolicyCommand: command('DeleteBucketPolicy'),
  };
});

type Sent = { type: string; input: Record<string, unknown> };

function s3Error(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

const EVE_PUBLIC_STATEMENT = {
  Sid: 'PublicReadGetObject',
  Effect: 'Allow',
  Principal: '*',
  Action: 's3:GetObject',
  Resource: 'arn:aws:s3:::assets/*',
};

function respond(handlers: Record<string, (input: Record<string, unknown>) => unknown>) {
  send.mockImplementation(async (cmd: Sent) => {
    const handler = handlers[cmd.type];
    return handler ? handler(cmd.input) : {};
  });
}

const sentTypes = () => send.mock.calls.map(([cmd]: [Sent]) => cmd.type);

describe('S3StorageClient.removeBucketPublicReadPolicy', () => {
  const client = () => new S3StorageClient({ region: 'eu-west-1' });

  beforeEach(() => {
    send.mockReset();
  });

  it('re-blocks public access and deletes a policy that only granted public read', async () => {
    respond({
      GetBucketPolicy: () => ({ Policy: JSON.stringify({ Version: '2012-10-17', Statement: [EVE_PUBLIC_STATEMENT] }) }),
    });

    await client().removeBucketPublicReadPolicy('assets');

    expect(sentTypes()).toEqual(['PutPublicAccessBlock', 'GetBucketPolicy', 'DeleteBucketPolicy']);
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: 'assets',
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('keeps statements that are not public', async () => {
    const tlsOnly = { Sid: 'DenyInsecure', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: '*' };
    respond({
      GetBucketPolicy: () => ({ Policy: JSON.stringify({ Version: '2012-10-17', Statement: [EVE_PUBLIC_STATEMENT, tlsOnly] }) }),
    });

    await client().removeBucketPublicReadPolicy('assets');

    expect(sentTypes()).toEqual(['PutPublicAccessBlock', 'GetBucketPolicy', 'PutBucketPolicy']);
    expect(JSON.parse(send.mock.calls[2][0].input.Policy as string)).toEqual({
      Version: '2012-10-17',
      Statement: [tlsOnly],
    });
  });

  it('handles MinIO, which has no Block Public Access and normalises the principal', async () => {
    respond({
      PutPublicAccessBlock: () => { throw s3Error('NotImplemented'); },
      GetBucketPolicy: () => ({
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::assets/*'] }],
        }),
      }),
    });

    await client().removeBucketPublicReadPolicy('assets');

    expect(sentTypes()).toEqual(['PutPublicAccessBlock', 'GetBucketPolicy', 'DeleteBucketPolicy']);
  });

  it('does nothing more when the bucket has no policy', async () => {
    respond({ GetBucketPolicy: () => { throw s3Error('NoSuchBucketPolicy'); } });

    await client().removeBucketPublicReadPolicy('assets');

    expect(sentTypes()).toEqual(['PutPublicAccessBlock', 'GetBucketPolicy']);
  });

  it('accepts a denied policy delete once Block Public Access is back on', async () => {
    respond({
      GetBucketPolicy: () => ({ Policy: JSON.stringify({ Statement: [EVE_PUBLIC_STATEMENT] }) }),
      DeleteBucketPolicy: () => { throw s3Error('AccessDenied'); },
    });

    await expect(client().removeBucketPublicReadPolicy('assets')).resolves.toBeUndefined();
  });

  it('fails when the public statement cannot be removed and nothing blocks it', async () => {
    respond({
      PutPublicAccessBlock: () => { throw s3Error('NotImplemented'); },
      GetBucketPolicy: () => ({ Policy: JSON.stringify({ Statement: [EVE_PUBLIC_STATEMENT] }) }),
      DeleteBucketPolicy: () => { throw s3Error('AccessDenied'); },
    });

    await expect(client().removeBucketPublicReadPolicy('assets')).rejects.toThrow('AccessDenied');
  });

  it('treats a missing bucket as already private', async () => {
    respond({ PutPublicAccessBlock: () => { throw s3Error('NoSuchBucket'); } });

    await expect(client().removeBucketPublicReadPolicy('gone')).resolves.toBeUndefined();
    expect(sentTypes()).toEqual(['PutPublicAccessBlock']);
  });
});
