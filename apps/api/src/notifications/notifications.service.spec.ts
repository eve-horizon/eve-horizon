import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsService } from './notifications.service.js';

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function buildDb(opts?: {
  projects?: Array<{ id: string; org_id: string }>;
  integrations?: Array<{
    id: string;
    org_id: string;
    account_id: string;
    tokens_json: Record<string, unknown> | null;
  }>;
}) {
  const projects = opts?.projects ?? [{ id: 'proj_123', org_id: 'org_123' }];
  const integrations = opts?.integrations ?? [{
    id: 'int_slack',
    org_id: 'org_123',
    account_id: 'T123',
    tokens_json: { access_token: 'xoxb-test' },
  }];

  return vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    if (sql.includes('FROM projects')) return projects;
    if (sql.includes('FROM integrations')) return integrations;
    return [];
  });
}

describe('NotificationsService', () => {
  it('resolves a Slack channel name and posts without exposing the token', async () => {
    const service = new NotificationsService(buildDb() as any);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          channels: [{ id: 'C_NOTIFY', name: 'eve-horizon-notifications' }],
          response_metadata: {},
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, channel: 'C_NOTIFY', ts: '1710000000.000100' }),
      });

    const result = await service.sendForProject('proj_123', {
      provider: 'slack',
      channel: 'eve-horizon-notifications',
      message: 'Workflow complete',
    });

    expect(result).toEqual({
      delivered: true,
      provider: 'slack',
      integration_id: 'int_slack',
      channel: 'eve-horizon-notifications',
      channel_id: 'C_NOTIFY',
      message_ts: '1710000000.000100',
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, postInit] = mockFetch.mock.calls[1];
    expect(JSON.parse(postInit.body)).toEqual({
      channel: 'C_NOTIFY',
      text: 'Workflow complete',
    });
    expect(result).not.toHaveProperty('token');
  });

  it('uses Slack channel IDs directly', async () => {
    const service = new NotificationsService(buildDb() as any);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, channel: 'C123DIRECT', ts: '1710000000.000200' }),
    });

    const result = await service.sendForProject('proj_123', {
      provider: 'slack',
      channel: 'C123DIRECT',
      message: 'Done',
    });

    expect(result.channel_id).toBe('C123DIRECT');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe('https://slack.com/api/chat.postMessage');
  });

  it('enforces project scoping for job tokens after resolving a slug', async () => {
    const service = new NotificationsService(buildDb({
      projects: [{ id: 'proj_other', org_id: 'org_123' }],
    }) as any);

    await expect(service.sendForProject('other-project', {
      provider: 'slack',
      channel: 'C123DIRECT',
      message: 'Done',
    }, { callerProjectId: 'proj_123' })).rejects.toThrow(ForbiddenException);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('requires an explicit integration when an org has multiple active Slack workspaces', async () => {
    const service = new NotificationsService(buildDb({
      integrations: [
        { id: 'int_a', org_id: 'org_123', account_id: 'TA', tokens_json: { access_token: 'xoxb-a' } },
        { id: 'int_b', org_id: 'org_123', account_id: 'TB', tokens_json: { access_token: 'xoxb-b' } },
      ],
    }) as any);

    await expect(service.sendForProject('proj_123', {
      provider: 'slack',
      channel: 'C_DIRECT',
      message: 'Done',
    })).rejects.toThrow(BadRequestException);
  });
});
