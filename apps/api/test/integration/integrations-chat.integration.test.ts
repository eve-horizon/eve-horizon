import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
const projectName = `integration-chat-sim-${Date.now()}`;
const projectSlug = `csi${Math.random().toString(36).substring(2, 6)}`;
const repoBranch = process.env.EVE_INTEGRATION_REPO_BRANCH || 'main';

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;
const gitSha = '1111111111111111111111111111111111111111';
const internalToken = process.env.EVE_INTERNAL_API_KEY || 'test-internal-key';

function buildProjectSlug(prefix: string): string {
  const suffix = Math.random().toString(36).substring(2, 4);
  const base = `${prefix}${suffix}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  const trimmed = base.slice(0, 8);
  if (trimmed.length >= 4) {
    return trimmed;
  }
  return `${trimmed}a`.slice(0, 4);
}

async function runEve(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    cwd: repoRoot,
    env: { ...process.env, EVE_API_URL: apiUrl },
  });
  return stdout.trim();
}

async function requestJson<T>(requestPath: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${requestPath}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<T>;
}

async function requestInternalJson<T>(requestPath: string, body: Record<string, unknown>): Promise<T> {
  return requestJson<T>(requestPath, {
    method: 'POST',
    headers: {
      'x-eve-internal-token': internalToken,
    },
    body: JSON.stringify(body),
  });
}

describe('integration org integrations + chat simulate', () => {
  it('connects slack integration and routes simulated chat', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      projectName,
      '--slug',
      projectSlug,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const agentsYaml = `\
version: 1
agents:
  mission_control:
    skill: eve-mission-control
    workflow: assistant
`;

    const teamsYaml = `\
version: 1
teams:
  default:
    lead: mission_control
    members: [mission_control]
`;

    const chatYaml = `\
version: 1
default_route: route_default
routes:
  - id: route_default
    match: ".*"
    target: agent:mission_control
`;

    await requestJson(`/projects/${project.id}/agents/sync`, {
      method: 'POST',
      body: JSON.stringify({
        agents_yaml: agentsYaml,
        teams_yaml: teamsYaml,
        chat_yaml: chatYaml,
        git_sha: gitSha,
        branch: 'main',
      }),
    });

    const integration = await requestJson<{
      id: string;
      org_id: string;
      provider: string;
      account_id: string;
    }>(`/orgs/${org.id}/integrations/slack/connect`, {
      method: 'POST',
      body: JSON.stringify({
        team_id: 'T999',
        tokens_json: { access_token: 'fake' },
      }),
    });

    expect(integration.org_id).toBe(org.id);
    expect(integration.provider).toBe('slack');

    const list = await requestJson<{ integrations: { id: string }[] }>(`/orgs/${org.id}/integrations`);
    expect(list.integrations.length).toBeGreaterThan(0);

    const routed = await requestJson<{
      thread_id: string;
      route_id: string | null;
      job_ids: string[];
    }>(`/projects/${project.id}/chat/simulate`, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'slack',
        team_id: 'T999',
        channel_id: 'C123',
        user_id: 'U999',
        text: 'hello from simulate',
      }),
    });

    expect(routed.route_id).toBe('route_default');
    expect(routed.job_ids.length).toBeGreaterThan(0);
    expect(routed.thread_id).toBeTruthy();
  }, 60_000);

  it('subscribes listeners and dispatches to channel + thread', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectOneRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `listener-alpha-${Date.now()}`,
      '--slug',
      buildProjectSlug('alpha'),
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const projectOne = JSON.parse(projectOneRaw) as { id: string };

    const projectTwoRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `listener-beta-${Date.now()}`,
      '--slug',
      buildProjectSlug('beta'),
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const projectTwo = JSON.parse(projectTwoRaw) as { id: string };

    const alphaSlug = `alpha-${Math.random().toString(36).substring(2, 6)}`;
    const betaSlug = `beta-${Math.random().toString(36).substring(2, 6)}`;

    const agentsYamlAlpha = `\
version: 1
agents:
  listener_alpha:
    slug: ${alphaSlug}
    description: "Alpha listener"
    skill: eve-mission-control
    workflow: assistant
`;

    const agentsYamlBeta = `\
version: 1
agents:
  listener_beta:
    slug: ${betaSlug}
    description: "Beta listener"
    skill: eve-mission-control
    workflow: assistant
`;

    const teamsYamlAlpha = `\
version: 1
teams:
  default:
    lead: listener_alpha
    members: [listener_alpha]
`;

    const teamsYamlBeta = `\
version: 1
teams:
  default:
    lead: listener_beta
    members: [listener_beta]
`;

    const chatYamlAlpha = `\
version: 1
default_route: route_default
routes:
  - id: route_default
    match: ".*"
    target: agent:listener_alpha
`;

    const chatYamlBeta = `\
version: 1
default_route: route_default
routes:
  - id: route_default
    match: ".*"
    target: agent:listener_beta
`;

    await requestJson(`/projects/${projectOne.id}/agents/sync`, {
      method: 'POST',
      body: JSON.stringify({
        agents_yaml: agentsYamlAlpha,
        teams_yaml: teamsYamlAlpha,
        chat_yaml: chatYamlAlpha,
        git_sha: gitSha,
        branch: 'main',
      }),
    });

    await requestJson(`/projects/${projectTwo.id}/agents/sync`, {
      method: 'POST',
      body: JSON.stringify({
        agents_yaml: agentsYamlBeta,
        teams_yaml: teamsYamlBeta,
        chat_yaml: chatYamlBeta,
        git_sha: gitSha,
        branch: 'main',
      }),
    });

    const channelId = `C${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`;
    const threadId = `T${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
    const channelKey = `T999:${channelId}`;
    const threadKey = `T999:${channelId}:${threadId}`;

    const listenAlpha = await requestInternalJson<{
      thread_id: string;
      thread_key: string;
      scope: string;
      agent_slug: string;
      project_slug: string;
    }>(`/internal/orgs/${org.id}/chat/listen`, {
      provider: 'slack',
      account_id: 'T999',
      channel_id: channelId,
      thread_key: channelKey,
      scope: 'channel',
      agent_slug: alphaSlug,
    });

    expect(listenAlpha.thread_key).toBe(channelKey);
    expect(listenAlpha.agent_slug).toBe(alphaSlug);

    const listenBeta = await requestInternalJson<{
      thread_key: string;
      scope: string;
      agent_slug: string;
    }>(`/internal/orgs/${org.id}/chat/listen`, {
      provider: 'slack',
      account_id: 'T999',
      channel_id: channelId,
      thread_key: threadKey,
      scope: 'thread',
      agent_slug: betaSlug,
    });

    expect(listenBeta.thread_key).toBe(threadKey);
    expect(listenBeta.agent_slug).toBe(betaSlug);

    const listeners = await requestInternalJson<{
      channel_key: string | null;
      thread_key: string | null;
      channel_listeners: { agent_slug: string | null }[];
      thread_listeners: { agent_slug: string | null }[];
    }>(`/internal/orgs/${org.id}/chat/listeners`, {
      channel_key: channelKey,
      thread_key: threadKey,
    });

    expect(listeners.channel_listeners.map((entry) => entry.agent_slug)).toContain(alphaSlug);
    expect(listeners.thread_listeners.map((entry) => entry.agent_slug)).toContain(betaSlug);

    const dispatch = await requestInternalJson<{ job_ids: string[] }>(
      `/internal/orgs/${org.id}/chat/dispatch`,
      {
        provider: 'slack',
        account_id: 'T999',
        channel_id: channelId,
        user_id: 'U999',
        text: 'listener dispatch test',
        thread_key: threadKey,
        channel_key: channelKey,
      },
    );

    expect(dispatch.job_ids.length).toBe(2);

    const unlisten = await requestInternalJson<{
      removed: boolean;
      agent_slug: string;
    }>(`/internal/orgs/${org.id}/chat/unlisten`, {
      provider: 'slack',
      account_id: 'T999',
      channel_id: channelId,
      thread_key: channelKey,
      scope: 'channel',
      agent_slug: alphaSlug,
    });

    expect(unlisten.removed).toBe(true);

    const unlistenBeta = await requestInternalJson<{
      removed: boolean;
      agent_slug: string;
    }>(`/internal/orgs/${org.id}/chat/unlisten`, {
      provider: 'slack',
      account_id: 'T999',
      channel_id: channelId,
      thread_key: threadKey,
      scope: 'thread',
      agent_slug: betaSlug,
    });

    expect(unlistenBeta.removed).toBe(true);
  }, 60_000);
});
