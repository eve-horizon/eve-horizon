import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageInternalController } from './storage.internal.controller';
import type { StorageService } from './storage.service';

/** Jobs and the org of their project. */
const JOB_ORGS: Record<string, string> = { 'alpha-1': 'org_a' };

/** A tagged-template DB stand-in that answers a job's org. */
async function fakeDb(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  const sql = strings.join('?');
  if (/FROM jobs/i.test(sql)) {
    const org = JOB_ORGS[String(values[0])];
    return org ? [{ org_id: org }] : [];
  }
  return [];
}

describe('internal chat attachment presign', () => {
  const storage = {
    internalBucket: 'internal',
    getPresignedUploadUrl: vi.fn(async () => 'https://storage.test/upload'),
    getPresignedDownloadUrl: vi.fn(async () => 'https://storage.test/download'),
  };
  let controller: StorageInternalController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new (StorageInternalController as unknown as new (...args: unknown[]) => StorageInternalController)(
      storage as unknown as StorageService,
      fakeDb,
    );
  });

  it.each([
    ['another org', 'chat-attachments/org_b/slack:T1/C1/1.2/f.pdf'],
    ['a dot segment', 'chat-attachments/org_a/../org_b/slack:T1/C1/1.2/f.pdf'],
    ['an org id prefix', 'chat-attachments/org_a_other/slack:T1/C1/1.2/f.pdf'],
  ])("refuses a job's download of %s key", async (_label, key) => {
    await expect(
      controller.presign({ key, operation: 'download', job_id: 'alpha-1' } as never),
    ).rejects.toThrow();
    expect(storage.getPresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it('refuses a download that names no job', async () => {
    await expect(
      controller.presign({ key: 'chat-attachments/org_a/slack:T1/C1/1.2/f.pdf', operation: 'download' } as never),
    ).rejects.toThrow();
    expect(storage.getPresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("presigns a download of the job's own org attachment", async () => {
    await expect(
      controller.presign({
        key: 'chat-attachments/org_a/slack:T1/C1/1.2/f.pdf',
        operation: 'download',
        job_id: 'alpha-1',
      } as never),
    ).resolves.toEqual({ url: 'https://storage.test/download' });
  });

  it('still presigns gateway uploads', async () => {
    await expect(
      controller.presign({
        key: 'chat-attachments/org_a/slack:T1/C1/1.2/f.pdf',
        operation: 'upload',
        content_type: 'application/pdf',
      } as never),
    ).resolves.toEqual({ url: 'https://storage.test/upload' });
  });
});
