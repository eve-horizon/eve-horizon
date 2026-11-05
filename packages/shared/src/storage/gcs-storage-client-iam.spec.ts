import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GcsStorageClient } from './gcs-storage-client.js';
import { supportsBucketIamMembers } from './storage-client.js';
import { S3StorageClient } from './s3-storage-client.js';

const { getPolicy, setPolicy } = vi.hoisted(() => ({ getPolicy: vi.fn(), setPolicy: vi.fn() }));

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn().mockImplementation(() => ({
    bucket: vi.fn().mockImplementation(() => ({ iam: { getPolicy, setPolicy } })),
  })),
}));

const ROLE = 'roles/storage.objectUser';
const MEMBER = 'principal://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p-123.svc.id.goog/subject/ns/eve-a-b-c/sa/eve-app';
const OTHER = 'principal://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p-123.svc.id.goog/subject/ns/eve-a-b-d/sa/eve-app';
const OWNER = { role: 'roles/storage.legacyBucketOwner', members: ['projectOwner:p-123'] };

describe('GcsStorageClient bucket IAM members', () => {
  beforeEach(() => {
    getPolicy.mockReset();
    setPolicy.mockReset().mockResolvedValue([{}]);
  });

  it('is recognised as supporting bucket IAM; the S3 client is not', () => {
    // Prototypes, not instances: constructing a client starts a background
    // import of the storage SDK that would race the next test's import.
    expect(supportsBucketIamMembers(GcsStorageClient.prototype)).toBe(true);
    expect(supportsBucketIamMembers(S3StorageClient.prototype)).toBe(false);
  });

  it('adds a binding for a new role', async () => {
    getPolicy.mockResolvedValue([{ etag: 'e1', bindings: [OWNER] }]);

    await new GcsStorageClient({}).addBucketIamMember('eve-app-a-b-c-uploads', ROLE, MEMBER);

    expect(setPolicy).toHaveBeenCalledWith({ etag: 'e1', bindings: [OWNER, { role: ROLE, members: [MEMBER] }] });
  });

  it('adds the member to the existing unconditional binding', async () => {
    const conditional = { role: ROLE, members: [OTHER], condition: { expression: 'true', title: 't' } };
    getPolicy.mockResolvedValue([{ bindings: [conditional, { role: ROLE, members: [OTHER] }] }]);

    await new GcsStorageClient({}).addBucketIamMember('eve-app-a-b-c-uploads', ROLE, MEMBER);

    expect(setPolicy).toHaveBeenCalledWith({ bindings: [conditional, { role: ROLE, members: [OTHER, MEMBER] }] });
  });

  it('does not rewrite the policy when the member is already bound', async () => {
    getPolicy.mockResolvedValue([{ bindings: [{ role: ROLE, members: [MEMBER] }] }]);

    await new GcsStorageClient({}).addBucketIamMember('eve-app-a-b-c-uploads', ROLE, MEMBER);

    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('removes only the member, dropping a binding it leaves empty', async () => {
    getPolicy.mockResolvedValue([{ bindings: [OWNER, { role: ROLE, members: [MEMBER] }, { role: 'roles/x', members: [MEMBER] }] }]);

    await new GcsStorageClient({}).removeBucketIamMember('eve-app-a-b-c-uploads', ROLE, MEMBER);

    expect(setPolicy).toHaveBeenCalledWith({ bindings: [OWNER, { role: 'roles/x', members: [MEMBER] }] });
  });

  it('keeps other members of the role', async () => {
    getPolicy.mockResolvedValue([{ bindings: [{ role: ROLE, members: [OTHER, MEMBER] }] }]);

    await new GcsStorageClient({}).removeBucketIamMember('eve-app-a-b-c-uploads', ROLE, MEMBER);

    expect(setPolicy).toHaveBeenCalledWith({ bindings: [{ role: ROLE, members: [OTHER] }] });
  });

  it('is a no-op when the member is absent or the bucket is gone', async () => {
    getPolicy.mockResolvedValueOnce([{ bindings: [OWNER] }]);
    await new GcsStorageClient({}).removeBucketIamMember('eve-app-a-b-c-uploads', ROLE, MEMBER);
    getPolicy.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { code: 404 }));
    await new GcsStorageClient({}).removeBucketIamMember('eve-app-a-b-c-gone', ROLE, MEMBER);

    expect(setPolicy).not.toHaveBeenCalled();
  });
});
