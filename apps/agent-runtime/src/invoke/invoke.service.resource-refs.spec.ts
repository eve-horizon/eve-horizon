import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { HarnessInvocation } from '@eve/shared';
import { InvokeService } from './invoke.service';

type Row = Record<string, unknown>;
type Hydration = { summary: { resources: Row[] } };
type Hydrator = { hydrateResources(invocation: HarnessInvocation, orgId: string, repoPath: string): Promise<Hydration> };

/** reader-1 runs as user_owner; lead-1 holds one attachment by user_owner and one by user_mate. */
const JOBS: Record<string, Row> = {
  'reader-1': { id: 'reader-1', project_id: 'proj_a', actor_user_id: 'user_owner' },
  'lead-1': { id: 'lead-1', project_id: 'proj_a', actor_user_id: 'user_owner' },
};
const LEAD_ATTACHMENTS: Record<string, Row> = {
  'brief.md': { content: 'Owner brief', content_hash: 'h1', created_by: 'user_owner' },
  'notes.md': { content: 'Teammate notes', content_hash: 'h2', created_by: 'user_mate' },
};

function hydrator(): Hydrator {
  const service = new InvokeService(vi.fn(async () => []) as never);
  const inner = service as unknown as Row;
  inner.jobs = { findById: vi.fn(async (id: string) => JOBS[id] ?? null) };
  inner.projects = { findById: vi.fn(async (id: string) => (id === 'proj_a' ? { id, org_id: 'org_a' } : null)) };
  inner.attachments = {
    findByJobIdAndName: vi.fn(async (jobId: string, name: string) => (jobId === 'lead-1' ? LEAD_ATTACHMENTS[name] ?? null : null)),
  };
  return service as unknown as Hydrator;
}

function readerOf(uri: string): HarnessInvocation {
  return {
    jobId: 'reader-1',
    attemptId: '00000000-0000-0000-0000-000000000001',
    projectId: 'proj_a',
    text: 'test',
    resource_refs: [{ uri, required: false }],
  } as unknown as HarnessInvocation;
}

describe('job attachment resource refs', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-refs-'));
  });

  afterEach(async () => {
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("takes in another job's attachment that the reading job's actor created", async () => {
    const { summary } = await hydrator().hydrateResources(readerOf('job_attachments:/lead-1/brief.md'), 'org_a', repoPath);

    expect(summary.resources[0]).toMatchObject({ status: 'resolved' });
    const localPath = path.join(repoPath, String(summary.resources[0].local_path));
    await expect(fs.readFile(localPath, 'utf8')).resolves.toBe('Owner brief');
  });

  it('skips an attachment someone else created, with a reason', async () => {
    const { summary } = await hydrator().hydrateResources(readerOf('job_attachments:/lead-1/notes.md'), 'org_a', repoPath);

    expect(summary.resources[0]).toMatchObject({ status: 'missing', error_code: 'resource_access_denied' });
    const files = await fs.readdir(path.join(repoPath, '.eve', 'resources'), { recursive: true });
    expect(files.filter((f) => String(f).endsWith('notes.md'))).toEqual([]);
  });
});
