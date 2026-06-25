import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');
const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;

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

async function readFirstSseEvent(
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<{ id?: string; event: string; data: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const response = await fetch(`${apiUrl}${requestPath}`, {
    headers: {
      accept: 'text/event-stream',
      ...headers,
    },
    signal: controller.signal,
  });

  try {
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`SSE request failed: ${response.status} ${body}`);
    }
    if (!response.body) throw new Error('SSE response has no body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SSE stream ended before an event arrived');
      buffer += decoder.decode(chunk.value, { stream: true });
      const boundary = buffer.search(/\r?\n\r?\n/);
      if (boundary === -1) continue;
      const raw = buffer.slice(0, boundary);
      await reader.cancel().catch(() => undefined);
      return parseSseEvent(raw);
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function parseSseEvent(raw: string): { id?: string; event: string; data: unknown } {
  let id: string | undefined;
  let event = 'message';
  const data: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('id:')) id = line.slice('id:'.length).trim();
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }

  const text = data.join('\n');
  return {
    ...(id ? { id } : {}),
    event,
    data: text ? JSON.parse(text) : null,
  };
}

describe('embedded app conversations facade', () => {
  it('ensures an app-keyed thread, routes an explicit agent turn, continues it, and replays metadata/messages', async () => {
    const orgRaw = await runEve(['org', 'ensure', 'default-test-org', '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    const suffix = Math.random().toString(36).substring(2, 7);
    const agentSlug = `od${suffix}`;
    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `integration-conversations-${suffix}`,
      '--slug',
      `cv${suffix}`,
      '--repo-url',
      `file://${repoPath}`,
      '--branch',
      'main',
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const agentsYaml = `
version: 1
agents:
  designer:
    slug: ${agentSlug}
    skill: eve-designer
    workflow: assistant
    gateway:
      policy: routable
      clients: [app]
`;

    const teamsYaml = `
version: 1
teams:
  default:
    lead: designer
    members: [designer]
`;

    const chatYaml = `
version: 1
default_route: route_default
routes:
  - id: app_route
    match: "^hello"
    providers: [app]
    account_ids: [manual-app]
    target: agent:designer
  - id: route_default
    match: ".*"
    target: agent:designer
`;

    await requestJson(`/projects/${project.id}/agents/sync`, {
      method: 'POST',
      body: JSON.stringify({
        agents_yaml: agentsYaml,
        teams_yaml: teamsYaml,
        chat_yaml: chatYaml,
        git_sha: '2222222222222222222222222222222222222222',
        branch: 'main',
      }),
    });

    const appKey = `manual:${suffix}`;
    const encodedAppKey = encodeURIComponent(appKey);

    const ensured = await requestJson<{
      thread_id: string;
      key: string;
      metadata: Record<string, unknown>;
    }>(`/projects/${project.id}/conversations`, {
      method: 'POST',
      body: JSON.stringify({
        app_key: appKey,
        app_id: 'manual-app',
        metadata: { product_route: '/x' },
      }),
    });

    expect(ensured.thread_id).toMatch(/^thr_/);
    expect(ensured.key).toMatch(/^app:manual-app:sha256:/);
    expect(ensured.metadata.app_key).toBe(appKey);
    expect(ensured.metadata.product_metadata).toEqual({ product_route: '/x' });

    const firstTurn = await requestJson<{
      thread_id: string;
      app_id: string;
      target: string | null;
      job_ids: string[];
      dispatch_status: string;
    }>(`/projects/${project.id}/conversations/${encodedAppKey}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        text: 'design the navbar',
        target: { kind: 'agent', agent_slug: agentSlug },
      }),
    });

    expect(firstTurn.thread_id).toBe(ensured.thread_id);
    expect(firstTurn.app_id).toBe('manual-app');
    expect(firstTurn.target).toBe('agent:designer');
    expect(firstTurn.job_ids.length).toBe(1);
    expect(firstTurn.dispatch_status).toBe('queued');

    const continued = await requestJson<{
      thread_id: string;
      target: string | null;
      job_ids: string[];
    }>(`/projects/${project.id}/conversations/${encodedAppKey}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        text: 'now add auth',
      }),
    });

    expect(continued.thread_id).toBe(ensured.thread_id);
    expect(continued.target).toBe('agent:designer');
    expect(continued.job_ids.length).toBe(1);

    const routeTurn = await requestJson<{
      thread_id: string;
      route_id: string | null;
      target: string | null;
      job_ids: string[];
    }>(`/projects/${project.id}/conversations/${encodeURIComponent(`${appKey}:route`)}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        app_id: 'manual-app',
        text: 'hello route predicate',
      }),
    });

    expect(routeTurn.route_id).toBe('app_route');
    expect(routeTurn.target).toBe('agent:designer');
    expect(routeTurn.job_ids.length).toBe(1);

    const messages = await requestJson<{
      messages: Array<{ id: string; body: string; kind: string }>;
    }>(`/projects/${project.id}/conversations/${encodedAppKey}/messages`);

    expect(messages.messages.map((message) => message.body)).toContain('design the navbar');
    expect(messages.messages.map((message) => message.body)).toContain('now add auth');
    expect(messages.messages.every((message) => message.kind === 'message')).toBe(true);

    const resumeAnchor = messages.messages[0];
    const expectedReplay = messages.messages[1];
    expect(resumeAnchor).toBeDefined();
    expect(expectedReplay).toBeDefined();
    const replayed = await readFirstSseEvent(
      `/projects/${project.id}/conversations/${encodedAppKey}/stream`,
      { 'Last-Event-ID': resumeAnchor!.id },
    );
    expect(replayed.id).toBe(expectedReplay!.id);
    expect(replayed.event).toBe('message');
    expect(replayed.data).toEqual(expect.objectContaining({
      id: expectedReplay!.id,
      body: expectedReplay!.body,
      kind: 'message',
    }));

    const progress = await requestJson<{ id: string; kind: string; body: string }>(`/threads/${ensured.thread_id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        direction: 'outbound',
        kind: 'progress',
        body: 'working on it',
      }),
    });
    expect(progress.kind).toBe('progress');

    const progressEvent = await readFirstSseEvent(
      `/projects/${project.id}/conversations/${encodedAppKey}/stream`,
      { 'Last-Event-ID': expectedReplay!.id },
    );
    expect(progressEvent.id).toBe(progress.id);
    expect(progressEvent.event).toBe('progress');
    expect(progressEvent.data).toEqual(expect.objectContaining({
      id: progress.id,
      body: 'working on it',
      kind: 'progress',
    }));

    const conversationEvents = await requestJson<{
      events: Array<{ id: string; cursor: string; kind: string; text: string | null; message_id?: string | null }>;
    }>(`/projects/${project.id}/conversations/${encodedAppKey}/events`);

    expect(conversationEvents.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'user.message',
      'progress',
    ]));
    const progressConversationEvent = conversationEvents.events.find((event) => event.message_id === progress.id);
    expect(progressConversationEvent).toEqual(expect.objectContaining({
      kind: 'progress',
      text: 'working on it',
    }));

    const artifactEvent = await requestJson<{
      id: string;
      cursor: string;
      kind: string;
      text: string | null;
      payload: Record<string, unknown>;
    }>(`/projects/${project.id}/conversations/${encodedAppKey}/events?app_id=manual-app`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'artifact.update',
        source: 'app',
        text: 'preview updated',
        payload: { artifact_id: 'artifact_1', version: 1 },
      }),
    });
    expect(artifactEvent.kind).toBe('artifact.update');
    expect(artifactEvent.payload).toEqual({ artifact_id: 'artifact_1', version: 1 });

    const replayedArtifact = await readFirstSseEvent(
      `/projects/${project.id}/conversations/${encodedAppKey}/events/stream?app_id=manual-app`,
      { 'Last-Event-ID': progressConversationEvent!.cursor },
    );
    expect(replayedArtifact.id).toBe(artifactEvent.cursor);
    expect(replayedArtifact.event).toBe('artifact.update');
    expect(replayedArtifact.data).toEqual(expect.objectContaining({
      id: artifactEvent.id,
      cursor: artifactEvent.cursor,
      kind: 'artifact.update',
      text: 'preview updated',
    }));

    await requestJson(`/projects/${project.id}/events`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'lint.finding',
        source: 'app',
        payload: {
          thread_id: ensured.thread_id,
          finding_id: 'lint_1',
          severity: 'warning',
        },
      }),
    });

    const lintEvents = await requestJson<{
      events: Array<{ kind: string; payload: Record<string, unknown> }>;
    }>(`/threads/${ensured.thread_id}/events?kind=lint.finding`);
    expect(lintEvents.events).toEqual([
      expect.objectContaining({
        kind: 'lint.finding',
        payload: expect.objectContaining({ finding_id: 'lint_1' }),
      }),
    ]);

    const resolved = await requestJson<{
      thread_id: string;
      metadata: Record<string, unknown>;
      current_target: { kind: string; target: string } | null;
      last_message: { body: string; kind: string } | null;
    }>(`/projects/${project.id}/conversations/${encodedAppKey}`);

    expect(resolved.thread_id).toBe(ensured.thread_id);
    expect(resolved.metadata.app_key).toBe(appKey);
    expect(resolved.current_target).toEqual(expect.objectContaining({
      kind: 'agent',
      target: 'agent:designer',
    }));
    expect(resolved.last_message).toEqual(expect.objectContaining({
      body: 'working on it',
      kind: 'progress',
    }));
  }, 60_000);
});
