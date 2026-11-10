import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeCoordinationInbox } from '../coordination.js';
import { writeCarryoverContext } from '../carryover-context.js';
import { deliverProvisioningError, EveMessageRelay } from '../eve-message-relay.js';
import type { HarnessInvocation } from '../../types/harness.js';

/** Threads by id, with the project each belongs to. */
const THREAD_PROJECTS: Record<string, string> = { thr_own: 'proj_a', thr_other: 'proj_b' };

const message = {
  direction: 'outbound',
  actor_id: 'coder',
  actor_type: 'agent',
  created_at: new Date('2026-01-01T00:00:00Z'),
  body: 'sibling note',
};

/**
 * A DB facade for the invoke helpers. The parent job (alpha-1) names
 * `parentThread` as its coordination thread; the child (alpha-1.1) names
 * `ownThread` as its chat thread. Both jobs are in proj_a.
 */
function fakeDb(parentThread: string, ownThread = parentThread) {
  return {
    queryJobHints: vi.fn(async (jobId: string) =>
      jobId === 'alpha-1'
        ? { hints: { coordination: { thread_id: parentThread } }, project_id: 'proj_a' }
        : { hints: { thread_id: ownThread }, project_id: 'proj_a' }),
    findJobById: vi.fn(async () => ({
      hints: { thread_id: ownThread, agent_context: { threads: { coordination: true } } },
    })),
    findProjectById: vi.fn(async () => ({ org_id: 'org_a' })),
    findThreadProjectId: vi.fn(async (threadId: string) => THREAD_PROJECTS[threadId] ?? null),
    listThreadMessages: vi.fn(async () => [message]),
    createThreadMessage: vi.fn(async () => undefined),
    listOrgDocsByPrefix: vi.fn(async () => []),
    findOrgDocByPath: vi.fn(async () => undefined),
    findJobAttachment: vi.fn(async () => undefined),
  };
}

function invocation(): HarnessInvocation {
  return {
    attemptId: 'att_1',
    jobId: 'alpha-1.1',
    parentJobId: 'alpha-1',
    projectId: 'proj_a',
    text: 'work',
    workspacePath: '/tmp/unused',
  } as unknown as HarnessInvocation;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

describe('job hints name only threads of the job\'s own project', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'hint-threads-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(repo, { recursive: true, force: true });
  });

  describe('coordination inbox', () => {
    it("does not read another project's thread", async () => {
      const db = fakeDb('thr_other');
      await writeCoordinationInbox(invocation(), repo, db as never);
      expect(db.listThreadMessages).not.toHaveBeenCalled();
      expect(await exists(path.join(repo, '.eve', 'coordination-inbox.md'))).toBe(false);
    });

    it('reads its own project thread', async () => {
      const db = fakeDb('thr_own');
      await writeCoordinationInbox(invocation(), repo, db as never);
      expect(db.listThreadMessages).toHaveBeenCalledWith('thr_own', expect.anything());
      expect(await exists(path.join(repo, '.eve', 'coordination-inbox.md'))).toBe(true);
    });
  });

  describe('carryover context threads', () => {
    it("does not read another project's thread", async () => {
      const db = fakeDb('thr_other');
      await writeCarryoverContext(invocation(), repo, db as never);
      expect(db.listThreadMessages).not.toHaveBeenCalled();
    });

    it('reads its own project thread', async () => {
      const db = fakeDb('thr_own');
      await writeCarryoverContext(invocation(), repo, db as never);
      expect(db.listThreadMessages).toHaveBeenCalledWith('thr_own', expect.anything());
    });
  });

  describe('provisioning error delivery', () => {
    const params = {
      jobId: 'alpha-1.1',
      parentJobId: 'alpha-1',
      assignee: 'coder',
      errorCode: 'missing_secret_override',
      message: 'OPENAI_API_KEY',
    };

    it("writes to neither the coordination nor the chat thread of another project", async () => {
      const db = fakeDb('thr_other', 'thr_other');
      await deliverProvisioningError(db as never, params);
      expect(db.createThreadMessage).not.toHaveBeenCalled();
    });

    it('writes to its own project threads', async () => {
      const db = fakeDb('thr_own', 'thr_own');
      await deliverProvisioningError(db as never, params);
      expect(db.createThreadMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('eve-message relay to the coordination thread', () => {
    async function relay(db: ReturnType<typeof fakeDb>) {
      const relayer = new EveMessageRelay(db as never, 'alpha-1.1', 'alpha-1', 'coder', null);
      await relayer.processLine('```eve-message');
      await relayer.processLine('{"kind":"status","body":"halfway"}');
      await relayer.processLine('```');
    }

    it("does not write to another project's thread", async () => {
      const db = fakeDb('thr_other');
      await relay(db);
      expect(db.createThreadMessage).not.toHaveBeenCalled();
    });

    it('writes to its own project thread', async () => {
      const db = fakeDb('thr_own');
      await relay(db);
      expect(db.createThreadMessage).toHaveBeenCalledWith(expect.objectContaining({ thread_id: 'thr_own' }));
    });
  });
});
