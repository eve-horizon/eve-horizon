import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { resolvePackMock, spawnSyncMock } = vi.hoisted(() => ({
  resolvePackMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('@eve/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/shared')>();
  return { ...actual, resolvePack: resolvePackMock };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import { handleSkills } from '../src/commands/skills';

beforeEach(() => {
  resolvePackMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0 } as never);
});

describe('eve skills install manifest packs', () => {
  it('materializes the locked revision before invoking the skills installer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cli-pack-install-'));
    const skillPath = path.join(root, 'cache', 'factory-pm');
    const ref = '72ed321b9dee7ae497e7ff60486aa2e8657d365f';
    const originalCwd = process.cwd();

    try {
      fs.mkdirSync(path.join(root, '.eve'), { recursive: true });
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# Factory PM\n');
      fs.writeFileSync(path.join(root, '.eve', 'manifest.yaml'), [
        'project: fullstack-example',
        'x-eve:',
        '  install_agents: [codex]',
        '  packs:',
        '    - source: eve-horizon/eve-software-factory',
        `      ref: ${ref}`,
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(root, '.eve', 'packs.lock.yaml'), [
        'packs:',
        '  - source: eve-horizon/eve-software-factory',
        `    ref: ${ref}`,
        '',
      ].join('\n'));
      resolvePackMock.mockResolvedValue({
        id: 'software-factory',
        source: 'eve-horizon/eve-software-factory',
        ref,
        rootPath: path.dirname(skillPath),
        agents: {},
        teams: {},
        workflows: null,
        chat: null,
        xEve: null,
        skillPaths: [skillPath],
      });

      process.chdir(root);
      const resolvedRoot = process.cwd();
      await handleSkills('install', [], {});

      expect(resolvePackMock).toHaveBeenCalledWith(
        { source: 'eve-horizon/eve-software-factory', ref },
        'fullstack-example',
        resolvedRoot,
      );
      expect(spawnSyncMock).toHaveBeenCalledWith(
        expect.any(String),
        ['add', skillPath, '-a', 'codex', '-s', '*', '-y', '--full-depth'],
        expect.objectContaining({ cwd: resolvedRoot, stdio: 'inherit' }),
      );
      expect(
        spawnSyncMock.mock.calls.some((call) =>
          Array.isArray(call[1]) && call[1].includes('eve-horizon/eve-software-factory')
        ),
      ).toBe(false);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
