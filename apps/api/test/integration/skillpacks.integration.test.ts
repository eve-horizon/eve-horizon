import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(process.cwd(), '../..');

function repoPath(...segments: string[]): string {
  return path.join(repoRoot, ...segments);
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(repoPath(relativePath), 'utf-8');
}

function dirExists(relativePath: string): boolean {
  return fs.existsSync(repoPath(relativePath)) && fs.statSync(repoPath(relativePath)).isDirectory();
}

describe('skillpacks source', () => {
  it('uses the public skillpacks repo in skills.txt', () => {
    const manifest = readRepoFile('skills.txt');
    const lines = manifest
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, '').trim())
      .filter((line) => line.length > 0);

    expect(lines).toContain('https://github.com/eve-horizon/eve-skillpacks');
  });

  it('does not vendor skillpacks in this repo', () => {
    expect(dirExists('skillpacks')).toBe(false);
  });
});

describe('test fixtures separation', () => {
  it('e2e test skillpack is in tests/fixtures, not repo', () => {
    expect(dirExists('tests/fixtures/skillpacks-e2e-core')).toBe(true);
  });
});
