import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobs: { findById: vi.fn() },
  messages: { create: vi.fn() },
  threads: { findById: vi.fn() },
}));

vi.mock('@eve/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eve/db')>()),
  jobQueries: vi.fn(() => mocks.jobs),
  threadMessageQueries: vi.fn(() => mocks.messages),
  threadQueries: vi.fn(() => mocks.threads),
}));

import { LoopService } from './loop.service';

/** Threads by id, with the project each belongs to. */
const THREADS: Record<string, { id: string; project_id: string | null; org_id: string | null }> = {
  thr_own: { id: 'thr_own', project_id: 'proj_a', org_id: null },
  thr_other: { id: 'thr_other', project_id: 'proj_b', org_id: null },
};

type LoopInternals = {
  relayToCoordinationThread(
    job: { id: string; parent_id: string | null; project_id: string; assignee: string | null },
    summary: string | undefined,
    attemptId: string,
  ): Promise<void>;
  processWakeOnConditions(): Promise<void>;
};

function loopWith(db: unknown): LoopInternals {
  const loop = Object.create(LoopService.prototype) as Record<string, unknown>;
  loop.db = db;
  loop.logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return loop as unknown as LoopInternals;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.threads.findById.mockImplementation(async (id: string) => THREADS[id] ?? null);
  mocks.messages.create.mockResolvedValue(undefined);
});

describe('relay of a child summary to the parent coordination thread', () => {
  function parentNaming(threadId: string) {
    mocks.jobs.findById.mockResolvedValue({
      id: 'alpha-1',
      project_id: 'proj_a',
      hints: { coordination: { thread_id: threadId } },
    });
  }

  const child = { id: 'alpha-1.1', parent_id: 'alpha-1', project_id: 'proj_a', assignee: 'coder' };

  it("does not write to another project's thread", async () => {
    parentNaming('thr_other');

    await loopWith((() => []) as never).relayToCoordinationThread(child, 'done', 'att_1');

    expect(mocks.messages.create).not.toHaveBeenCalled();
  });

  it("writes to the parent's own project thread", async () => {
    parentNaming('thr_own');

    await loopWith((() => []) as never).relayToCoordinationThread(child, 'done', 'att_1');

    expect(mocks.messages.create).toHaveBeenCalledWith(expect.objectContaining({ thread_id: 'thr_own' }));
  });
});

describe('wake_on thread.message', () => {
  function dbFor(threadId: string) {
    const updates: unknown[][] = [];
    const db = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (/UPDATE jobs SET defer_until = NULL/i.test(sql)) {
        updates.push(values);
        return [];
      }
      if (/FROM thread_messages/i.test(sql)) return [{ count: '3' }];
      if (/FROM jobs/i.test(sql)) {
        return [{
          id: 'alpha-1',
          project_id: 'proj_a',
          defer_until: new Date(Date.now() + 60_000),
          hints: { wait: { wake_on: ['thread.message'] }, coordination: { thread_id: threadId } },
        }];
      }
      return [];
    };
    return { db, updates };
  }

  it("is not woken by messages in another project's thread", async () => {
    const { db, updates } = dbFor('thr_other');

    await loopWith(db).processWakeOnConditions();

    expect(updates).toEqual([]);
  });

  it("is woken by messages in its own project's thread", async () => {
    const { db, updates } = dbFor('thr_own');

    await loopWith(db).processWakeOnConditions();

    expect(updates).toEqual([['alpha-1']]);
  });
});
