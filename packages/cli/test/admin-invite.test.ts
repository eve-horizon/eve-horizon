import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAdmin } from '../src/commands/admin';

vi.mock('../src/lib/client', () => ({
  requestJson: vi.fn(),
  unwrapListResponse: vi.fn(),
}));

import { requestJson } from '../src/lib/client';

const context = {
  apiUrl: 'http://example.test',
  token: 'token',
  profile: null,
  profileName: null,
  orgId: 'org_test',
} as any;

function membership(role: string) {
  return {
    org_id: 'org_test',
    user_id: 'user_1',
    role,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('admin invite', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(requestJson).mockReset();
  });

  it('omits role from the membership request when --role is not given', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(membership('admin'));

    await handleAdmin('invite', [], { email: 'admin@example.com' }, context);

    const [, path, options] = vi.mocked(requestJson).mock.calls[0]!;
    expect(path).toBe('/orgs/org_test/members');
    expect((options as { body: Record<string, unknown> }).body).toEqual({ email: 'admin@example.com' });
    expect((options as { body: Record<string, unknown> }).body).not.toHaveProperty('role');
  });

  it('reports the role returned by the API in the summary line', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(membership('admin'));

    await handleAdmin('invite', [], { email: 'admin@example.com' }, context);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Added to org_test as admin');
  });

  it('sends role when --role is given', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(membership('owner'));

    await handleAdmin('invite', [], { email: 'owner@example.com', role: 'owner' }, context);

    const [, , options] = vi.mocked(requestJson).mock.calls[0]!;
    expect((options as { body: Record<string, unknown> }).body).toEqual({ email: 'owner@example.com', role: 'owner' });

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Added to org_test as owner');
  });

  it('rejects an invalid --role before calling the API', async () => {
    await expect(
      handleAdmin('invite', [], { email: 'x@example.com', role: 'superuser' }, context),
    ).rejects.toThrow(/Invalid role: superuser/);

    expect(requestJson).not.toHaveBeenCalled();
  });
});
