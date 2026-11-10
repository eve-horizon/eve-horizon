import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionExecutorService } from './action-executor.service.js';

// The drift guard reads .eve/manifest.yaml from the tenant's checkout and may
// store what it read as a project manifest; it must read only an in-repo
// regular file.

describe('ActionExecutorService workspace manifest read', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setup() {
    const work = mkdtempSync(join(tmpdir(), 'eve-worker-workspace-manifest-'));
    dirs.push(work);
    const workspace = join(work, 'repo');
    mkdirSync(join(workspace, '.eve'), { recursive: true });
    const outside = join(work, 'outside.yaml');
    writeFileSync(outside, 'name: from-the-worker\nworker_token: from-the-worker\n');

    const service = new ActionExecutorService(null as any, {} as any, {} as any);
    const manifests = { findByProjectAndHash: vi.fn().mockResolvedValue(null), touch: vi.fn(), create: vi.fn() };
    Object.assign(service as any, { logs: { appendLog: vi.fn().mockResolvedValue(undefined) }, manifests });
    const sync = () =>
      (service as any).autoSyncManifestFromWorkspace(
        workspace,
        'proj_123',
        '0123456789abcdef0123456789abcdef01234567',
        'a'.repeat(64),
        'att_123',
      ) as Promise<void>;
    return { workspace, outside, manifests, sync };
  }

  it('refuses a manifest that is a symlink outside the repo and stores nothing', async () => {
    const { workspace, outside, manifests, sync } = setup();
    symlinkSync(outside, join(workspace, '.eve', 'manifest.yaml'));

    const error = await sync().then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toMatch(/drift/i);
    expect(manifests.create).not.toHaveBeenCalled();
  });

  it('refuses a manifest that is a named pipe', async () => {
    const { workspace, manifests, sync } = setup();
    execFileSync('mkfifo', [join(workspace, '.eve', 'manifest.yaml')]);

    const error = await sync().then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toMatch(/drift/i);
    expect(manifests.create).not.toHaveBeenCalled();
  });

  it('still records an in-repo manifest that drifted', async () => {
    const { workspace, manifests, sync } = setup();
    writeFileSync(join(workspace, '.eve', 'manifest.yaml'), 'name: shop\nservices: {}\n');

    await expect(sync()).rejects.toThrow(/drift/i);
    expect(manifests.create).toHaveBeenCalledWith(expect.objectContaining({ manifest_yaml: 'name: shop\nservices: {}\n' }));
  });

  it('does nothing when the repo has no manifest', async () => {
    const { manifests, sync } = setup();
    await expect(sync()).resolves.toBeUndefined();
    expect(manifests.create).not.toHaveBeenCalled();
  });
});
