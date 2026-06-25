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

function writeSkill(skillDir: string, name: string): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test skill\n---\n# ${name}\n`,
  );
}

beforeEach(() => {
  execSyncMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0 } as never);
});

describe('eve skills materialize', () => {
  it('materializes local skills.txt sources without skills add subprocesses', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cli-skills-materialize-'));
    const originalCwd = process.cwd();

    try {
      const skillDir = path.join(root, 'skills', 'react-best-practices');
      writeSkill(skillDir, 'Vercel React Best Practices');
      fs.writeFileSync(path.join(root, 'skills.txt'), './skills/react-best-practices\n');

      process.chdir(root);
      await handleSkills('materialize', ['skills.txt'], {});

      expect(execSyncMock).not.toHaveBeenCalled();
      expect(
        fs.existsSync(
          path.join(root, '.agents', 'skills', 'vercel-react-best-practices', 'SKILL.md'),
        ),
      ).toBe(true);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
