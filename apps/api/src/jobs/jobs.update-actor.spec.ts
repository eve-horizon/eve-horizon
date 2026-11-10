import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { AccessService } from '../auth/access.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * user_owner: owner of org_a, who created the job.
 * user_mate: plain member of org_a (a teammate with jobs:write).
 * user_bot: plain member of org_a, reached through an org-bound minted token.
 */
const m = vi.hoisted(() => {
  const state = { job: null as Record<string, unknown> | null };
  return {
    state,
    jobQ: {
      findById: vi.fn(async () => (state.job ? { ...state.job } : null)),
      updatePhase: vi.fn(async () => ({ success: true })),
      cancelJob: vi.fn(async () => true),
    },
    projects: {
      findById: vi.fn(async (id: string) => (id === 'proj_a' ? { id: 'proj_a', org_id: 'org_a', slug: 'a', name: 'a' } : null)),
    },
    memberships: {
      findProjectMembership: vi.fn(async () => null),
      findOrgMembership: vi.fn(async (userId: string, orgId: string) => {
        if (orgId !== 'org_a') return null;
        if (userId === 'user_owner') return { role: 'owner' };
        if (userId === 'user_mate' || userId === 'user_bot') return { role: 'member' };
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
    projectQueries: vi.fn(() => m.projects),
    membershipQueries: vi.fn(() => m.memberships),
    accessRoleQueries: vi.fn(() => m.accessRoles),
  };
});

/** Records every statement; reports the actor writes it saw. */
const statements: Array<{ sql: string; values: unknown[] }> = [];
const fakeDb = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ sql: strings.join('?'), values });
    return [];
  },
  { json: (v: unknown) => v },
);

function actorWrites(): Array<{ actor: unknown; userSecretsExcluded: unknown }> {
  return statements
    .filter((s) => /SET actor_user_id = \?, user_secrets_excluded = \?/.test(s.sql))
    .map((s) => ({ actor: s.values[0], userSecretsExcluded: s.values[1] }));
}

function service(): JobsService {
  const access = new AccessService({} as never, (async () => []) as never);
  return new JobsService(fakeDb as never, {} as never, {} as never, {} as never, access);
}

function update(svc: JobsService, jobId: string, body: Record<string, unknown>, caller: AuthUser): Promise<unknown> {
  return svc.update(jobId, body, caller);
}

const OWNER: AuthUser = { user_id: 'user_owner' };
const TEAMMATE: AuthUser = { user_id: 'user_mate' };
const BOUND_BOT: AuthUser = { user_id: 'user_bot', org_id: 'org_a', bound_org_id: 'org_a', memberships: [] };
/** The token of a step no user started. */
const NO_USER_STEP: AuthUser = {
  user_id: 'system',
  is_job_token: true,
  org_id: 'org_a',
  project_id: 'proj_a',
  job_id: 'b-1',
  permissions: ['jobs:read', 'jobs:write'],
};

function pendingJob(overrides: Record<string, unknown> = {}) {
  m.state.job = {
    id: 'a-1',
    project_id: 'proj_a',
    phase: 'backlog',
    description: 'original prompt',
    actor_user_id: 'user_owner',
    user_secrets_excluded: false,
    token_permissions: null,
    hints: {},
    labels: [],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('PATCH /jobs/:job_id and the job actor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statements.length = 0;
    pendingJob();
  });

  it("makes a teammate who rewrites the prompt the job's actor", async () => {
    await update(service(), 'a-1', { description: 'do something else' }, TEAMMATE);

    expect(actorWrites()).toEqual([{ actor: 'user_mate', userSecretsExcluded: false }]);
  });

  it("makes a bound bot that edits the hints the job's actor, marked to resolve no user secrets", async () => {
    await update(service(), 'a-1', { hints: { permission_policy: 'yolo' } }, BOUND_BOT);

    expect(actorWrites()).toEqual([{ actor: 'user_bot', userSecretsExcluded: true }]);
  });

  it('makes a teammate who releases the job to run its actor', async () => {
    await update(service(), 'a-1', { phase: 'ready' }, TEAMMATE);

    expect(actorWrites()).toEqual([{ actor: 'user_mate', userSecretsExcluded: false }]);
  });

  it("makes a teammate who renames the job its actor, since the title opens the prompt", async () => {
    await update(service(), 'a-1', { title: 'Summarise the open issues' }, TEAMMATE);

    expect(actorWrites()).toEqual([{ actor: 'user_mate', userSecretsExcluded: false }]);
  });

  it("makes a teammate who relabels the job its actor, since the chat label routes the run's output", async () => {
    await update(service(), 'a-1', { labels: ['chat'] }, TEAMMATE);

    expect(actorWrites()).toEqual([{ actor: 'user_mate', userSecretsExcluded: false }]);
  });

  it("keeps the actor for the actor's own edit and for cosmetic edits", async () => {
    await update(service(), 'a-1', { description: 'sharper prompt' }, OWNER);
    await update(service(), 'a-1', { priority: 1, due_at: null, review_required: 'human', close_reason: 'later' }, TEAMMATE);

    expect(actorWrites()).toEqual([]);
  });

  it('refuses a teammate who could not have granted the permissions the job carries', async () => {
    pendingJob({ token_permissions: ['jobs:read', 'secrets:write'] });

    await expect(update(service(), 'a-1', { description: 'do something else' }, TEAMMATE)).rejects.toBeInstanceOf(BadRequestException);
    expect(actorWrites()).toEqual([]);
    expect(statements.filter((s) => /UPDATE jobs/.test(s.sql))).toEqual([]);
  });

  it("refuses a teammate who could not hold the job's token scope", async () => {
    pendingJob({ token_scope: { orgfs: { allow_prefixes: ['/finance/**'] } } });

    await expect(update(service(), 'a-1', { description: 'do something else' }, TEAMMATE)).rejects.toBeInstanceOf(BadRequestException);
    expect(statements.filter((s) => /UPDATE jobs/.test(s.sql))).toEqual([]);
  });

  it("makes a teammate who could hold the job's token scope its actor", async () => {
    pendingJob({ token_scope: { cloud_fs: { allow_mount_ids: ['mnt_shared'] } } });

    await update(service(), 'a-1', { description: 'do something else' }, TEAMMATE);

    expect(actorWrites()).toEqual([{ actor: 'user_mate', userSecretsExcluded: false }]);
  });

  it('refuses a step no user started from carrying a token scope judged for a person', async () => {
    pendingJob({ token_scope: { orgfs: { allow_prefixes: ['/finance/**'] } } });

    await expect(update(service(), 'a-1', { description: 'do something else' }, NO_USER_STEP)).rejects.toBeInstanceOf(BadRequestException);
    expect(statements.filter((s) => /UPDATE jobs/.test(s.sql))).toEqual([]);
  });

  it('passes the caller from the route', async () => {
    const jobsService = { update: vi.fn(async () => ({})) };
    const controller = new JobsController(jobsService as never, {} as never);
    const handler = controller.update as unknown as (...a: unknown[]) => Promise<unknown>;

    await handler.call(controller, 'a-1', { description: 'x' }, TEAMMATE);

    expect(jobsService.update).toHaveBeenCalledWith('a-1', { description: 'x' }, TEAMMATE);
  });

  it("applies the update schema's limits to the body", () => {
    const body = (input: Record<string, unknown>) => validatedBody(JobsController, 'update', input);

    expect(() => body({ title: 'x'.repeat(501) })).toThrow(BadRequestException);
    expect(() => body({ priority: 9 })).toThrow(BadRequestException);
    expect(body({ title: 'x'.repeat(500) })).toEqual({ title: 'x'.repeat(500) });
  });
});

/** Runs a route's body through the pipes declared on its @Body() parameter. */
function validatedBody(controller: object, method: string, input: unknown): unknown {
  const meta = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<
    string,
    { pipes?: Array<{ transform(value: unknown, metadata: { type: string }): unknown }> }
  >;
  const bodyArg = Object.entries(meta).find(([key]) => Number(key.split(':')[0]) === RouteParamtypes.BODY)?.[1];
  return (bodyArg?.pipes ?? []).reduce((value, pipe) => pipe.transform(value, { type: 'body' }), input);
}
