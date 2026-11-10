import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRepoFile, readRepoFiles, RepoFileError } from '../repo-files.js';

const MiB = 1024 * 1024;

describe('repo file reader', () => {
  let work: string;
  let repo: string;

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-repo-files-'));
    repo = path.join(work, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://example.invalid/repo\n');
    fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n');
    fs.writeFileSync(path.join(repo, 'config', 'app.conf'), 'mode=prod\n');
    fs.symlinkSync('.git/config', path.join(repo, 'git-config-link'));
    fs.symlinkSync('../.git/config', path.join(repo, 'config', 'git-link.conf'));
    fs.writeFileSync(path.join(repo, '..notes.txt'), 'notes\n');
    fs.mkdirSync(path.join(repo, '..data'), { recursive: true });
    fs.writeFileSync(path.join(repo, '..data', 'seed.sql'), 'SELECT 1;\n');
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => err);

  describe('git metadata', () => {
    it.each(['.git', '.git/config', '.GIT/config', 'git-config-link'])('refuses %s', async (source) => {
      expect(await refusal(readRepoFiles(repo, source, MiB))).toBeInstanceOf(RepoFileError);
      expect(await refusal(readRepoFile(repo, source, MiB))).toBeInstanceOf(RepoFileError);
    });

    it('refuses a directory mount holding a link into .git', async () => {
      expect(await refusal(readRepoFiles(repo, 'config', MiB))).toBeInstanceOf(RepoFileError);
    });

    it('skips .git when mounting the repository root', async () => {
      const plain = path.join(work, 'plain');
      fs.mkdirSync(path.join(plain, '.git'), { recursive: true });
      fs.writeFileSync(path.join(plain, '.git', 'config'), 'url = https://example.invalid/repo\n');
      fs.writeFileSync(path.join(plain, 'README.md'), 'readme\n');

      const files = await readRepoFiles(plain, '.', MiB);

      expect(files).toEqual({ 'README.md': 'readme\n' });
    });
  });
  describe('names that start with two dots', () => {
    it('reads an in-repo file named ..notes.txt', async () => {
      await expect(readRepoFile(repo, '..notes.txt', MiB)).resolves.toBe('notes\n');
    });

    it('mounts an in-repo directory named ..data', async () => {
      await expect(readRepoFiles(repo, '..data', MiB)).resolves.toEqual({ 'seed.sql': 'SELECT 1;\n' });
    });

    it('still refuses a real parent segment', async () => {
      expect(await refusal(readRepoFile(repo, '../..notes.txt', MiB))).toBeInstanceOf(RepoFileError);
      expect(await refusal(readRepoFile(repo, 'config/../../outside.txt', MiB))).toBeInstanceOf(RepoFileError);
    });
  });
});
