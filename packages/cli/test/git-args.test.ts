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

import { resolveGitBranch, resolveGitRef } from '../src/lib/git';

const SHA = 'a'.repeat(40);

/** A fake git: no local checkout, and every ref resolves to SHA. */
function fakeGit(args: string[]): string {
  if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
    throw new Error('not a git repository');
  }
  if (args[0] === 'ls-remote') {
    return `${SHA}\trefs/heads/main\n`;
  }
  if (args[0] === 'rev-parse') {
    return `${SHA}\n`;
  }
  return '';
}

function gitCalls(): Array<{ args: string[]; options?: Record<string, unknown> }> {
  return execFileSyncMock.mock.calls
    .filter(([file]) => file === 'git')
    .map(([, args, options]) => ({ args: args as string[], options }));
}

function shellCommands(): string[] {
  return execSyncMock.mock.calls.map(([command]) => String(command));
}

beforeEach(() => {
  execSyncMock.mockReset();
  execFileSyncMock.mockReset();
  requestJsonMock.mockReset();
  execSyncMock.mockImplementation((command: string) => fakeGit(command.split(' ').slice(1)));
  execFileSyncMock.mockImplementation((_file: string, args: string[]) => fakeGit(args));
});

describe('CLI git helpers pass values to git as single arguments', () => {
  it.each([
    'https://github.com/org/repo$(touch eve-cli-marker)',
    'https://github.com/org/repo;touch eve-cli-marker',
    'https://github.com/org/repo`touch eve-cli-marker`',
  ])('resolves a branch against the project repo URL %s with no shell', async (repoUrl) => {
    requestJsonMock.mockResolvedValue({ id: 'proj_1', repo_url: repoUrl });

    const sha = await resolveGitRef({} as never, 'proj_1', 'main');

    expect(sha).toBe(SHA);
    const lsRemote = gitCalls().find((call) => call.args[0] === 'ls-remote');
    expect(lsRemote).toBeDefined();
    expect(lsRemote!.args).toEqual(['ls-remote', '--', repoUrl, 'main']);
    expect(lsRemote!.options?.shell).toBeUndefined();
    expect(shellCommands().filter((command) => command.includes('eve-cli-marker'))).toEqual([]);
  });

  it('resolves a user-supplied ref in the local checkout with no shell', async () => {
    const ref = 'main;touch eve-cli-marker';

    await resolveGitRef({} as never, undefined, ref, '/work/repo');

    const revParse = gitCalls().find((call) => call.args[0] === 'rev-parse');
    expect(revParse).toBeDefined();
    expect(revParse!.args).toContain(ref);
    expect(revParse!.options).toMatchObject({ cwd: '/work/repo' });
    expect(revParse!.options?.shell).toBeUndefined();
    expect(shellCommands().filter((command) => command.includes('eve-cli-marker'))).toEqual([]);
  });

  it('refuses a ref that git would read as an option', async () => {
    await expect(
      resolveGitRef({} as never, undefined, '--output=eve-cli-marker', '/work/repo'),
    ).rejects.toThrow(/ref/i);

    const seen = [...gitCalls().flatMap((call) => call.args), ...shellCommands()];
    expect(seen.filter((value) => value.includes('eve-cli-marker'))).toEqual([]);
  });

  it('checks for a local branch with no shell', () => {
    const ref = 'feature;touch eve-cli-marker';

    resolveGitBranch('/work/repo', ref);

    const showRef = gitCalls().find((call) => call.args[0] === 'show-ref');
    expect(showRef).toBeDefined();
    expect(showRef!.args).toEqual(['show-ref', '--verify', '--quiet', `refs/heads/${ref}`]);
    expect(showRef!.options?.shell).toBeUndefined();
    expect(shellCommands().filter((command) => command.includes('eve-cli-marker'))).toEqual([]);
  });
});
