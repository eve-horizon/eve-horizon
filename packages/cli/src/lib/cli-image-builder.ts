import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type CliImageBuildOptions = {
  projectSlug: string;
  repoDir: string;
  dockerfile?: string;
  tag?: string;
  importToK3d?: boolean;
  cluster?: string;
  quiet?: boolean;
};

export type CliImageBuildResult = {
  image: string;
  dockerfile: string;
  imported: boolean;
};

export function buildCliImage(options: CliImageBuildOptions): CliImageBuildResult {
  const repoDir = resolve(options.repoDir);
  const dockerfile = resolve(options.dockerfile ?? join(repoDir, 'Dockerfile.cli'));
  if (!existsSync(dockerfile)) {
    throw new Error(`CLI image Dockerfile not found: ${dockerfile}`);
  }

  const image = options.tag ?? `local/${options.projectSlug}-cli:${resolveImageTag(repoDir)}`;
  run('docker', ['build', '-f', dockerfile, '-t', image, repoDir], {
    cwd: repoDir,
    quiet: options.quiet,
  });

  let imported = false;
  if (options.importToK3d) {
    run('k3d', ['image', 'import', image, '-c', options.cluster ?? 'eve-local'], {
      quiet: options.quiet,
    });
    imported = true;
  }

  return { image, dockerfile, imported };
}

function resolveImageTag(repoDir: string): string {
  const git = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  if (git.status === 0 && git.stdout.trim()) {
    return git.stdout.trim();
  }

  return createHash('sha1')
    .update(`${repoDir}:${Date.now()}`)
    .digest('hex')
    .slice(0, 12);
}

function run(command: string, args: string[], options: { cwd?: string; quiet?: boolean } = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: options.quiet ? 'pipe' : 'inherit',
  });
  if (result.status === 0) return;

  const detail = [
    result.error?.message,
    typeof result.stderr === 'string' ? result.stderr.trim() : '',
  ].filter(Boolean).join('\n');
  throw new Error(`Command failed: ${command} ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
}
