import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');
const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;

async function runEve(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    cwd: repoRoot,
    env: { ...process.env, EVE_API_URL: apiUrl },
  });
  return stdout.trim();
}

describe('integration db cli', () => {
  it('scaffolds group-aware rls helpers with eve db rls init --with-groups', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'eve-db-rls-init-'));
    const outPath = path.join(outDir, 'helpers.sql');

    const initRaw = await runEve([
      'db',
      'rls',
      'init',
      '--with-groups',
      '--out',
      outPath,
      '--json',
    ]);

    const init = JSON.parse(initRaw) as { path: string; with_groups: boolean };
    expect(path.resolve(init.path)).toBe(path.resolve(outPath));
    expect(init.with_groups).toBe(true);

    const content = await readFile(outPath, 'utf-8');
    expect(content).toContain('CREATE OR REPLACE FUNCTION app.current_user_id()');
    expect(content).toContain('CREATE OR REPLACE FUNCTION app.current_group_ids()');
    expect(content).toContain('CREATE OR REPLACE FUNCTION app.has_group(group_id text)');
  }, 30_000);
});
