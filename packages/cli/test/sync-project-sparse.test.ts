import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GIT_SHA = '0123456789abcdef0123456789abcdef01234567';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn((command: string) => {
      if (command.includes('branch --show-current')) return 'main\n';
      return '0123456789abcdef0123456789abcdef01234567\n';
    }),
  };
});

vi.mock('../src/lib/client', () => ({
  requestJson: vi.fn(),
}));

vi.mock('../src/lib/git', () => ({
  getGitRoot: vi.fn((repoRoot: string) => repoRoot),
  isGitDirty: vi.fn(() => false),
  getGitBranch: vi.fn(() => 'main'),
  resolveGitBranch: vi.fn(() => 'main'),
  resolveGitRef: vi.fn().mockResolvedValue('0123456789abcdef0123456789abcdef01234567'),
}));

vi.mock('@eve/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/shared')>();
  return {
    ...actual,
    resolvePack: vi.fn(),
  };
});

import { resolvePack } from '@eve/shared';
import { requestJson } from '../src/lib/client';
import { runUnifiedSync, DEFAULT_CHAT_YAML, DEFAULT_TEAMS_YAML } from '../src/lib/sync-project';

const context = {
  apiUrl: 'http://api.eve.lvh.me',
  token: 'token',
  profile: null,
  profileName: null,
  projectId: 'proj_test',
};

function writeSparseManifest(repoDir: string, extraXEve = '', extraTopLevel = ''): void {
  mkdirSync(join(repoDir, '.eve'), { recursive: true });
  writeFileSync(
    join(repoDir, '.eve/manifest.yaml'),
    `
project: proj_test
name: sparse-agent-app
x-eve:
  agents:
    config_path: .eve/agents.yaml
    skills_root: skills/
${extraXEve}
${extraTopLevel}
`,
    'utf-8',
  );
}

function writeAgentsYaml(repoDir: string): void {
  writeFileSync(
    join(repoDir, '.eve/agents.yaml'),
    `
version: 1
agents:
  planner:
    slug: sparse-agent-planner
    skill: planner-skill
    harness_profile: primary-orchestrator
`,
    'utf-8',
  );
}

function mockApi(): void {
  vi.mocked(requestJson).mockImplementation(async (_ctx, path, options) => {
    if (path === '/projects/proj_test') {
      return { slug: 'sparse' };
    }
    if (path === '/projects/proj_test/manifest') {
      return {
        id: 'pm_test',
        manifest_hash: 'abc123',
        parsed_defaults: null,
        created_at: new Date().toISOString(),
      };
    }
    if (path === '/projects/proj_test/agents/sync') {
      const body = (options as { body?: Record<string, unknown> } | undefined)?.body ?? {};
      return { agents_count: body.agents_yaml ? 1 : 0 };
    }
    throw new Error(`Unexpected request ${path}`);
  });
}

function agentsSyncBody(): Record<string, unknown> {
  const call = vi.mocked(requestJson).mock.calls.find(([, path]) => path === '/projects/proj_test/agents/sync');
  return (call?.[2] as { body?: Record<string, unknown> } | undefined)?.body ?? {};
}

describe('project sync sparse agent config', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.mocked(requestJson).mockReset();
    vi.mocked(resolvePack).mockReset();
  });

  function tempRepo(): string {
    const repoDir = mkdtempSync(join(tmpdir(), 'eve-cli-sparse-agents-'));
    dirs.push(repoDir);
    return repoDir;
  }

  it('syncs agents-only repos with default teams and chat yaml', async () => {
    const repoDir = tempRepo();
    writeSparseManifest(repoDir);
    writeAgentsYaml(repoDir);
    mockApi();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runUnifiedSync({ dir: repoDir, project: 'proj_test', local: true, json: true }, context as never);

    const body = agentsSyncBody();
    expect(body.agents_yaml).toContain('sparse-agent-planner');
    expect(body.teams_yaml).toBe(DEFAULT_TEAMS_YAML);
    expect(body.chat_yaml).toBe(DEFAULT_CHAT_YAML);
  });

  it('throws when agents.config_path is explicit and missing', async () => {
    const repoDir = tempRepo();
    writeSparseManifest(repoDir);
    mockApi();

    await expect(
      runUnifiedSync({ dir: repoDir, project: 'proj_test', local: true, json: true }, context as never),
    ).rejects.toThrow(/Missing agents config at .*\.eve\/agents\.yaml/);
  });

  it('throws when agents.teams_path is explicit and missing', async () => {
    const repoDir = tempRepo();
    writeSparseManifest(repoDir, '    teams_path: .eve/missing-teams.yaml');
    writeAgentsYaml(repoDir);
    mockApi();

    await expect(
      runUnifiedSync({ dir: repoDir, project: 'proj_test', local: true, json: true }, context as never),
    ).rejects.toThrow(/Missing teams config at .*\.eve\/missing-teams\.yaml/);
  });

  it('throws when x-eve.chat.config_path is explicit and missing', async () => {
    const repoDir = tempRepo();
    writeSparseManifest(repoDir, '  chat:\n    config_path: .eve/missing-chat.yaml');
    writeAgentsYaml(repoDir);
    mockApi();

    await expect(
      runUnifiedSync({ dir: repoDir, project: 'proj_test', local: true, json: true }, context as never),
    ).rejects.toThrow(/Missing chat config at .*\.eve\/missing-chat\.yaml/);
  });

  it('throws when legacy chat.config_path is explicit and missing', async () => {
    const repoDir = tempRepo();
    writeSparseManifest(repoDir, '', 'chat:\n  config_path: .eve/legacy-chat.yaml');
    writeAgentsYaml(repoDir);
    mockApi();

    await expect(
      runUnifiedSync({ dir: repoDir, project: 'proj_test', local: true, json: true }, context as never),
    ).rejects.toThrow(/Missing chat config at .*\.eve\/legacy-chat\.yaml/);
  });

  it('skips implicit missing local overlays when packs are present', async () => {
    const repoDir = tempRepo();
    mkdirSync(join(repoDir, '.eve'), { recursive: true });
    writeFileSync(
      join(repoDir, '.eve/manifest.yaml'),
      `
project: proj_test
name: sparse-pack-app
x-eve:
  packs:
    - source: ./pack
      ref: ${GIT_SHA}
`,
      'utf-8',
    );
    vi.mocked(resolvePack).mockResolvedValue({
      id: 'pack',
      source: './pack',
      ref: GIT_SHA,
      rootPath: join(repoDir, 'pack'),
      agents: { version: 1, agents: { pack_agent: { slug: 'pack-agent', skill: 'pack-skill' } } },
      teams: { version: 1, teams: {} },
      workflows: null,
      chat: null,
      xEve: null,
      skillPaths: [],
    });
    mockApi();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runUnifiedSync({ dir: repoDir, project: 'proj_test', local: true, json: true }, context as never);

    const body = agentsSyncBody();
    expect(body.agents_yaml).toContain('pack-agent');
    expect(body.teams_yaml).toContain('teams: {}');
    expect(body.chat_yaml).toContain('routes: []');
  });

  it('throws for explicit missing local overlays when packs are present', async () => {
    const repoDir = tempRepo();
    mkdirSync(join(repoDir, '.eve'), { recursive: true });
    writeFileSync(
      join(repoDir, '.eve/manifest.yaml'),
      `
project: proj_test
name: sparse-pack-app
x-eve:
  packs:
    - source: ./pack
      ref: ${GIT_SHA}
  agents:
    teams_path: .eve/missing-teams.yaml
`,
      'utf-8',
    );
    vi.mocked(resolvePack).mockResolvedValue({
      id: 'pack',
      source: './pack',
      ref: GIT_SHA,
      rootPath: join(repoDir, 'pack'),
      agents: { version: 1, agents: {} },
      teams: { version: 1, teams: {} },
      workflows: null,
      chat: null,
      xEve: null,
      skillPaths: [],
    });
    mockApi();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      runUnifiedSync({ dir: repoDir, project: 'proj_test', local: true, json: true }, context as never),
    ).rejects.toThrow(/Missing teams config at .*\.eve\/missing-teams\.yaml/);
  });

  it('passes through existing empty teams and chat files instead of defaulting', async () => {
    const repoDir = tempRepo();
    writeSparseManifest(repoDir);
    writeAgentsYaml(repoDir);
    mkdirSync(join(repoDir, 'agents'), { recursive: true });
    writeFileSync(join(repoDir, 'agents/teams.yaml'), '', 'utf-8');
    writeFileSync(join(repoDir, 'agents/chat.yaml'), '', 'utf-8');
    mockApi();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runUnifiedSync({ dir: repoDir, project: 'proj_test', local: true, json: true }, context as never);

    const body = agentsSyncBody();
    expect(body.teams_yaml).toBe('');
    expect(body.chat_yaml).toBe('');
  });
});
