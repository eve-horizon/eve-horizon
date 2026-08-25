import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { commitStagedChanges, handleInit } from '../src/commands/init';

const templateGitEnvironment = () => ({
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
    const templateEnv = templateGitEnvironment();
    const cleanEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    delete cleanEnv.GIT_AUTHOR_NAME;
    delete cleanEnv.GIT_AUTHOR_EMAIL;
    delete cleanEnv.GIT_COMMITTER_NAME;
    delete cleanEnv.GIT_COMMITTER_EMAIL;
    const previous = {
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    };

    fs.mkdirSync(template);
    runGit(template, ['init', '--initial-branch=main'], templateEnv);
    fs.writeFileSync(path.join(template, 'README.md'), '# Local template\n');
    runGit(template, ['add', 'README.md'], templateEnv);
    runGit(template, ['commit', '-m', 'Initial template'], templateEnv);

    Object.assign(process.env, cleanEnv);
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;

    try {
      await handleInit([target], {
        template,
        'skip-skills': true,
      });

      expect(runGit(target, ['branch', '--show-current'], cleanEnv)).toBe('main');
      expect(runGit(target, ['log', '-1', '--format=%an <%ae>'], cleanEnv)).toBe(
        'Eve Horizon Starter <eve-init@users.noreply.github.com>',
      );
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

  it('uses the fallback identity for generated follow-up commits', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cli-commit-'));
    const cleanEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    delete cleanEnv.GIT_AUTHOR_NAME;
    delete cleanEnv.GIT_AUTHOR_EMAIL;
    delete cleanEnv.GIT_COMMITTER_NAME;
    delete cleanEnv.GIT_COMMITTER_EMAIL;
    const previous = {
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    };

    Object.assign(process.env, cleanEnv);
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;

    try {
      runGit(root, ['init', '--initial-branch=main'], cleanEnv);
      fs.writeFileSync(path.join(root, 'README.md'), '# Initial\n');
      expect(commitStagedChanges(root, 'Initial')).toBe(true);
      fs.writeFileSync(path.join(root, 'skills.txt'), 'eve-horizon/eve-skillpacks\n');
      expect(commitStagedChanges(root, 'Install skills')).toBe(true);

      expect(runGit(root, ['log', '-2', '--format=%an <%ae>'], cleanEnv).split('\n')).toEqual([
        'Eve Horizon Starter <eve-init@users.noreply.github.com>',
        'Eve Horizon Starter <eve-init@users.noreply.github.com>',
      ]);
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
