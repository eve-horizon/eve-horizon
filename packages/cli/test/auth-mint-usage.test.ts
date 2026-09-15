import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAuth } from '../src/commands/auth';

vi.mock('../src/lib/client', () => ({
  requestRaw: vi.fn(),
  requestJson: vi.fn(),
  unwrapListResponse: vi.fn(),
}));

import { requestJson } from '../src/lib/client';

const context = {
  apiUrl: 'http://example.test',
  token: 'token',
  profile: null,
  profileName: null,
  authKey: 'default',
} as any;

const credentials = { tokens: {} } as any;

describe('auth mint usage', () => {
  afterEach(() => {
    vi.mocked(requestJson).mockReset();
  });

  it('requires one of --org or --project and says so', async () => {
    await expect(
      handleAuth('mint', { email: 'bot@example.com' }, context, credentials),
    ).rejects.toThrow(/one of --org or --project is required/i);

    expect(requestJson).not.toHaveBeenCalled();
  });

  it('shows the scope as a required choice and keeps --ttl in the usage', async () => {
    await expect(
      handleAuth('mint', {}, context, credentials),
    ).rejects.toThrow(/\(--org <org_id> \| --project <project_id>\).*\[--ttl <days>\]/);
  });
});
