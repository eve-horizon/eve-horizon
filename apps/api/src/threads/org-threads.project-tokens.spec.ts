import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { OrgThreadsController } from './org-threads.controller';
import type { AuthUser } from '../auth/auth.types';

const threadsById: Record<string, { id: string; project_id: string | null; org_id: string | null }> = {
  thr_org: { id: 'thr_org', project_id: null, org_id: 'org_a' },
  thr_a: { id: 'thr_a', project_id: 'proj_a', org_id: null },
  thr_b: { id: 'thr_b', project_id: 'proj_b', org_id: null },
};

function controller() {
  const threads = {
    findByIdInOrg: vi.fn(async (threadId: string) => threadsById[threadId] ?? null),
    createMessage: vi.fn(async () => ({})),
    listMessages: vi.fn(async () => ({ messages: [] })),
  };
  return { threads, controller: new OrgThreadsController(threads as never) };
}

/** Calls a route handler with its arguments in order (the caller is the last one). */
function call(target: object, handler: string, ...args: unknown[]): Promise<unknown> {
  const fn = (target as Record<string, (...a: unknown[]) => Promise<unknown>>)[handler];
  return fn.call(target, ...args);
}

const jobTokenA: AuthUser = {
  user_id: 'system',
  is_job_token: true,
  job_id: 'a-1',
  project_id: 'proj_a',
  org_id: 'org_a',
  permissions: ['threads:read', 'threads:write', 'orgs:read'],
};
const person: AuthUser = { user_id: 'user_owner' };
const message = { direction: 'inbound', actor_type: 'user', actor_id: 'user_owner', body: 'hi' };

describe('org thread routes', () => {
  it("refuse a project token on another project's thread", async () => {
    const { threads, controller: c } = controller();

    await expect(call(c, 'show', 'org_a', 'thr_b', jobTokenA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(call(c, 'postMessage', 'org_a', 'thr_b', message, jobTokenA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(call(c, 'listMessages', 'org_a', 'thr_b', undefined, undefined, jobTokenA)).rejects.toBeInstanceOf(NotFoundException);
    expect(threads.createMessage).not.toHaveBeenCalled();
    expect(threads.listMessages).not.toHaveBeenCalled();
  });

  it("let a project token use org threads and its own project's threads", async () => {
    const { threads, controller: c } = controller();

    await call(c, 'show', 'org_a', 'thr_org', jobTokenA);
    await call(c, 'postMessage', 'org_a', 'thr_org', message, jobTokenA);
    await call(c, 'postMessage', 'org_a', 'thr_a', message, jobTokenA);

    expect(threads.createMessage).toHaveBeenCalledTimes(2);
  });

  it('leave user tokens unchanged', async () => {
    const { threads, controller: c } = controller();

    await call(c, 'postMessage', 'org_a', 'thr_b', message, person);

    expect(threads.createMessage).toHaveBeenCalledWith('thr_b', message);
  });
});
