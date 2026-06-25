import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleWorkflow } from '../src/commands/workflow';

vi.mock('../src/lib/client', () => ({
  requestJson: vi.fn(),
}));

import { requestJson } from '../src/lib/client';

const context = {
  apiUrl: 'http://example.test',
  token: 'token',
  profile: null,
  profileName: null,
  projectId: 'proj_test',
};

describe('workflow retry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(requestJson).mockReset();
  });

  it('posts retry-failed requests and prints JSON', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({
      root_job_id: 'acme-fd842fff',
      status: 'active',
      mode: 'failed',
      generation: 1,
      retried_steps: [
        {
          step_name: 'review',
          previous_job_id: 'acme-fd842fff.2',
          retry_job_id: 'acme-fd842fff.4',
        },
      ],
      superseded_job_ids: ['acme-fd842fff.2'],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleWorkflow('retry', ['acme-fd842fff'], { failed: true, json: true }, context as never);

    expect(requestJson).toHaveBeenCalledWith(
      context,
      '/projects/proj_test/workflows/retry',
      {
        method: 'POST',
        body: {
          root_job_id: 'acme-fd842fff',
          failed: true,
        },
      },
    );
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      root_job_id: 'acme-fd842fff',
      status: 'active',
      mode: 'failed',
      generation: 1,
      retried_steps: [
        {
          step_name: 'review',
          previous_job_id: 'acme-fd842fff.2',
          retry_job_id: 'acme-fd842fff.4',
        },
      ],
      superseded_job_ids: ['acme-fd842fff.2'],
    }));
  });

  it('posts retry-from requests and prints a human summary', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({
      root_job_id: 'acme-fd842fff',
      status: 'active',
      mode: 'from',
      from_step: 'review',
      generation: 2,
      retried_steps: [
        {
          step_name: 'review',
          previous_job_id: 'acme-fd842fff.2',
          retry_job_id: 'acme-fd842fff.4',
          depends_on: ['plan'],
        },
      ],
      superseded_job_ids: ['acme-fd842fff.2'],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleWorkflow('retry', ['acme-fd842fff'], { from: 'review' }, context as never);

    expect(requestJson).toHaveBeenCalledWith(
      context,
      '/projects/proj_test/workflows/retry',
      {
        method: 'POST',
        body: {
          root_job_id: 'acme-fd842fff',
          from_step: 'review',
        },
      },
    );
    expect(log).toHaveBeenCalledWith('Workflow retry queued: acme-fd842fff');
    expect(log).toHaveBeenCalledWith('- review: acme-fd842fff.2 -> acme-fd842fff.4 (depends on plan)');
  });

  it('resolves project from the root job when no project is configured', async () => {
    vi.mocked(requestJson)
      .mockResolvedValueOnce({ project_id: 'proj_from_job' })
      .mockResolvedValueOnce({
        root_job_id: 'acme-fd842fff',
        status: 'active',
        mode: 'failed',
        generation: 1,
        retried_steps: [],
        superseded_job_ids: [],
      });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleWorkflow(
      'retry',
      ['acme-fd842fff'],
      { failed: true },
      { ...context, projectId: undefined } as never,
    );

    expect(requestJson).toHaveBeenNthCalledWith(1, { ...context, projectId: undefined }, '/jobs/acme-fd842fff');
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      { ...context, projectId: undefined },
      '/projects/proj_from_job/workflows/retry',
      {
        method: 'POST',
        body: {
          root_job_id: 'acme-fd842fff',
          failed: true,
        },
      },
    );
  });

  it('requires exactly one retry selector', async () => {
    await expect(
      handleWorkflow('retry', ['acme-fd842fff'], {}, context as never),
    ).rejects.toThrow(/Usage: eve workflow retry/);

    await expect(
      handleWorkflow('retry', ['acme-fd842fff'], { failed: true, from: 'review' }, context as never),
    ).rejects.toThrow(/Usage: eve workflow retry/);
  });
});

describe('workflow env overrides', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(requestJson).mockReset();
  });

  it('includes env_overrides in run request bodies', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({
      job_id: 'job_123',
      workflow_name: 'qa-review',
      project_id: 'proj_test',
      status: 'active',
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleWorkflow(
      'run',
      ['qa-review'],
      {
        'env-override': ['WEB_SEARCH_API_KEY=${secret.WEB_SEARCH_API_KEY}', 'DUP=workflow'],
        env_override: 'DUP=cli',
      },
      context as never,
    );

    expect(requestJson).toHaveBeenCalledWith(
      context,
      '/projects/proj_test/workflows/qa-review/invoke?wait=false',
      {
        method: 'POST',
        body: {
          env_overrides: {
            WEB_SEARCH_API_KEY: '${secret.WEB_SEARCH_API_KEY}',
            DUP: 'cli',
          },
        },
      },
    );
  });

  it('includes input and env_overrides in invoke request bodies', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({
      job_id: 'job_456',
      workflow_name: 'qa-review',
      project_id: 'proj_test',
      status: 'done',
      result: { ok: true },
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleWorkflow(
      'invoke',
      ['proj_other', 'qa-review'],
      {
        input: '{"task":"audit"}',
        'env-override': 'WEB_SEARCH_API_KEY=${secret.WEB_SEARCH_API_KEY}',
      },
      context as never,
    );

    expect(requestJson).toHaveBeenCalledWith(
      context,
      '/projects/proj_other/workflows/qa-review/invoke?wait=true',
      {
        method: 'POST',
        body: {
          input: { task: 'audit' },
          env_overrides: {
            WEB_SEARCH_API_KEY: '${secret.WEB_SEARCH_API_KEY}',
          },
        },
      },
    );
  });
});
