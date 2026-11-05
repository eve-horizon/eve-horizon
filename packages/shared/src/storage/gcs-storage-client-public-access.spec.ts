import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GcsStorageClient } from './gcs-storage-client.js';

const { getPolicy, setPolicy } = vi.hoisted(() => ({ getPolicy: vi.fn(), setPolicy: vi.fn() }));

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn().mockImplementation(() => ({
    bucket: vi.fn().mockImplementation(() => ({ iam: { getPolicy, setPolicy } })),
  })),
}));

describe('GcsStorageClient.removeBucketPublicReadPolicy', () => {
  beforeEach(() => {
    getPolicy.mockReset();
    setPolicy.mockReset().mockResolvedValue([{}]);
  });

  it('removes public members and keeps every other grant', async () => {
    getPolicy.mockResolvedValue([{
      version: 3,
      etag: 'abc',
      bindings: [
        { role: 'roles/storage.objectViewer', members: ['allUsers'] },
        { role: 'roles/storage.objectAdmin', members: ['serviceAccount:app@p.iam.gserviceaccount.com', 'allAuthenticatedUsers'] },
        { role: 'roles/storage.legacyBucketOwner', members: ['projectOwner:p'] },
      ],
    }]);

    await new GcsStorageClient({}).removeBucketPublicReadPolicy('eve-app-acme-web-prod-assets');

    expect(getPolicy).toHaveBeenCalledWith({ requestedPolicyVersion: 3 });
    expect(setPolicy).toHaveBeenCalledWith({
      version: 3,
      etag: 'abc',
      bindings: [
        { role: 'roles/storage.objectAdmin', members: ['serviceAccount:app@p.iam.gserviceaccount.com'] },
        { role: 'roles/storage.legacyBucketOwner', members: ['projectOwner:p'] },
      ],
    });
  });

  it('does not rewrite a policy with no public members', async () => {
    getPolicy.mockResolvedValue([{ bindings: [{ role: 'roles/storage.legacyBucketOwner', members: ['projectOwner:p'] }] }]);

    await new GcsStorageClient({}).removeBucketPublicReadPolicy('eve-app-acme-web-prod-assets');

    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('treats a missing bucket as already private', async () => {
    getPolicy.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 404 }));

    await expect(new GcsStorageClient({}).removeBucketPublicReadPolicy('gone')).resolves.toBeUndefined();
  });

  it('surfaces other failures', async () => {
    getPolicy.mockRejectedValue(Object.assign(new Error('Forbidden'), { code: 403 }));

    await expect(new GcsStorageClient({}).removeBucketPublicReadPolicy('x')).rejects.toThrow('Forbidden');
  });
});
