import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GcsStorageClient } from './gcs-storage-client.js';

const { createBucket, getMetadata } = vi.hoisted(() => ({ createBucket: vi.fn(), getMetadata: vi.fn() }));

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn().mockImplementation(() => ({
    createBucket,
    bucket: vi.fn().mockImplementation(() => ({ getMetadata })),
  })),
}));

function gcsError(code: number): Error & { code: number } {
  return Object.assign(new Error(`HTTP ${code}`), { code });
}

describe('GcsStorageClient.ensureBucket', () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn();

  beforeEach(() => {
    createBucket.mockReset();
    getMetadata.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.EVE_STORAGE_GCP_PROJECT_NUMBER;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it('creates a new bucket without an ownership lookup', async () => {
    createBucket.mockResolvedValue([{}]);
    const client = new GcsStorageClient({ region: 'europe-west2', projectNumber: '111' });

    await client.ensureBucket('eve-app-acme-web-prod-uploads');

    expect(createBucket).toHaveBeenCalledWith('eve-app-acme-web-prod-uploads', { location: 'europe-west2' });
    expect(getMetadata).not.toHaveBeenCalled();
  });

  it('adopts an existing bucket owned by the platform project', async () => {
    createBucket.mockRejectedValue(gcsError(409));
    getMetadata.mockResolvedValue([{ projectNumber: '111' }]);
    const client = new GcsStorageClient({ projectNumber: '111' });

    await expect(client.ensureBucket('eve-app-acme-web-prod-uploads')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an existing bucket owned by another project', async () => {
    createBucket.mockRejectedValue(gcsError(409));
    getMetadata.mockResolvedValue([{ projectNumber: '999' }]);
    const client = new GcsStorageClient({ projectNumber: '111' });

    await expect(client.ensureBucket('eve-app-acme-web-prod-uploads')).rejects.toThrow(
      /already exists in another Google Cloud project \(project number 999, expected 111\)/,
    );
  });

  it('refuses an existing bucket the platform cannot read', async () => {
    createBucket.mockRejectedValue(gcsError(409));
    getMetadata.mockRejectedValue(gcsError(403));
    const client = new GcsStorageClient({ projectNumber: '111' });

    await expect(client.ensureBucket('eve-app-acme-web-prod-uploads')).rejects.toThrow(
      /cannot read it \(HTTP 403\); it belongs to another Google Cloud project/,
    );
  });

  it('reads the platform project number from EVE_STORAGE_GCP_PROJECT_NUMBER', async () => {
    process.env.EVE_STORAGE_GCP_PROJECT_NUMBER = '222';
    createBucket.mockRejectedValue(gcsError(409));
    getMetadata.mockResolvedValue([{ projectNumber: 222 }]);
    const client = new GcsStorageClient({});

    await expect(client.ensureBucket('eve-org-acme')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the metadata server for the platform project number', async () => {
    createBucket.mockRejectedValue(gcsError(409));
    getMetadata.mockResolvedValue([{ projectNumber: '333' }]);
    fetchMock.mockResolvedValue(new Response('333\n', { status: 200 }));
    const client = new GcsStorageClient({});

    await client.ensureBucket('eve-org-acme');
    await client.ensureBucket('eve-org-acme');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id',
      expect.objectContaining({ headers: { 'Metadata-Flavor': 'Google' } }),
    );
  });

  it('fails closed with a configuration hint when the owner cannot be verified', async () => {
    createBucket.mockRejectedValue(gcsError(409));
    getMetadata.mockResolvedValue([{ projectNumber: '333' }]);
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND metadata.google.internal'));
    const client = new GcsStorageClient({});

    await expect(client.ensureBucket('eve-org-acme')).rejects.toThrow(/set EVE_STORAGE_GCP_PROJECT_NUMBER/);
  });

  it('passes through errors other than 409', async () => {
    createBucket.mockRejectedValue(gcsError(403));
    const client = new GcsStorageClient({ projectNumber: '111' });

    await expect(client.ensureBucket('eve-org-acme')).rejects.toThrow('HTTP 403');
    expect(getMetadata).not.toHaveBeenCalled();
  });
});
