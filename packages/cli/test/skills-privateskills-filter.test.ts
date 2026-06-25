import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { execSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: execSyncMock,
    spawnSync: spawnSyncMock,
  };
});

import { handleSkills } from '../src/commands/skills';

function setupSkillRepo(rootName = 'eve-cli-skills-filter-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), rootName));
  const fixture = path.join(root, 'fixture');

  fs.mkdirSync(path.join(fixture, 'public', 'public-skill'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'private-skills', 'sync-horizon'), { recursive: true });

  fs.writeFileSync(path.join(fixture, 'public', 'public-skill', 'SKILL.md'), 'name: public-skill');
  fs.writeFileSync(path.join(fixture, 'private-skills', 'sync-horizon', 'SKILL.md'), 'name: sync-horizon');

  return root;
}

function writeSkillsTxt(root: string, line: string): void {
  fs.writeFileSync(path.join(root, 'skills.txt'), `${line}\n`);
}

beforeEach(() => {
  execSyncMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0 } as never);
});

describe('eve skills install manifest glob filtering', () => {
  it('excludes private-skills from glob expansion by default', async () => {
    const root = setupSkillRepo();
    const originalCwd = process.cwd();

    try {
      process.chdir(root);
      writeSkillsTxt(root, './fixture/**');

      await handleSkills('install', [], {});

      const commands = execSyncMock.mock.calls.map((call) => call[0] as string);
      expect(commands.some((command) => command.includes('public-skill'))).toBe(true);
      expect(commands.some((command) => command.includes('sync-horizon'))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps private-skills when explicitly targeting private-skills in manifest', async () => {
    const root = setupSkillRepo('eve-cli-skills-filter-explicit-');
    const originalCwd = process.cwd();

    try {
      process.chdir(root);
      writeSkillsTxt(root, './fixture/private-skills/*');

      await handleSkills('install', [], {});

      const commands = execSyncMock.mock.calls.map((call) => call[0] as string);
      expect(commands.some((command) => command.includes('private-skills/sync-horizon'))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
