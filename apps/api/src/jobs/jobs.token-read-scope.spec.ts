import { describe, expect, it, vi } from 'vitest';
import { JobsService } from './jobs.service.js';
import { inReadScope, JOB_TOKEN_READ_SCOPE_RULE, jobTreeRoot } from './job-token-read-scope.js';
import type { AuthUser } from '../auth/auth.types.js';

/*
 * Rule jobs.token_read_scope on project job lists: a job token sees the
 * jobs of its own tree and pipeline run. `audit` records a list that holds
 * others and returns it; `strict` records it and returns only its own.
 */

type Profile = 'legacy' | 'audit' | 'strict';
const job = (id: string, run_id: string | null = null) => ({ id, run_id, project_id: 'proj_shop' }) as never;

function service(profile: Profile, readerRun: string | null = null) {
  const security = { decide: vi.fn(async () => profile) };
  const svc = new JobsService({} as never, {} as never, {} as never, {} as never, {} as never, security as never);
  (svc as unknown as { jobs: unknown }).jobs = { findById: vi.fn(async () => ({ run_id: readerRun })) };
  return { svc, security };
}

const token = (jobId: string): AuthUser => ({ user_id: 'u', is_job_token: true, job_id: jobId, project_id: 'proj_shop' });
const LIST = { jobs: [job('shop-1'), job('shop-1.1'), job('shop-2'), job('shop-3', 'prun_1')], total: 4 };
const ids = (list: { jobs: Array<{ id: string }> }) => list.jobs.map((j) => j.id);

describe('job read scope helpers', () => {
  it('reads a tree by its root and a pipeline run by its id', () => {
    expect(jobTreeRoot('shop-1.2.3')).toBe('shop-1');
    expect(inReadScope({ jobId: 'shop-1.1', runId: null }, { id: 'shop-1' })).toBe(true);
    expect(inReadScope({ jobId: 'shop-1.1', runId: null }, { id: 'shop-2' })).toBe(false);
    expect(inReadScope({ jobId: 'shop-4', runId: 'prun_1' }, { id: 'shop-3', run_id: 'prun_1' })).toBe(true);
    expect(inReadScope({ jobId: 'shop-4', runId: null }, { id: 'shop-3', run_id: null })).toBe(false);
  });
});

describe('JobsService.scopeListToCaller', () => {
  it('under strict, shows a job token only its own tree and run, and records the rest', async () => {
    const { svc, security } = service('strict', 'prun_1');
    const scoped = await svc.scopeListToCaller(token('shop-1.1'), LIST as never);
    expect(ids(scoped)).toEqual(['shop-1', 'shop-1.1', 'shop-3']);
    expect(scoped.total).toBe(3);
    expect(security.decide).toHaveBeenCalledWith(JOB_TOKEN_READ_SCOPE_RULE, expect.objectContaining({
      governing: 'project', projectId: 'proj_shop', detail: { reader_job_id: 'shop-1.1', other_jobs_listed: 1 },
    }));
  });

  it('under audit, records and returns the whole list', async () => {
    const { svc, security } = service('audit');
    const scoped = await svc.scopeListToCaller(token('shop-1'), LIST as never);
    expect(ids(scoped)).toEqual(['shop-1', 'shop-1.1', 'shop-2', 'shop-3']);
    expect(security.decide).toHaveBeenCalledOnce();
  });

  it('asks nothing when the list holds only the caller\'s own jobs, or the caller is a person', async () => {
    const { svc, security } = service('strict');
    const own = { jobs: [job('shop-1'), job('shop-1.1')] };
    expect(await svc.scopeListToCaller(token('shop-1.1'), own as never)).toBe(own);
    expect(await svc.scopeListToCaller({ user_id: 'u' }, LIST as never)).toBe(LIST);
    expect(await svc.scopeListToCaller(undefined, LIST as never)).toBe(LIST);
    expect(security.decide).not.toHaveBeenCalled();
  });
});
