import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleHarness } from '../src/commands/harness';

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

describe('harness validate workflow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(requestJson).mockReset();
  });

  it('validates each workflow step with merged env overrides', async () => {
    vi.mocked(requestJson)
      .mockResolvedValueOnce({
        project_id: 'proj_test',
        name: 'qa-review',
        definition: {
          env_overrides: {
            A: 'workflow',
            B: 'workflow',
          },
          steps: [
            {
              name: 'plan',
              run: 'plan',
              env_overrides: {
                B: 'step',
                C: 'step',
              },
            },
            {
              name: 'review',
              run: 'review',
              harness_profile_override: {
                harness: 'claude',
                model: 'claude-sonnet',
              },
              env_overrides: {
                C: 'review',
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        harness: { requested: '', canonical: null, auth: null },
        env_overrides: [],
        warnings: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        harness: {
          requested: 'claude',
          canonical: 'claude',
          auth: { available: true, reason: 'ok', instructions: [] },
        },
        env_overrides: [],
        warnings: [],
      });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleHarness(
      'validate',
      [],
      {
        project: 'proj_test',
        workflow: 'qa-review',
        'env-override': ['C=invocation', 'D=${secret.API_KEY}'],
        json: true,
      },
      context as never,
    );

    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      context,
      '/projects/proj_test/workflows/qa-review',
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      context,
      '/projects/proj_test/harness-profile/validate',
      {
        method: 'POST',
        body: {
          env_overrides: {
            A: 'workflow',
            B: 'step',
            C: 'invocation',
            D: '${secret.API_KEY}',
          },
        },
      },
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      3,
      context,
      '/projects/proj_test/harness-profile/validate',
      {
        method: 'POST',
        body: {
          env_overrides: {
            A: 'workflow',
            B: 'workflow',
            C: 'invocation',
            D: '${secret.API_KEY}',
          },
          harness_profile_override: {
            harness: 'claude',
            model: 'claude-sonnet',
          },
        },
      },
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"workflow":"qa-review"'));
  });
});
