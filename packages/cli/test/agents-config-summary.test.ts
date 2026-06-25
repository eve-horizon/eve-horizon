import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAgents } from '../src/commands/agents';

vi.mock('../src/lib/client', () => ({
  requestJson: vi.fn(),
  requestRaw: vi.fn(),
}));

const context = {
  apiUrl: 'http://api.eve.lvh.me',
  token: 'token',
  profile: null,
  profileName: null,
  projectId: 'proj_test',
};

describe('agents config summary', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('reports resolved sparse agents, teams, and chat routes in json mode', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'eve-cli-agents-config-'));
    dirs.push(repoDir);
    mkdirSync(join(repoDir, '.eve'), { recursive: true });
    writeFileSync(
      join(repoDir, '.eve/manifest.yaml'),
      `
name: sparse-agent-app
x-eve:
  agents:
    config_path: .eve/agents.yaml
    skills_root: skills/
    profiles:
      primary-orchestrator:
        harness: codex
`,
      'utf-8',
    );
    writeFileSync(
      join(repoDir, '.eve/agents.yaml'),
      `
version: 1
agents:
  planner:
    slug: acme-planner
    skill: planner-skill
    harness_profile: primary-orchestrator
    workflow: planning
    gateway:
      policy: routable
  reviewer:
    slug: acme-reviewer
    skill: reviewer-skill
    harness_profile: primary-reviewer
`,
      'utf-8',
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleAgents(
      'config',
      [],
      { 'repo-dir': repoDir, json: true, 'no-harnesses': true },
      context as never,
    );

    const payload = JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0] as string);
    expect(payload.agents).toEqual([
      {
        id: 'planner',
        slug: 'acme-planner',
        harness_profile: 'primary-orchestrator',
        workflow: 'planning',
        gateway_policy: 'routable',
      },
      {
        id: 'reviewer',
        slug: 'acme-reviewer',
        harness_profile: 'primary-reviewer',
        workflow: null,
        gateway_policy: 'none',
      },
    ]);
    expect(payload.teams).toEqual([]);
    expect(payload.chat_routes).toEqual([]);
    expect(payload.policy.profiles['primary-orchestrator'].harness).toBe('codex');
  });
});
