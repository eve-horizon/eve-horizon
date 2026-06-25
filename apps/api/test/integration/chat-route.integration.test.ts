import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
const projectName = `integration-chat-route-${Date.now()}`;
const projectSlug = `chr${Math.random().toString(36).substring(2, 6)}`;
const repoBranch = process.env.EVE_INTEGRATION_REPO_BRANCH || 'main';

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;
const gitSha = '1111111111111111111111111111111111111111';

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

type SseEvent = {
  event: string;
  data: unknown;
};

async function collectSseEvents(response: Response, wantedEvents: string[], timeoutMs = 8_000): Promise<SseEvent[]> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SSE request failed: ${response.status} ${body}`);
  }
  if (!response.body) {
    throw new Error('SSE response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();
  const events: SseEvent[] = [];
  let buffer = '';

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for SSE events')), remaining)),
      ]);

      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) {
          break;
        }

        const rawEvent = buffer.slice(0, match.index).trim();
        buffer = buffer.slice(match.index + match[0].length);
        if (!rawEvent) {
          continue;
        }

        let eventType = 'message';
        const dataLines: string[] = [];
        for (const line of rawEvent.split(/\r?\n/)) {
          if (line.startsWith('event:')) {
            eventType = line.slice('event:'.length).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart());
          }
        }

        if (dataLines.length === 0) {
          continue;
        }

        const payloadText = dataLines.join('\n');
        let payload: unknown = payloadText;
        try {
          payload = JSON.parse(payloadText);
        } catch {
          payload = payloadText;
        }

        events.push({ event: eventType, data: payload });
        if (wantedEvents.includes(eventType)) {
          seen.add(eventType);
        }
        if (wantedEvents.every((eventName) => seen.has(eventName))) {
          return events;
        }
      }
    }
  } finally {
    await reader.cancel();
  }

  throw new Error(`Timed out waiting for SSE events: ${wantedEvents.join(', ')}`);
}

describe('integration chat route', () => {
  it('routes message to team and creates jobs + thread', async () => {
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

    const agentsYaml = `
version: 1
agents:
  mission_control:
    skill: eve-mission-control
    workflow: assistant
  reviewer:
    skill: eve-reviewer
    workflow: review
`;

    const teamsYaml = `
version: 1
teams:
  ops:
    lead: mission_control
    members: [reviewer]
    dispatch:
      mode: fanout
`;

    const chatYaml = `
version: 1
default_route: route_default
routes:
  - id: route_default
    match: ".*"
    target: team:ops
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

    const routed = await requestJson<{
      thread_id: string;
      route_id: string | null;
      job_ids: string[];
    }>(`/projects/${project.id}/chat/route`, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'slack',
        account_id: 'T111',
        channel_id: 'C123',
        user_id: 'U999',
        text: 'hello from slack',
      }),
    });

    expect(routed.route_id).toBe('route_default');
    expect(routed.thread_id).toBeTruthy();
    expect(routed.job_ids.length).toBeGreaterThan(0);

    const thread = await requestJson<{ id: string }>(`/threads/${routed.thread_id}`);
    expect(thread.id).toBe(routed.thread_id);
  }, 60_000);

  it('treats default_route as fallback (does not shadow specific routes)', async () => {
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
      `${projectName}-fallback`,
      '--slug',
      `f${projectSlug}`,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const agentsYaml = `
version: 1
agents:
  mission_control:
    skill: eve-mission-control
    workflow: assistant
  reviewer:
    skill: eve-reviewer
    workflow: review
`;

    const teamsYaml = `
version: 1
teams:
  ops:
    lead: mission_control
    members: [reviewer]
    dispatch:
      mode: fanout
`;

    const chatYaml = `
version: 1
default_route: route_default
routes:
  - id: route_factory
    match: "^factory\\\\b"
    target: team:ops
  - id: route_default
    match: ".*"
    target: team:ops
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

    const routed = await requestJson<{
      route_id: string | null;
      job_ids: string[];
    }>(`/projects/${project.id}/chat/route`, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'slack',
        account_id: 'T111',
        channel_id: 'C123',
        user_id: 'U999',
        text: 'factory hello',
      }),
    });

    expect(routed.route_id).toBe('route_factory');
    expect(routed.job_ids.length).toBeGreaterThan(0);
  }, 60_000);

  it('continues a thread by Eve thread ID and preserves the original route target', async () => {
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
      `${projectName}-continuity`,
      '--slug',
      `t${projectSlug}`,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const agentsYaml = `
version: 1
agents:
  mission_control:
    skill: eve-mission-control
    workflow: assistant
  reviewer:
    skill: eve-reviewer
    workflow: review
`;

    const teamsYaml = `
version: 1
teams:
  ops:
    lead: mission_control
    members: [reviewer]
    dispatch:
      mode: fanout
`;

    const initialChatYaml = `
version: 1
default_route: route_default
routes:
  - id: route_default
    match: ".*"
    target: team:ops
`;

    await requestJson(`/projects/${project.id}/agents/sync`, {
      method: 'POST',
      body: JSON.stringify({
        agents_yaml: agentsYaml,
        teams_yaml: teamsYaml,
        chat_yaml: initialChatYaml,
        git_sha: gitSha,
        branch: 'main',
      }),
    });

    const first = await requestJson<{
      thread_id: string;
      thread_key: string | null;
      route_id: string | null;
      target: string | null;
      job_ids: string[];
    }>(`/projects/${project.id}/chat/route`, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'slack',
        account_id: 'T111',
        channel_id: 'C123',
        user_id: 'U999',
        text: 'hello from slack',
      }),
    });

    expect(first.route_id).toBe('route_default');
    expect(first.target).toBe('team:ops');
    expect(first.thread_key).toBeTruthy();
    expect(first.job_ids.length).toBeGreaterThan(0);

    const changedChatYaml = `
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
        chat_yaml: changedChatYaml,
        git_sha: gitSha,
        branch: 'main',
      }),
    });

    const continued = await requestJson<{
      thread_id: string;
      thread_key: string | null;
      route_id: string | null;
      target: string | null;
      job_ids: string[];
    }>(`/threads/${first.thread_id}/chat`, {
      method: 'POST',
      body: JSON.stringify({
        text: 'what about tests?',
      }),
    });

    expect(continued.thread_id).toBe(first.thread_id);
    expect(continued.thread_key).toBe(first.thread_key);
    expect(continued.route_id).toBe('route_default');
    expect(continued.target).toBe('team:ops');
    expect(continued.job_ids.length).toBeGreaterThan(0);

    const messages = await requestJson<{
      messages: Array<{ body: string }>;
      total?: number;
    }>(`/threads/${first.thread_id}/messages`);
    expect(messages.messages.map((msg) => msg.body)).toContain('hello from slack');
    expect(messages.messages.map((msg) => msg.body)).toContain('what about tests?');
  }, 60_000);

  it('streams thread snapshots and new messages over SSE', async () => {
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
      `${projectName}-stream`,
      '--slug',
      `s${projectSlug}`,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const agentsYaml = `
version: 1
agents:
  mission_control:
    skill: eve-mission-control
    workflow: assistant
`;

    const teamsYaml = `
version: 1
teams:
  default:
    lead: mission_control
    members: [mission_control]
`;

    const chatYaml = `
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

    const routed = await requestJson<{
      thread_id: string;
    }>(`/projects/${project.id}/chat/route`, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'slack',
        account_id: 'T111',
        channel_id: 'C123',
        user_id: 'U999',
        text: 'initial message',
      }),
    });

    const streamResponse = await fetch(`${apiUrl}/threads/${routed.thread_id}/stream`, {
      headers: {
        Accept: 'text/event-stream',
      },
    });

    const eventsPromise = collectSseEvents(streamResponse, ['snapshot', 'message']);

    await requestJson(`/threads/${routed.thread_id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        direction: 'inbound',
        actor_type: 'user',
        actor_id: 'U999',
        body: 'stream me',
      }),
    });

    const events = await eventsPromise;
    const snapshot = events.find((event) => event.event === 'snapshot');
    const message = events.find((event) => event.event === 'message');

    expect(snapshot).toBeTruthy();
    expect((snapshot?.data as { messages: Array<{ body: string }> }).messages.length).toBeGreaterThan(0);
    expect(message).toBeTruthy();
    expect((message?.data as { body: string }).body).toBe('stream me');
  }, 60_000);

  it('team dispatch relay creates sequential dependency chain', async () => {
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
      `${projectName}-relay`,
      '--slug',
      `r${projectSlug}`,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const agentsYaml = `
version: 1
agents:
  mission_control:
    skill: eve-mission-control
    workflow: assistant
  reviewer:
    skill: eve-reviewer
    workflow: review
`;

    const teamsYaml = `
version: 1
teams:
  ops:
    lead: mission_control
    members: [reviewer]
    dispatch:
      mode: relay
`;

    const chatYaml = `
version: 1
default_route: route_default
routes:
  - id: route_default
    match: ".*"
    target: team:ops
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

    const routed = await requestJson<{
      route_id: string | null;
      job_ids: string[];
    }>(`/projects/${project.id}/chat/route`, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'slack',
        account_id: 'T111',
        channel_id: 'C123',
        user_id: 'U999',
        text: 'hello relay',
      }),
    });

    expect(routed.route_id).toBe('route_default');
    expect(routed.job_ids.length).toBe(2);

    const parentId = routed.job_ids[0];
    const childId = routed.job_ids[1];

    const childCtx = await requestJson<{
      job: { id: string; parent_id: string | null; assignee: string | null };
      relations: { blocking: Array<{ id: string }> };
    }>(`/jobs/${childId}/context`);

    expect(childCtx.job.parent_id).toBe(parentId);
    expect(childCtx.job.assignee).toBe('reviewer');
    expect(childCtx.relations.blocking.map((j) => j.id)).toContain(parentId);
  }, 60_000);
});
