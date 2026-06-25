/**
 * Shared workspace hook execution logic.
 *
 * Extracted from agent-runtime invoke.service.ts (lines 938-1053).
 * Both agent-runtime and worker can call these standalone functions
 * instead of duplicating the hook lifecycle in each service.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { LifecycleLogger } from './types.js';
import { extractPrefixedEnv } from '../harnesses/invoke-utils.js';

const execFileAsync = promisify(execFile);

/**
 * Run a single `.eve/hooks/{hookName}.sh` script inside the workspace.
 *
 * Returns `true` when the hook either does not exist (no-op) or exits
 * successfully. Returns `false` when the hook exits with a non-zero code.
 */
export async function runHook(
  repoPath: string,
  hookName: string,
  env: NodeJS.ProcessEnv,
  secretsFilePath: string | null,
  logLifecycle?: LifecycleLogger,
  attemptId?: string,
): Promise<boolean> {
  const startTime = Date.now();
  const hookPath = path.join(repoPath, '.eve', 'hooks', `${hookName}.sh`);
  try {
    await fs.stat(hookPath);
  } catch {
    return true;
  }

  const prefixedEnv = extractPrefixedEnv(['EVE_WORKER_', 'EVE_HARNESS_'], process.env);
  const hookEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...prefixedEnv,
    ...env,
    EVE_HOOK_NAME: hookName,
  };

  if (secretsFilePath) {
    hookEnv.EVE_SECRETS_FILE = secretsFilePath;
  }

  if (attemptId && logLifecycle) {
    await logLifecycle(attemptId, 'hook', 'start', {
      hook_name: hookName,
    });
  }

  try {
    const hookTimeoutMs = parseInt(process.env.EVE_HOOK_TIMEOUT_MS || '300000', 10);
    await execFileAsync('bash', [hookPath], {
      cwd: repoPath,
      env: hookEnv,
      timeout: hookTimeoutMs,
    });

    if (attemptId && logLifecycle) {
      await logLifecycle(
        attemptId,
        'hook',
        'end',
        { hook_name: hookName },
        { duration_ms: Date.now() - startTime, success: true },
      );
    }
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (attemptId && logLifecycle) {
      await logLifecycle(
        attemptId,
        'hook',
        'end',
        { hook_name: hookName },
        { duration_ms: Date.now() - startTime, success: false, error: errMsg },
      );
    }
    return false;
  }
}

/**
 * Run the acquire-phase hooks for a workspace.
 *
 * For a **new** workspace the sequence is:
 *   1. `on-clone.sh` (preferred) or `post-clone.sh` (legacy fallback)
 *   2. `on-acquire.sh`
 *
 * For a **reused** workspace:
 *   1. `on-reuse.sh`
 *   2. `on-acquire.sh`
 *
 * Any hook failure throws so the caller can fail the job fast.
 */
export async function runAcquireHooks(
  repoPath: string,
  env: NodeJS.ProcessEnv,
  secretsFilePath: string | null,
  isNewWorkspace: boolean,
  logLifecycle?: LifecycleLogger,
  attemptId?: string,
): Promise<void> {
  if (isNewWorkspace) {
    const onClonePath = path.join(repoPath, '.eve', 'hooks', 'on-clone.sh');
    let ranOnClone = false;
    try {
      await fs.stat(onClonePath);
      ranOnClone = true;
    } catch {
      // on-clone doesn't exist, try post-clone
    }

    if (ranOnClone) {
      const success = await runHook(repoPath, 'on-clone', env, secretsFilePath, logLifecycle, attemptId);
      if (!success) {
        throw new Error('on-clone hook failed');
      }
    } else {
      const success = await runHook(repoPath, 'post-clone', env, secretsFilePath, logLifecycle, attemptId);
      if (!success) {
        throw new Error('post-clone hook failed');
      }
    }
  } else {
    const success = await runHook(repoPath, 'on-reuse', env, secretsFilePath, logLifecycle, attemptId);
    if (!success) {
      throw new Error('on-reuse hook failed');
    }
  }

  const acquireSuccess = await runHook(repoPath, 'on-acquire', env, secretsFilePath, logLifecycle, attemptId);
  if (!acquireSuccess) {
    throw new Error('on-acquire hook failed');
  }
}

/**
 * Run the release-phase hook (`on-release.sh`).
 *
 * Unlike acquire hooks, a release failure is silently swallowed — the job
 * has already completed and there is nothing actionable for the caller.
 */
export async function runReleaseHook(
  repoPath: string,
  env: NodeJS.ProcessEnv,
  secretsFilePath: string | null,
  logLifecycle?: LifecycleLogger,
  attemptId?: string,
): Promise<void> {
  await runHook(repoPath, 'on-release', env, secretsFilePath, logLifecycle, attemptId);
}
