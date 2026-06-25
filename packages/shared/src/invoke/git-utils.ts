/**
 * Shared git utility functions used by both Worker and Agent Runtime.
 *
 * These helpers were duplicated identically across the two invoke services
 * and are now extracted here as the single source of truth.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import type { ResolvedGitMetadata } from '../schemas/git-controls.js';
import type { UpdateAttemptGitMetaFn } from './types.js';

const execFileAsync = promisify(execFile);

type ExecResult = { stdout: string; stderr: string };

// ---------------------------------------------------------------------------
// runGit
// ---------------------------------------------------------------------------

/**
 * Execute a git command and return stdout/stderr.
 */
export async function runGit(
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<ExecResult> {
  return (await execFileAsync('git', args, {
    env: options?.env,
    cwd: options?.cwd,
  })) as ExecResult;
}

// ---------------------------------------------------------------------------
// getLocalRepoPath
// ---------------------------------------------------------------------------

/**
 * If `repoUrl` uses the `file:` protocol, return the local filesystem path.
 * Returns `null` for any other protocol or on parse failure.
 */
export function getLocalRepoPath(repoUrl: string): string | null {
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== 'file:') return null;
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// redactRepoUrl
// ---------------------------------------------------------------------------

/**
 * Replace embedded credentials in a repo URL with `***` for safe logging.
 * Returns the original string if it cannot be parsed as a URL.
 */
export function redactRepoUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    return url.toString();
  } catch {
    return repoUrl;
  }
}

// ---------------------------------------------------------------------------
// updateAttemptGitMeta
// ---------------------------------------------------------------------------

/**
 * Persist resolved git metadata on a job attempt row.
 *
 * Non-fatal — errors are logged but swallowed so they never fail the job.
 *
 * Accepts a callback (`updateFn`) that performs the actual DB write,
 * keeping this module free of direct database dependencies.
 */
export async function updateAttemptGitMeta(
  updateFn: UpdateAttemptGitMetaFn,
  attemptId: string,
  gitMeta: ResolvedGitMetadata | undefined,
): Promise<void> {
  if (!gitMeta) return;
  try {
    await updateFn(attemptId, gitMeta as Record<string, unknown>);
    console.log(`Updated git_json for attempt ${attemptId}:`, gitMeta);
  } catch (error) {
    console.error(`Failed to update git_json for attempt ${attemptId}:`, error);
  }
}
