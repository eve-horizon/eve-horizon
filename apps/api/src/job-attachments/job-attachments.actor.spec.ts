import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { JobAttachmentsService } from './job-attachments.service';
import { JobAttachmentsController } from './job-attachments.controller';
import { JobsService } from '../jobs/jobs.service';
import { AccessService } from '../auth/access.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * user_owner: owner of org_a, who created the job.
 * user_mate: plain member of org_a (a teammate with jobs:write).
 */
const m = vi.hoisted(() => {
  /** job: the row as first read; live: what has changed in the database since. */
  const state = { job: null as Record<string, unknown> | null, live: {} as Record<string, unknown> };
  return {
    state,
    jobQ: {
      findById: vi.fn(async () => (state.job ? { ...state.job } : null)),
    },
    attachmentQ: {
      totalSizeForJob: vi.fn(async () => 0),
      create: vi.fn(async (row: Record<string, unknown>) => ({
        id: 'att-1',
        content_hash: 'h',
        created_at: new Date('2026-01-01T00:00:00Z'),
        ...row,
      })),
      findById: vi.fn(async (id: string) => (id === 'att-1' ? { id: 'att-1', job_id: 'a-1', name: 'notes.md' } : null)),
      delete: vi.fn(async () => true),
    },
    projects: {
      findById: vi.fn(async (id: string) => (id === 'proj_a' ? { id: 'proj_a', org_id: 'org_a', slug: 'a', name: 'a' } : null)),
    },
    memberships: {
      findProjectMembership: vi.fn(async () => null),
      findOrgMembership: vi.fn(async (userId: string, orgId: string) => {
        if (orgId !== 'org_a') return null;
        if (userId === 'user_owner') return { role: 'owner' };
        if (userId === 'user_mate') return { role: 'member' };
        return null;
      }),
    },
    accessRoles: {
      listApplicableBindings: vi.fn(async () => []),
      getEffectiveCustomPermissions: vi.fn(async () => []),
    },
  };
});

vi.mock('@eve/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/db')>();
  return {
    ...actual,
    jobQueries: vi.fn(() => m.jobQ),
    jobAttachmentQueries: vi.fn(() => m.attachmentQ),
    projectQueries: vi.fn(() => m.projects),
    membershipQueries: vi.fn(() => m.memberships),
    accessRoleQueries: vi.fn(() => m.accessRoles),
  };
});

/**
 * Records every committed statement. A transaction's statements are committed
 * only when it completes. A row lock (SELECT ... FOR UPDATE) returns the live
 * row when it meets the statement's conditions.
 */
type Statement = { sql: string; values: unknown[] };
const statements: Statement[] = [];

function recorder(into: Statement[]) {
  return Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      into.push({ sql, values });
      if (!/FOR UPDATE/i.test(sql) || !m.state.job) return [];
      const live: Record<string, unknown> = { ...m.state.job, ...m.state.live };
      const meetsConditions = values.every((value, i) => {
        const column = /(\w+)\s*(?:=|IS NOT DISTINCT FROM)\s*$/i.exec(strings[i])?.[1];
        return !column || !(column in live) || live[column] === value;
      });
      return meetsConditions ? [live] : [];
    },
    { json: (v: unknown) => v },
  );
}

const fakeDb = Object.assign(recorder(statements), {
  begin: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
    const pending: Statement[] = [];
    const result = await work(recorder(pending));
    statements.push(...pending);
    return result;
  },
});

function actorWrites(): Array<{ actor: unknown; userSecretsExcluded: unknown }> {
  return statements
    .filter((s) => /SET actor_user_id = \?, user_secrets_excluded = \?/.test(s.sql))
    .map((s) => ({ actor: s.values[0], userSecretsExcluded: s.values[1] }));
}

/** The attachment routes' service, called the way the controller calls it. */
type AttachmentCalls = {
  create(jobId: string, body: Record<string, unknown>, caller: AuthUser): Promise<unknown>;
  delete(jobId: string, attachmentId: string, caller: AuthUser): Promise<unknown>;
};

function service(): AttachmentCalls {
  const access = new AccessService({} as never, (async () => []) as never);
  const jobs = new JobsService(fakeDb as never, {} as never, {} as never, {} as never, access);
  return Reflect.construct(JobAttachmentsService, [fakeDb, jobs]) as AttachmentCalls;
}

const OWNER: AuthUser = { user_id: 'user_owner' };
const TEAMMATE: AuthUser = { user_id: 'user_mate' };
const NOTES = { name: 'notes.md', content: 'Use the staging bucket.' };

function pendingJob(overrides: Record<string, unknown> = {}) {
  m.state.live = {};
  m.state.job = {
    id: 'a-1',
    project_id: 'proj_a',
    phase: 'backlog',
    description: 'original prompt',
    actor_user_id: 'user_owner',
    user_secrets_excluded: false,
    token_permissions: null,
    token_scope: null,
    hints: {},
    labels: [],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('job attachments and the job actor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statements.length = 0;
    pendingJob();
  });

  it("makes a teammate who attaches a file to someone else's job its actor", async () => {
    await service().create('a-1', NOTES, TEAMMATE);

    expect(actorWrites()).toEqual([{ actor: 'user_mate', userSecretsExcluded: false }]);
    expect(m.attachmentQ.create).toHaveBeenCalledWith(expect.objectContaining({ job_id: 'a-1', created_by: 'user_mate' }));
  });

  it("makes a teammate who removes an attachment from someone else's job its actor", async () => {
    await service().delete('a-1', 'att-1', TEAMMATE);

    expect(actorWrites()).toEqual([{ actor: 'user_mate', userSecretsExcluded: false }]);
    expect(m.attachmentQ.delete).toHaveBeenCalledWith('att-1');
  });

  it("keeps the actor for the actor's own attachments", async () => {
    await service().create('a-1', NOTES, OWNER);
    await service().delete('a-1', 'att-1', OWNER);

    expect(actorWrites()).toEqual([]);
  });

  it('refuses a teammate who could not have granted the permissions the job carries, and attaches nothing', async () => {
    pendingJob({ token_permissions: ['jobs:read', 'secrets:write'] });

    await expect(service().create('a-1', NOTES, TEAMMATE)).rejects.toBeInstanceOf(BadRequestException);
    expect(m.attachmentQ.create).not.toHaveBeenCalled();
    expect(statements.filter((s) => /UPDATE jobs/.test(s.sql))).toEqual([]);
  });

  it("refuses a teammate who could not hold the job's token scope, and removes nothing", async () => {
    pendingJob({ token_scope: { orgfs: { allow_prefixes: ['/finance/**'] } } });

    await expect(service().delete('a-1', 'att-1', TEAMMATE)).rejects.toBeInstanceOf(BadRequestException);
    expect(m.attachmentQ.delete).not.toHaveBeenCalled();
    expect(statements.filter((s) => /UPDATE jobs/.test(s.sql))).toEqual([]);
  });

  it('refuses an attachment when the actor changed after the job was read, and attaches nothing', async () => {
    m.state.live = { actor_user_id: 'user_mate' };

    await expect(service().create('a-1', NOTES, OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(m.attachmentQ.create).not.toHaveBeenCalled();
  });

  it('passes the caller from the routes', async () => {
    const attachments = { create: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) };
    const controller = new JobAttachmentsController(attachments as never);
    const route = (name: 'create' | 'delete') =>
      (controller[name] as unknown as (...a: unknown[]) => Promise<unknown>).bind(controller);

    await route('create')('a-1', NOTES, TEAMMATE);
    await route('delete')('a-1', 'att-1', TEAMMATE);

    expect(attachments.create).toHaveBeenCalledWith('a-1', NOTES, TEAMMATE);
    expect(attachments.delete).toHaveBeenCalledWith('a-1', 'att-1', TEAMMATE);
  });
});
