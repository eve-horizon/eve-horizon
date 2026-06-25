import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  materializeScopedOrgFsMount,
  normalizeOrgFsMountSpec,
} from '../../src/org-fs/org-fs-mount.js';

async function chmodTreeWritable(targetPath: string): Promise<void> {
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      await chmodTreeWritable(path.join(targetPath, entry.name));
    }
  }
  await fs.chmod(targetPath, stat.isDirectory() ? 0o755 : 0o644);
}

describe('normalizeOrgFsMountSpec', () => {
  it('returns deny-by-default for missing or invalid payload', () => {
    expect(normalizeOrgFsMountSpec(undefined)).toEqual({
      mode: 'none',
      allow_prefixes: [],
      read_only_prefixes: [],
    });
    expect(
      normalizeOrgFsMountSpec({
        mode: 'write',
        allow_prefixes: ['/groups/pm/**', '../../escape'],
      }),
    ).toEqual({
      mode: 'write',
      allow_prefixes: ['/groups/pm/**'],
      read_only_prefixes: [],
    });
  });
});

describe('materializeScopedOrgFsMount', () => {
  let tempDir = '';
  let orgRoot = '';
  let workspacePath = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-orgfs-mount-'));
    orgRoot = path.join(tempDir, 'org');
    workspacePath = path.join(tempDir, 'workspace');

    await fs.mkdir(path.join(orgRoot, 'groups', 'pm'), { recursive: true });
    await fs.mkdir(path.join(orgRoot, 'groups', 'eng'), { recursive: true });
    await fs.writeFile(path.join(orgRoot, 'groups', 'pm', 'spec.md'), 'pm');
    await fs.writeFile(path.join(orgRoot, 'groups', 'eng', 'notes.md'), 'eng');
  });

  afterEach(async () => {
    if (tempDir) {
      try {
        await chmodTreeWritable(tempDir);
      } catch {
        // Ignore cleanup prep failures.
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not materialize a mount when mode is none', async () => {
    const mount = await materializeScopedOrgFsMount({
      workspacePath,
      orgRoot,
      rawSpec: { mode: 'none', allow_prefixes: ['/groups/pm/**'] },
    });

    expect(mount.mountPath).toBeNull();
  });

  it('materializes read scopes as read-only copies', async () => {
    const mount = await materializeScopedOrgFsMount({
      workspacePath,
      orgRoot,
      rawSpec: { mode: 'read', allow_prefixes: ['/groups/pm/**'] },
    });

    expect(mount.mountPath).toBe(path.join(workspacePath, '.org'));

    const mountedPm = path.join(workspacePath, '.org', 'groups', 'pm', 'spec.md');
    expect(await fs.readFile(mountedPm, 'utf8')).toBe('pm');
    await expect(fs.access(path.join(workspacePath, '.org', 'groups', 'eng'))).rejects.toThrow();
    await expect(fs.writeFile(mountedPm, 'overwrite')).rejects.toThrow();
  });

  it('materializes write scopes as writable symlinks', async () => {
    const mount = await materializeScopedOrgFsMount({
      workspacePath,
      orgRoot,
      rawSpec: { mode: 'write', allow_prefixes: ['/groups/pm/**'] },
    });

    expect(mount.mountPath).toBe(path.join(workspacePath, '.org'));

    const mountedPm = path.join(workspacePath, '.org', 'groups', 'pm');
    const mountedStat = await fs.lstat(mountedPm);
    expect(mountedStat.isSymbolicLink()).toBe(true);

    const newFile = path.join(mountedPm, 'new.md');
    await fs.writeFile(newFile, 'new');
    expect(await fs.readFile(path.join(orgRoot, 'groups', 'pm', 'new.md'), 'utf8')).toBe('new');
  });
});
