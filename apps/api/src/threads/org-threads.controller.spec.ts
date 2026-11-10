import { NotFoundException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ThreadRow = {
  id: string;
  project_id: string | null;
  org_id: string | null;
  scope: string;
  key: string;
  channel: string | null;
  peer: string | null;
  policy_json: null;
  summary: null;
  workspace_key: null;
  metadata_json: null;
  created_at: Date;
  updated_at: Date;
};

function thread(id: string, owner: { org_id?: string; project_id?: string }): ThreadRow {
  return {
    id,
    project_id: owner.project_id ?? null,
    org_id: owner.org_id ?? null,
    scope: owner.org_id ? 'org' : 'project',
    key: `key-${id}`,
    channel: null,
    peer: null,
    policy_json: null,
    summary: null,
    workspace_key: null,
    metadata_json: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
}

const THREADS: Record<string, ThreadRow> = {
  thr_own_org: thread('thr_own_org', { org_id: 'org_own' }),
  thr_own_project: thread('thr_own_project', { project_id: 'proj_own' }),
  thr_other_org: thread('thr_other_org', { org_id: 'org_other' }),
  thr_other_project: thread('thr_other_project', { project_id: 'proj_other' }),
};

const PROJECT_ORGS: Record<string, string> = { proj_own: 'org_own', proj_other: 'org_other' };
const ORG_SLUGS: Record<string, string> = { own: 'org_own', other: 'org_other' };

const mocks = vi.hoisted(() => ({
  threads: { findById: vi.fn(), touch: vi.fn() },
  messages: { create: vi.fn(), listByThread: vi.fn(), countByThread: vi.fn() },
  events: { create: vi.fn() },
}));

vi.mock('@eve/db', () => ({
  threadQueries: vi.fn(() => mocks.threads),
  threadMessageQueries: vi.fn(() => mocks.messages),
  eventQueries: vi.fn(() => mocks.events),
}));

import { ThreadsService } from './threads.service';
import { OrgThreadsController } from './org-threads.controller';

/** A tagged-template stand-in for the DB that answers org and project lookups. */
async function fakeDb(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  const sql = strings.join('?');
  if (/FROM orgs/i.test(sql)) {
    const input = String(values[0]);
    const id = Object.values(ORG_SLUGS).includes(input) ? input : ORG_SLUGS[input];
    return id ? [{ id }] : [];
  }
  if (/FROM projects/i.test(sql)) {
    const org = PROJECT_ORGS[String(values[0])];
    return org ? [{ id: values[0], org_id: org }] : [];
  }
  return [];
}

/** Call a controller handler with arguments mapped from its Nest param decorators. */
function call(
  controller: object,
  method: string,
  req: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> },
): Promise<unknown> {
  const meta = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller.constructor, method) ?? {}) as Record<
    string,
    { index: number; data?: string }
  >;
  const args: unknown[] = [];
  for (const [key, { index, data }] of Object.entries(meta)) {
    const type = Number(key.split(':')[0]);
    if (type === RouteParamtypes.PARAM) args[index] = data ? req.params?.[data] : req.params;
    else if (type === RouteParamtypes.BODY) args[index] = data ? (req.body as Record<string, unknown>)?.[data] : req.body;
    else if (type === RouteParamtypes.QUERY) args[index] = data ? req.query?.[data] : req.query;
  }
  return (controller as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](...args);
}

describe('org thread routes stay within the path org', () => {
  let controller: OrgThreadsController;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.threads.findById.mockImplementation(async (id: string) => THREADS[id] ?? null);
    mocks.threads.touch.mockResolvedValue(undefined);
    mocks.messages.create.mockImplementation(async (row: Record<string, unknown>) => ({
      ...row,
      created_at: new Date('2026-01-01T00:00:00Z'),
    }));
    mocks.messages.listByThread.mockResolvedValue([]);
    mocks.messages.countByThread.mockResolvedValue(0);
    mocks.events.create.mockResolvedValue(undefined);
    controller = new OrgThreadsController(new ThreadsService(fakeDb as never));
  });

  const message = { body: 'hello', direction: 'outbound' };

  describe.each(['thr_other_org', 'thr_other_project'])('another org\'s thread (%s)', (threadId) => {
    const params = { org_id: 'org_own', thread_id: threadId };

    it('is not shown', async () => {
      await expect(call(controller, 'show', { params })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('takes no message', async () => {
      await expect(call(controller, 'postMessage', { params, body: message })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.messages.create).not.toHaveBeenCalled();
    });

    it('lists no messages', async () => {
      await expect(call(controller, 'listMessages', { params })).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.messages.listByThread).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['an org thread by org id', 'org_own', 'thr_own_org'],
    ['a project thread by org id', 'org_own', 'thr_own_project'],
    ['an org thread by org slug', 'own', 'thr_own_org'],
  ])('the path org\'s own threads: %s', (_label, orgId, threadId) => {
    const params = { org_id: orgId, thread_id: threadId };

    it('is shown', async () => {
      await expect(call(controller, 'show', { params })).resolves.toMatchObject({ id: threadId });
    });

    it('takes a message', async () => {
      await expect(call(controller, 'postMessage', { params, body: message })).resolves.toMatchObject({
        thread_id: threadId,
      });
    });

    it('lists its messages', async () => {
      await expect(call(controller, 'listMessages', { params })).resolves.toEqual({ messages: [], total: 0 });
    });
  });
});
