import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessInvocation } from '../../types/harness.js';
import { cleanupAttemptWorkspace } from '../workspace-cleanup.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-workspace-cleanup-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const config = () => ({ WORKSPACE_ROOT: root, EVE_CLEANUP_WORKSPACE_ON_SUCCESS: true, EVE_CLEANUP_WORKSPACE_ON_FAILURE: true });
const invocation = (workspacePath: string, mode: 'job' | 'session' = 'job') => ({ workspacePath, workspace: { mode } }) as HarnessInvocation;

describe('executor workspace cleanup', () => {
  it('cleans completed and failed attempt directories on the executor filesystem', async () => {
    for (const succeeded of [true, false]) {
      const workspace = path.join(root, String(succeeded));
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, 'artifact'), 'temporary');
      await cleanupAttemptWorkspace(invocation(workspace), succeeded, config());
      await expect(fs.access(workspace)).rejects.toThrow();
    }
  });

  it('preserves session workspaces and configured failure retention', async () => {
    const session = path.join(root, 'session');
    const failed = path.join(root, 'failed');
    await fs.mkdir(session); await fs.mkdir(failed);
    await cleanupAttemptWorkspace(invocation(session, 'session'), true, config());
    await cleanupAttemptWorkspace(invocation(failed), false, { ...config(), EVE_CLEANUP_WORKSPACE_ON_FAILURE: false });
    await expect(fs.access(session)).resolves.toBeUndefined();
    await expect(fs.access(failed)).resolves.toBeUndefined();
  });

  it('never deletes the root, unrelated directories, or symlink aliases to another attempt', async () => {
    const unrelated = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-unrelated-'));
    try {
      await cleanupAttemptWorkspace(invocation(root), true, config());
      await cleanupAttemptWorkspace(invocation(unrelated), true, config());
      const other = path.join(root, 'other');
      await fs.mkdir(other);
      await fs.symlink(other, path.join(root, 'alias'));
      await cleanupAttemptWorkspace(invocation(path.join(root, 'alias')), true, config());
      await expect(fs.access(root)).resolves.toBeUndefined();
      await expect(fs.access(unrelated)).resolves.toBeUndefined();
      await expect(fs.access(other)).resolves.toBeUndefined();
    } finally { await fs.rm(unrelated, { recursive: true, force: true }); }
  });
});
