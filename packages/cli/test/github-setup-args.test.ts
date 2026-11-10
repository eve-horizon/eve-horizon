import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execSyncMock, execFileSyncMock, requestJsonMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  requestJsonMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: execSyncMock, execFileSync: execFileSyncMock };
});

vi.mock('../src/lib/client', () => ({
  requestJson: requestJsonMock,
}));

import { handleGithub } from '../src/commands/github';

const WEBHOOK_URL = 'https://api.example.com/integrations/github/events/proj_1';
const SECRET = 'whsec_"quoted";`x`';

function ghCalls(): Array<{ args: string[]; options?: Record<string, unknown> }> {
  return execFileSyncMock.mock.calls
    .filter(([file]) => file === 'gh')
    .map(([, args, options]) => ({ args: args as string[], options }));
}

beforeEach(() => {
  execSyncMock.mockReset();
  execFileSyncMock.mockReset();
  requestJsonMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // gh is installed and authenticated; the repository has no hooks yet.
  execSyncMock.mockImplementation((command: string) => (command.includes('--jq') ? '0' : ''));
  execFileSyncMock.mockImplementation((_file: string, args: string[]) =>
    args[0] === 'api' && !args.includes('-X') ? '[]' : '',
  );
});

describe('eve github setup', () => {
  it.each([
    'https://github.com/org/repo$(touch eve-cli-marker)',
    'https://github.com/org/repo;touch eve-cli-marker',
  ])('creates the webhook for %s through gh with each value as one argument', async (repoUrl) => {
    requestJsonMock.mockResolvedValue({
      webhook_url: WEBHOOK_URL,
      secret: SECRET,
      project_id: 'proj_1',
      repo_url: repoUrl,
      events: ['push', 'pull_request'],
    });

    await handleGithub('setup', [], { project: 'proj_1' }, {} as never);

    const ownerRepo = repoUrl.replace('https://github.com/', '');
    const create = ghCalls().find((call) => call.args.includes('POST'));
    expect(create).toBeDefined();
    expect(create!.args).toContain(`repos/${ownerRepo}/hooks`);
    expect(create!.args).toContain(`config[url]=${WEBHOOK_URL}`);
    expect(create!.args).toContain(`config[secret]=${SECRET}`);
    expect(create!.args).toContain('events[]=pull_request');
    for (const call of ghCalls()) {
      expect(call.options?.shell).toBeUndefined();
    }
    expect(
      execSyncMock.mock.calls
        .map(([command]) => String(command))
        .filter((command) => command.includes('eve-cli-marker') || command.includes('whsec_')),
    ).toEqual([]);
  });
});
