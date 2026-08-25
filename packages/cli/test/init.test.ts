import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { handleInit } from '../src/commands/init';

const gitEnvironment = () => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Eve CLI Test',
  GIT_AUTHOR_EMAIL: 'cli-test@eve.invalid',
  GIT_COMMITTER_NAME: 'Eve CLI Test',
  GIT_COMMITTER_EMAIL: 'cli-test@eve.invalid',
});

const runGit = (cwd: string, args: string[], env: NodeJS.ProcessEnv): string =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

describe('eve init', () => {
  it('creates main even when no system or global default branch is configured', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cli-init-'));
    const template = path.join(root, 'template');
    const target = path.join(root, 'target');
    const env = gitEnvironment();
    const previous = {
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    };

    fs.mkdirSync(template);
    runGit(template, ['init', '--initial-branch=main'], env);
    fs.writeFileSync(path.join(template, 'README.md'), '# Local template\n');
    runGit(template, ['add', 'README.md'], env);
    runGit(template, ['commit', '-m', 'Initial template'], env);

    Object.assign(process.env, env);

    try {
      await handleInit([target], {
        template,
        'skip-skills': true,
      });

      expect(runGit(target, ['branch', '--show-current'], env)).toBe('main');
      expect(fs.readFileSync(path.join(target, 'README.md'), 'utf8')).toBe(
        '# Local template\n',
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
