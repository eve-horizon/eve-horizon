import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobs: { findById: vi.fn() },
  projects: { findById: vi.fn() },
  subscriptions: { findWithGrantsById: vi.fn(), recordTokenMint: vi.fn() },
}));

vi.mock('@eve/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eve/db')>()),
  jobQueries: vi.fn(() => mocks.jobs),
  projectQueries: vi.fn(() => mocks.projects),
  appLinkSubscriptionQueries: vi.fn(() => mocks.subscriptions),
}));

import { AuthInternalController } from './auth.internal.controller';

function subscription(id: string, consumerProjectId: string) {
  return {
    id,
    consumer_project_id: consumerProjectId,
    producer_env_name: 'prod',
    requested_scopes: ['read'],
    api_grant: {
      producer_project_id: 'proj_producer',
      export_name: 'orders',
      envs: [],
      revoked_at: null,
    },
  };
}

const SUBSCRIPTIONS: Record<string, ReturnType<typeof subscription>> = {
  als_own: subscription('als_own', 'proj_a'),
  als_other: subscription('als_other', 'proj_b'),
};

const JOBS: Record<string, { id: string; project_id: string }> = {
  'alpha-1': { id: 'alpha-1', project_id: 'proj_a' },
};

const PROJECTS: Record<string, { id: string; org_id: string }> = {
  proj_a: { id: 'proj_a', org_id: 'org_a' },
  proj_b: { id: 'proj_b', org_id: 'org_b' },
};

// A JWT-shaped string whose payload carries exp, as the controller reads it back.
const MINTED = `h.${Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString('base64url')}.s`;

describe('internal mint-app-link-token binds the subscription to its consumer', () => {
  const mintAppLinkToken = vi.fn(() => MINTED);
  let controller: AuthInternalController;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subscriptions.findWithGrantsById.mockImplementation(async (id: string) => SUBSCRIPTIONS[id] ?? null);
    mocks.subscriptions.recordTokenMint.mockResolvedValue(undefined);
    mocks.jobs.findById.mockImplementation(async (id: string) => JOBS[id] ?? null);
    mocks.projects.findById.mockImplementation(async (id: string) => PROJECTS[id] ?? null);
    controller = new AuthInternalController({ mintAppLinkToken } as never, (() => []) as never, {} as never);
  });

  it("mints no token for another project's subscription named by a job", async () => {
    await expect(
      controller.mintAppLinkToken({ subscription_id: 'als_other', consumer_principal: 'job:alpha-1' } as never),
    ).rejects.toThrow();
    expect(mintAppLinkToken).not.toHaveBeenCalled();
    expect(mocks.subscriptions.recordTokenMint).not.toHaveBeenCalled();
  });

  it('mints no token for a job that does not exist', async () => {
    await expect(
      controller.mintAppLinkToken({ subscription_id: 'als_own', consumer_principal: 'job:missing-1' } as never),
    ).rejects.toThrow();
    expect(mintAppLinkToken).not.toHaveBeenCalled();
  });

  it("mints a token for the job's own project subscription", async () => {
    await expect(
      controller.mintAppLinkToken({ subscription_id: 'als_own', consumer_principal: 'job:alpha-1' } as never),
    ).resolves.toMatchObject({ access_token: MINTED });
    expect(mintAppLinkToken).toHaveBeenCalledWith(expect.objectContaining({ consumerProjectId: 'proj_a' }));
  });

  it('mints for a deployed service only with its own consumer project', async () => {
    await expect(
      controller.mintAppLinkToken({
        subscription_id: 'als_own',
        consumer_principal: 'service:web',
        consumer_project_id: 'proj_a',
      } as never),
    ).resolves.toMatchObject({ access_token: MINTED });

    await expect(
      controller.mintAppLinkToken({
        subscription_id: 'als_other',
        consumer_principal: 'service:web',
        consumer_project_id: 'proj_a',
      } as never),
    ).rejects.toThrow();

    await expect(
      controller.mintAppLinkToken({ subscription_id: 'als_own', consumer_principal: 'service:web' } as never),
    ).rejects.toThrow();

    expect(mintAppLinkToken).toHaveBeenCalledTimes(1);
  });
});
