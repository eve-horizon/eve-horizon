import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { JobsService } from './jobs.service';

type JobRow = Record<string, unknown> & { id: string; project_id: string; parent_id: string | null };

/** In-memory jobs, projects and job relations. */
const store = vi.hoisted(() => {
  const now = new Date('2026-11-01T00:00:00Z');
  const job = (id: string, project_id: string, parent_id: string | null = null) => ({
    id,
    project_id,
    parent_id,
    depth: parent_id ? parent_id.split('.').length : 0,
    title: id,
    description: `work for ${id}`,
    issue_type: 'task',
    labels: [] as string[],
    phase: 'ready',
    priority: 2,
    assignee: null,
    review_required: 'none',
    review_status: null,
    reviewer: null,
    defer_until: null,
    due_at: null,
    ready_at: null,
    hints: {},
    created_at: now,
    updated_at: now,
  });
  const state = {
    jobs: [] as Array<ReturnType<typeof job>>,
    relations: [] as Array<{ job_id: string; related_job_id: string; relation_type: string }>,
    projects: [
      { id: 'proj_a', org_id: 'org_a', slug: 'alpha' },
      { id: 'proj_o', org_id: 'org_o', slug: 'other' },
    ],
  };
  const related = (rows: Array<{ id: string; relation_type: string }>) =>
    rows.map((r) => ({ ...state.jobs.find((j) => j.id === r.id)!, relation_type: r.relation_type }));
  const jobQ = {
    resolveProjectSlug: vi.fn(async (input: string) => {
      const project = state.projects.find((p) => p.id === input || p.slug === input);
      if (!project) throw new Error(`Project not found: ${input}`);
      return project.id;
    }),
    findById: vi.fn(async (id: string) => state.jobs.find((j) => j.id === id) ?? null),
    generateJobId: vi.fn(async (projectId: string, parentId?: string) => ({
      id: parentId ? `${parentId}.9` : 'alpha-new00001',
      projectId,
    })),
    create: vi.fn(async (row: Record<string, unknown>) => ({ ...job(row.id as string, row.project_id as string, row.parent_id as string | null), ...row })),
    // Like packages/db/src/queries/jobs/hierarchy.ts: no project filter.
    addDependency: vi.fn(async (fromId: string, toId: string, relationType = 'blocks') => {
      state.relations.push({ job_id: fromId, related_job_id: toId, relation_type: relationType });
      return 'rel_1';
    }),
    getDependencies: vi.fn(async (jobId: string) =>
      related(state.relations.filter((r) => r.job_id === jobId).map((r) => ({ id: r.related_job_id, relation_type: r.relation_type })))),
    getDependents: vi.fn(async (jobId: string) =>
      related(state.relations.filter((r) => r.related_job_id === jobId).map((r) => ({ id: r.job_id, relation_type: r.relation_type })))),
    getBlockingJobs: vi.fn(async (jobId: string) =>
      related(state.relations.filter((r) => r.job_id === jobId).map((r) => ({ id: r.related_job_id, relation_type: r.relation_type })))),
    getChildren: vi.fn(async (jobId: string) => state.jobs.filter((j) => j.parent_id === jobId)),
    getHierarchy: vi.fn(async (rootId: string) => state.jobs.filter((j) => j.id === rootId || j.id.startsWith(`${rootId}.`))),
    getLatestAttempt: vi.fn(async () => null),
    getLatestRejectionReason: vi.fn(async () => null),
  };
  const projectQ = {
    findById: vi.fn(async (id: string) => state.projects.find((p) => p.id === id) ?? null),
  };
  return { state, job, jobQ, projectQ };
});

vi.mock('@eve/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/db')>();
  return {
    ...actual,
    jobQueries: vi.fn(() => store.jobQ),
    projectQueries: vi.fn(() => store.projectQ),
    projectManifestQueries: vi.fn(() => ({ findLatestByProject: vi.fn(async () => null) })),
    appLinkSubscriptionQueries: vi.fn(() => ({ listByConsumer: vi.fn(async () => []) })),
    projectApiSourceQueries: vi.fn(() => ({ list: vi.fn(async () => []) })),
  };
});

/** Raw SQL used by getContext for siblings: honours a project filter when the query has one. */
const rawSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join('?');
  if (/WHERE j\.parent_id = \?/.test(sql)) {
    const [parentId, selfId, projectId] = values as string[];
    return store.state.jobs
      .filter((j) => j.parent_id === parentId && j.id !== selfId)
      .filter((j) => !/project_id = \?/.test(sql) || j.project_id === projectId)
      .map((j) => ({ ...j, result_summary: null }));
  }
  return [];
}) as never;

function service(): JobsService {
  return new JobsService(rawSql, {} as never, {} as never, {} as never, {} as never);
}

describe('JobsService jobs related to another project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.state.relations = [];
    store.state.jobs = [
      store.job('alpha-aaaa1111', 'proj_a'),
      store.job('alpha-aaaa2222', 'proj_a'),
      store.job('other-bbbb2222', 'proj_o'),
      store.job('other-bbbb2222.1', 'proj_o', 'other-bbbb2222'),
    ];
  });

  it("refuses a dependency on another project's job", async () => {
    await expect(
      service().addDependency('alpha-aaaa1111', { related_job_id: 'other-bbbb2222' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.jobQ.addDependency).not.toHaveBeenCalled();
  });

  it('still adds a dependency within the project', async () => {
    await service().addDependency('alpha-aaaa1111', { related_job_id: 'alpha-aaaa2222' });

    expect(store.jobQ.addDependency).toHaveBeenCalledWith('alpha-aaaa1111', 'alpha-aaaa2222', 'blocks');
  });

  it("never returns another project's jobs as dependencies, dependents or blockers", async () => {
    // Relations recorded before cross-project links were refused.
    store.state.relations = [
      { job_id: 'alpha-aaaa1111', related_job_id: 'other-bbbb2222', relation_type: 'blocks' },
      { job_id: 'alpha-aaaa1111', related_job_id: 'alpha-aaaa2222', relation_type: 'blocks' },
      { job_id: 'other-bbbb2222', related_job_id: 'alpha-aaaa1111', relation_type: 'blocks' },
    ];

    const deps = await service().getDependencies('alpha-aaaa1111');

    expect(deps.dependencies.map((d) => d.id)).toEqual(['alpha-aaaa2222']);
    expect(deps.blocking.map((d) => d.id)).toEqual(['alpha-aaaa2222']);
    expect(deps.dependents).toEqual([]);
  });

  it("refuses to create a job under another project's parent", async () => {
    await expect(
      service().create('proj_a', { description: 'child', parent_id: 'other-bbbb2222' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.jobQ.create).not.toHaveBeenCalled();
  });

  it('still creates a child under a parent in the same project', async () => {
    const child = await service().create('proj_a', { description: 'child', parent_id: 'alpha-aaaa1111' } as never);

    expect(child.parent_id).toBe('alpha-aaaa1111');
    expect(store.jobQ.create).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'proj_a', parent_id: 'alpha-aaaa1111' }));
  });

  it("never includes another project's jobs in a job's context or tree", async () => {
    // A child recorded under another project's parent before that was refused.
    store.state.jobs.push(store.job('other-bbbb2222.2', 'proj_a', 'other-bbbb2222'));
    store.state.relations = [
      { job_id: 'other-bbbb2222.2', related_job_id: 'other-bbbb2222.1', relation_type: 'blocks' },
    ];

    const fromA = await service().getContext('other-bbbb2222.2');
    expect(fromA.parent).toBeNull();
    expect(fromA.siblings ?? []).toEqual([]);
    expect(fromA.relations.dependencies).toEqual([]);

    const fromOtherProject = await service().getContext('other-bbbb2222');
    expect(fromOtherProject.children.map((c) => c.id)).toEqual(['other-bbbb2222.1']);

    const tree = await service().getTree('other-bbbb2222');
    expect((tree.children ?? []).map((c) => c.id)).toEqual(['other-bbbb2222.1']);
  });
});
