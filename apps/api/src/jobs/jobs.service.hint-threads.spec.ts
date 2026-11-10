import { describe, expect, it, vi } from 'vitest';
import { JobsService } from './jobs.service';

/** Threads by id, with the project each belongs to. */
const THREAD_PROJECTS: Record<string, string> = { thr_own: 'proj_a', thr_other: 'proj_b' };

/** A tagged-template DB stand-in: knows threads, has no child jobs. */
async function fakeDb(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  const sql = strings.join('?');
  if (/FROM threads/i.test(sql)) {
    const id = String(values[0]);
    const projectId = THREAD_PROJECTS[id];
    return projectId ? [{ id, project_id: projectId, org_id: null }] : [];
  }
  return [];
}

function serviceFor(threadId: string) {
  const service = new JobsService(fakeDb as never, {} as never, {} as never, {} as never);
  const internals = service as unknown as Record<string, unknown>;
  internals.jobs = {
    findById: vi.fn(async () => ({
      id: 'alpha-1',
      project_id: 'proj_a',
      hints: { coordination: { thread_id: threadId } },
    })),
  };
  const listByThread = vi.fn(async () => [
    { id: 'msg_1', actor_id: 'user_x', body: 'thread text', created_at: new Date() },
  ]);
  internals.threadMessages = { listByThread };
  return { service, listByThread };
}

describe('JobsService.supervise coordination thread', () => {
  it("does not read another project's thread named in the job's hints", async () => {
    const { service, listByThread } = serviceFor('thr_other');

    const out = await service.supervise('alpha-1', '2000-01-01T00:00:00Z', 1);

    expect(listByThread).not.toHaveBeenCalled();
    expect(out.inbox).toEqual([]);
  });

  it("reads the job's own project coordination thread", async () => {
    const { service, listByThread } = serviceFor('thr_own');

    const out = await service.supervise('alpha-1', '2000-01-01T00:00:00Z', 1);

    expect(listByThread).toHaveBeenCalledWith('thr_own', expect.anything());
    expect(out.inbox.map((m) => m.body)).toEqual(['thread text']);
  });
});
