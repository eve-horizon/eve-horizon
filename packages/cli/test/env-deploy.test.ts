import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleEnv } from '../src/commands/env';

vi.mock('../src/lib/client', () => ({
  requestJson: vi.fn(),
}));

vi.mock('../src/lib/git', () => ({
  resolveGitRef: vi.fn().mockResolvedValue('0123456789abcdef0123456789abcdef01234567'),
  getGitBranch: vi.fn().mockReturnValue('main'),
}));

import { requestJson } from '../src/lib/client';

const context = {
  apiUrl: 'http://example.test',
  token: 'token',
  profile: null,
  profileName: null,
  projectId: 'proj_test',
};

describe('env deploy', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.mocked(requestJson).mockReset();
  });

  it('expands manifest refs before auto-syncing --repo-dir manifests', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'eve-cli-env-deploy-'));
    dirs.push(repoDir);
    mkdirSync(join(repoDir, '.eve/workflows/plan/prompts'), { recursive: true });
    writeFileSync(
      join(repoDir, '.eve/manifest.yaml'),
      `
project: proj_test
services: {}
workflows:
  plan:
    $ref: .eve/workflows/plan
`,
      'utf-8',
    );
    writeFileSync(
      join(repoDir, '.eve/workflows/plan/workflow.yaml'),
      `
steps:
  - name: plan
    agent:
      name: planner
      prompt_file: prompts/plan.md
`,
      'utf-8',
    );
    writeFileSync(join(repoDir, '.eve/workflows/plan/prompts/plan.md'), 'Plan it.\n', 'utf-8');

    vi.mocked(requestJson)
      .mockResolvedValueOnce({
        id: 'pm_123',
        project_id: 'proj_test',
        manifest_yaml: '',
        manifest_hash: 'expandedhash',
        git_sha: '0123456789abcdef0123456789abcdef01234567',
        branch: 'main',
        parsed_defaults: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        environment: {
          id: 'env_123',
          project_id: 'proj_test',
          name: 'dev',
          type: 'persistent',
          namespace: null,
          db_ref: null,
          overrides: null,
          current_release_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        pipeline_run: {
          run: {
            id: 'prun_123',
            pipeline_name: 'deploy',
            env_name: 'dev',
            git_sha: '0123456789abcdef0123456789abcdef01234567',
            status: 'queued',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          steps: [],
        },
      });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleEnv(
      'deploy',
      ['dev'],
      { ref: 'main', 'repo-dir': repoDir, json: true, watch: false },
      context as never,
    );

    const manifestPost = vi.mocked(requestJson).mock.calls[0]?.[2] as { body?: { yaml?: string } };
    expect(manifestPost.body?.yaml).toContain('prompt: |\n            Plan it.');
    expect(manifestPost.body?.yaml).not.toContain('$ref');
    expect(manifestPost.body?.yaml).not.toContain('prompt_file');
  });
});
