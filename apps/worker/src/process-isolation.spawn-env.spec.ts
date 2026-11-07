import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every child process a service starts must get an explicit, allowlisted env.
// A child that inherits the service's process.env holds DATABASE_URL, the
// internal key and every platform secret, and while it runs any job process
// with the same UID can read them from /proc/<pid>/environ.
const ROOT = join(__dirname, '..', '..', '..');
const SCANNED = ['apps/worker/src', 'apps/agent-runtime/src', 'packages/shared/src'];
const SPAWN = /\b(spawn|spawnSync|execFile|execFileAsync|execSync)\(/g;

/** Call sites that legitimately do something else, with the reason. */
const EXCEPTIONS: Array<{ file: string; contains: string; why: string }> = [
  { file: 'packages/shared/src/lib/pack-resolver.ts', contains: 'git', why: 'CLI-only, runs on the user machine' },
  { file: 'apps/worker/src/pipeline-runner/pipeline-runner.service.ts', contains: "'-lc', command",
    why: 'legacy run action executes job code; its allowlisted job env lives in execution/job-command-env.ts' },
  { file: 'apps/worker/src/builder/docker-buildx-builder.ts', contains: 'execOptions',
    why: 'options object built just above the call; asserted below' },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name) ? [full] : [];
  });
}

function callText(source: string, start: number): string {
  let depth = 0;
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    if (source[i] === ')' && --depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

describe('service child processes', () => {
  const calls = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir))).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(SPAWN)]
      .filter((match) => !/function\s+$/.test(source.slice(Math.max(0, match.index! - 20), match.index)))
      .map((match) => ({ file: relative(ROOT, file), text: callText(source, match.index!) }));
  }).filter(({ file, text }) => !EXCEPTIONS.some((e) => e.file === file && text.includes(e.contains)));

  it('finds the call sites it is meant to police', () => {
    expect(calls.length).toBeGreaterThan(20);
  });

  it('never hands a child the service process.env', () => {
    const offenders = calls.filter(({ text }) => /env:\s*process\.env\b|\.\.\.process\.env\b/.test(text));
    expect(offenders.map(({ file, text }) => `${file}: ${text.slice(0, 80)}`)).toEqual([]);
  });

  it('builds docker CLI options with the helper env', () => {
    const source = readFileSync(join(ROOT, 'apps/worker/src/builder/docker-buildx-builder.ts'), 'utf8');
    expect(source).toMatch(/const execOptions[^;]*env: serviceHelperEnv\(\)/s);
  });

  it('always passes an explicit env (an omitted env inherits process.env)', () => {
    const implicit = calls.filter(({ text }) => !/\benv\b/.test(text));
    expect(implicit.map(({ file, text }) => `${file}: ${text.slice(0, 80)}`)).toEqual([]);
  });
});
