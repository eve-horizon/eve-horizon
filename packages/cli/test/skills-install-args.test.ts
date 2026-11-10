import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { execSyncMock, execFileSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: execSyncMock,
    execFileSync: execFileSyncMock,
    spawnSync: spawnSyncMock,
  };
});

import { handleSkills } from '../src/commands/skills';

beforeEach(() => {
  execSyncMock.mockReset();
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0 } as never);
});

describe('eve skills install', () => {
  it('hands a skills.txt source to the skills CLI as one argument with no shell', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cli-skills-args-'));
    const source = 'https://github.com/org/skills$(touch eve-cli-marker);touch eve-cli-marker';
    const originalCwd = process.cwd();

    try {
      fs.writeFileSync(path.join(root, 'skills.txt'), `${source}\n`);
      process.chdir(root);

      await handleSkills('install', [], {});

      const adds = execFileSyncMock.mock.calls.filter(
        ([, args]) => Array.isArray(args) && args[0] === 'add',
      );
      expect(adds.map(([, args]) => (args as string[])[3]).sort()).toEqual(
        ['claude-code', 'codex', 'gemini-cli', 'pi'].sort(),
      );
      for (const [, args, options] of adds) {
        expect(args).toEqual(['add', source, '-a', (args as string[])[3], '-s', '*', '-y', '--full-depth']);
        expect((options as Record<string, unknown> | undefined)?.shell).toBeUndefined();
      }
      expect(
        execSyncMock.mock.calls
          .map(([command]) => String(command))
          .filter((command) => command.includes('eve-cli-marker')),
      ).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
