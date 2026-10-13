import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HarnessInvocation } from '../types/harness.js';

/** Clean only an executor-owned attempt directory, after git policies and release hooks. */
export async function cleanupAttemptWorkspace(
  invocation: HarnessInvocation,
  succeeded: boolean,
  config: { WORKSPACE_ROOT: string; EVE_CLEANUP_WORKSPACE_ON_SUCCESS: boolean; EVE_CLEANUP_WORKSPACE_ON_FAILURE: boolean },
): Promise<void> {
  if (invocation.workspace?.mode === 'session' || !invocation.workspacePath) return;
  if (!(succeeded ? config.EVE_CLEANUP_WORKSPACE_ON_SUCCESS : config.EVE_CLEANUP_WORKSPACE_ON_FAILURE)) return;
  const root = path.resolve(config.WORKSPACE_ROOT);
  const workspace = path.resolve(invocation.workspacePath);
  if (workspace === root || !workspace.startsWith(root + path.sep)) return;
  try {
    const realRoot = await fs.realpath(root);
    const realWorkspace = await fs.realpath(workspace);
    // Reject symlink aliases, including aliases to another attempt under the same root.
    if (realWorkspace !== path.join(realRoot, path.relative(root, workspace))) return;
    await fs.rm(realWorkspace, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.warn(`[workspace] Failed to clean attempt workspace ${workspace}:`, error instanceof Error ? error.message : String(error));
  }
}
