import { execSync } from 'node:child_process';
import path from 'node:path';

import type { ResolvedContext } from './context.js';
import { requestJson } from './client.js';

type ProjectResponse = {
  id: string;
  repo_url: string;
};

const GIT_SHA_REGEX = /^[0-9a-f]{40}$/;

export function isGitSha(ref: string): boolean {
  return GIT_SHA_REGEX.test(ref);
}

export async function resolveGitRef(
  context: ResolvedContext,
  projectId: string | undefined,
  ref: string,
  repoDir?: string,
): Promise<string> {
  if (isGitSha(ref)) {
    return ref;
  }

  const resolvedRepoDir = repoDir ?? getGitRoot();

  // Determine if we can resolve locally (matching repo available)
  let useLocal = !!resolvedRepoDir;
  let projectRepoUrl: string | undefined;

  if (projectId) {
    const project = await requestJson<ProjectResponse>(context, `/projects/${projectId}`);
    projectRepoUrl = project.repo_url;
    const expected = normalizeRepoIdentity(project.repo_url);
    const actual = resolvedRepoDir ? normalizeRepoIdentity(getGitOriginUrl(resolvedRepoDir)) : null;
    const repoDirIdentity = resolvedRepoDir ? normalizeRepoIdentity(resolvedRepoDir) : null;

    if (expected && actual && expected !== actual) {
      useLocal = false;
    }
    if (expected && !actual && (!repoDirIdentity || repoDirIdentity !== expected)) {
      useLocal = false;
    }
  }

  // Try local resolution first
  if (useLocal && resolvedRepoDir) {
    try {
      return execSync(`git rev-parse ${ref}`, {
        cwd: resolvedRepoDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // Local resolution failed — fall through to remote
    }
  }

  // Fall back to remote resolution via git ls-remote
  if (projectRepoUrl) {
    const sha = resolveRefRemote(projectRepoUrl, ref);
    if (sha) {
      return sha;
    }
    throw new Error(
      `Failed to resolve git ref '${ref}' against remote '${projectRepoUrl}'.\n` +
      'Make sure the ref (branch or tag) exists in the remote repository, or use a 40-character SHA.',
    );
  }

  // No project context and no local repo — nothing we can do
  if (!resolvedRepoDir) {
    throw new Error(
      `Failed to resolve git ref '${ref}': not in a git repository.\n` +
      'Run the command from the project repository, pass --repo-dir <path>, or use a 40-character SHA.',
    );
  }

  // Local repo, no project context, local rev-parse
  try {
    return execSync(`git rev-parse ${ref}`, {
      cwd: resolvedRepoDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(
      `Failed to resolve git ref '${ref}': ${error instanceof Error ? error.message : String(error)}\n` +
      'Make sure the ref exists in the repository, or use a 40-character SHA.',
    );
  }
}

export function getGitRoot(repoDir?: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export function isGitDirty(repoDir: string): boolean {
  try {
    const status = execSync('git status --porcelain', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

export function getGitBranch(repoDir: string): string | null {
  try {
    const branch = execSync('git branch --show-current', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

export function resolveGitBranch(repoDir: string, ref: string): string | null {
  if (!ref || isGitSha(ref)) {
    return null;
  }
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${ref}`, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return ref;
  } catch {
    return null;
  }
}

function resolveRefRemote(repoUrl: string, ref: string): string | null {
  try {
    const output = execSync(`git ls-remote ${repoUrl} ${ref}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
    // ls-remote returns lines like: "<sha>\t<refname>"
    // For branches, match refs/heads/<ref>; for tags, refs/tags/<ref>; also accept exact match
    for (const line of output.split('\n')) {
      const [sha, refName] = line.split('\t');
      if (!sha || !refName) continue;
      if (
        refName === `refs/heads/${ref}` ||
        refName === `refs/tags/${ref}` ||
        refName === ref
      ) {
        return sha;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function getGitOriginUrl(repoDir: string): string | null {
  try {
    const url = execSync('git config --get remote.origin.url', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return url || null;
  } catch {
    return null;
  }
}

function normalizeRepoIdentity(repoUrl: string | null): string | null {
  if (!repoUrl) {
    return null;
  }

  if (repoUrl.startsWith('file://')) {
    return stripFilePath(path.resolve(repoUrl.replace('file://', '')));
  }

  if (repoUrl.startsWith('/') || repoUrl.startsWith('./') || repoUrl.startsWith('../')) {
    return stripFilePath(path.resolve(repoUrl));
  }

  if (repoUrl.startsWith('git@')) {
    const match = repoUrl.match(/^git@([^:]+):(.+)$/);
    if (!match) {
      return repoUrl;
    }
    const host = match[1].toLowerCase();
    const pathname = stripGitSuffix(match[2]).toLowerCase();
    return `${host}/${pathname}`;
  }

  try {
    const parsed = new URL(repoUrl);
    const host = parsed.host.toLowerCase();
    const pathname = stripGitSuffix(parsed.pathname.replace(/^\//, '')).toLowerCase();
    return `${host}/${pathname}`;
  } catch {
    return repoUrl;
  }
}

function stripGitSuffix(pathname: string): string {
  return pathname.replace(/\.git$/i, '');
}

function stripFilePath(filePath: string): string {
  return filePath.replace(/\.git$/i, '');
}
