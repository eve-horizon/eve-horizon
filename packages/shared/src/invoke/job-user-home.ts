/**
 * Per-job user home directory for secret isolation (Phase 2).
 *
 * Creates an isolated HOME directory for each job attempt so that
 * credential files (Eve CLI, gh, harness auth) are job-scoped and
 * outside the workspace. This prevents agents from reading credentials
 * written for other jobs or the host system.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const JOB_HOMES_ROOT = path.join(os.tmpdir(), 'eve', 'agent-homes');

/**
 * Create a per-job user home directory and return its path.
 *
 * Directory structure:
 *   /tmp/eve/agent-homes/<attemptId>/home/
 *     .config/eve/       — Eve CLI credentials
 *     .config/gh/        — GitHub CLI auth
 *     .claude/           — Claude config
 *     .eve/harnesses/    — Harness config
 *
 * All directories are created with mode 0700.
 */
export async function createJobUserHome(attemptId: string): Promise<string> {
  const homePath = path.join(JOB_HOMES_ROOT, attemptId, 'home');

  await fs.mkdir(homePath, { recursive: true, mode: 0o700 });

  // Pre-create standard config directories so tools find them
  await Promise.all([
    fs.mkdir(path.join(homePath, '.config', 'eve'), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(homePath, '.config', 'gh'), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(homePath, '.claude'), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(homePath, '.eve', 'harnesses'), { recursive: true, mode: 0o700 }),
  ]);

  return homePath;
}

/**
 * Remove a per-job user home directory after the attempt completes.
 * Silent on errors — cleanup is best-effort.
 */
export async function cleanupJobUserHome(attemptId: string): Promise<void> {
  const attemptDir = path.join(JOB_HOMES_ROOT, attemptId);
  try {
    await fs.rm(attemptDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}
