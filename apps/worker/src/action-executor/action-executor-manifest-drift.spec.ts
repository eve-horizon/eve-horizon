import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expandManifestReferences } from '@eve/shared';
import { ActionExecutorService } from './action-executor.service.js';

describe('ActionExecutorService manifest drift guard', () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('compares the expanded workspace manifest hash', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'eve-worker-manifest-drift-'));
    workspaces.push(workspace);
    mkdirSync(join(workspace, '.eve/workflows/plan/prompts'), { recursive: true });
    const manifestPath = join(workspace, '.eve/manifest.yaml');
    const rawManifest = `
name: ref-test
services: {}
workflows:
  make-plan:
    $ref: .eve/workflows/plan
`;
    writeFileSync(manifestPath, rawManifest, 'utf-8');
    writeFileSync(
      join(workspace, '.eve/workflows/plan/workflow.yaml'),
      `
steps:
  - name: plan
    agent:
      name: planner
      prompt_file: prompts/plan.md
`,
      'utf-8',
    );
    writeFileSync(join(workspace, '.eve/workflows/plan/prompts/plan.md'), 'Make a plan.\n', 'utf-8');

    const expanded = expandManifestReferences(rawManifest, { repoRoot: workspace, manifestPath }).yaml;
    const expandedHash = createHash('sha256').update(expanded).digest('hex');
    const rawHash = createHash('sha256').update(rawManifest).digest('hex');
    expect(rawHash).not.toBe(expandedHash);

    const service = new ActionExecutorService(null as any, {} as any, {} as any);
    const appendLog = vi.fn().mockResolvedValue(undefined);
    Object.assign(service as any, {
      logs: { appendLog },
      manifests: {
        findByProjectAndHash: vi.fn(),
        touch: vi.fn(),
        create: vi.fn(),
      },
    });

    await (service as any).autoSyncManifestFromWorkspace(
      workspace,
      'proj_123',
      '0123456789abcdef0123456789abcdef01234567',
      expandedHash,
      'att_123',
    );

    expect(appendLog).not.toHaveBeenCalled();
    expect((service as any).manifests.create).not.toHaveBeenCalled();
  });
});
