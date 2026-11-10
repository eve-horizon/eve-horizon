import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { TriggerMatcherService } from './trigger-matcher.service';
import { EventRouterService } from './event-router.service';

/**
 * Pipeline and workflow names come from the project's manifest. The event
 * router must send them to the API only as one path segment under the
 * event's own project, so a name can never select a different route.
 */

const TENANT = 'proj_tenant';
const OTHER = 'proj_other';

const received: Array<{ url: string; body: string }> = [];
let server: http.Server;
let apiUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"job_id":"job_1"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
});

const quietLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function manifestWith(kind: 'pipelines' | 'workflows', name: string): string {
  const step = kind === 'pipelines' ? '      - run: echo hi' : '      - agent: { name: x }';
  return [
    `${kind}:`,
    `  ${JSON.stringify(name)}:`,
    '    trigger:',
    '      app:',
    '        event: go',
    '    steps:',
    step,
  ].join('\n');
}

function appEvent(): any {
  return {
    id: 'evt_1',
    project_id: TENANT,
    source: 'app',
    type: 'go',
    env_name: null,
    ref_sha: 'a'.repeat(40),
    ref_branch: null,
    actor_type: 'user',
    actor_id: 'user_1',
    payload_json: { note: 'input' },
  };
}

function router(): any {
  const r = Object.create(EventRouterService.prototype) as any;
  r.config = { EVE_INTERNAL_API_KEY: 'internal-key', EVE_API_URL: apiUrl };
  r.logger = quietLogger;
  r.linkJobToEvent = async () => {};
  return r;
}

/** Match the manifest's triggers for the event and dispatch each match to the local API. */
async function dispatch(kind: 'pipelines' | 'workflows', name: string): Promise<void> {
  const matcher = new TriggerMatcherService({} as any);
  (matcher as any).logger = quietLogger;
  (matcher as any).manifests = {
    findLatestByProject: async () => ({ manifest_yaml: manifestWith(kind, name) }),
  };
  const event = appEvent();
  const { matches } = await matcher.matchTriggersForEvent(event);
  expect(matches.map((m) => m.name)).toEqual([name]);
  const r = router();
  for (const match of matches) {
    await r.triggerMatch(match, event).catch(() => undefined);
  }
}

/** Every request the API saw is the tenant's own route with the name as one segment. */
function expectOnlyTenantRoute(kind: 'pipelines' | 'workflows', name: string): void {
  const suffix = kind === 'pipelines' ? 'runs' : 'invoke';
  const shape = new RegExp(`^/internal/projects/${TENANT}/${kind}/([^/?#]+)/${suffix}$`);
  for (const { url } of received) {
    const match = shape.exec(url);
    expect(match, `unexpected API path ${url}`).not.toBeNull();
    expect(decodeURIComponent(match![1])).toBe(name);
  }
  expect(received.filter(({ url }) => url.includes(OTHER))).toEqual([]);
}

const DIRECTED_NAMES = [
  `../../${OTHER}/workflows/nightly-report/invoke?`,
  `../../${OTHER}/pipelines/deploy/runs?`,
  '..',
  '.',
  `x/../../../${OTHER}/workflows/y/invoke`,
  '%2e%2e',
  `%2e%2e/%2e%2e/${OTHER}/workflows/y/invoke?`,
  `..\\..\\${OTHER}\\workflows\\y\\invoke`,
  'name?project=other',
  'name#fragment',
];

describe('event router internal API paths', () => {
  for (const kind of ['workflows', 'pipelines'] as const) {
    it.each(DIRECTED_NAMES)(`sends ${kind} named %s only to the event's own project route`, async (name) => {
      await dispatch(kind, name);
      expectOnlyTenantRoute(kind, name);
    });

    it.each(['nightly-report', 'deploy_v2', 'my.flow', 'release 1', 'ci:main'])(
      `still dispatches ${kind} named %s`,
      async (name) => {
        await dispatch(kind, name);
        expect(received).toHaveLength(1);
        expectOnlyTenantRoute(kind, name);
      },
    );
  }

  it('sends the tenant event, sha and inputs with a pipeline run on its own route', async () => {
    await dispatch('pipelines', 'deploy');
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(`/internal/projects/${TENANT}/pipelines/deploy/runs`);
    expect(JSON.parse(received[0].body)).toMatchObject({ git_sha: 'a'.repeat(40) });
  });
});

describe('event router internal API client', () => {
  it.each([
    ['a dot segment', `/internal/projects/${TENANT}/workflows/../../${OTHER}/workflows/x/invoke`],
    ['an encoded dot segment', `/internal/projects/${TENANT}/workflows/%2e%2e/%2E%2E/${OTHER}/workflows/x/invoke`],
    ['an encoded slash', `/internal/projects/${TENANT}/workflows/a%2F..%2F..%2F${OTHER}/invoke`],
    ['an encoded backslash', `/internal/projects/${TENANT}/workflows/a%5Cb/invoke`],
    ['a backslash', `/internal/projects/${TENANT}/workflows/a\\..\\..\\b/invoke`],
    ['a query string', `/internal/projects/${TENANT}/workflows/x/invoke?project_id=${OTHER}`],
    ['a fragment', `/internal/projects/${TENANT}/workflows/x/invoke#y`],
    ['a protocol-relative path', '//other.example/internal/projects/x'],
    ['a relative path', `internal/projects/${TENANT}/workflows/x/invoke`],
  ])('refuses a path with %s and sends nothing', async (_label, path) => {
    await expect(router().callInternalApi(path, {})).rejects.toThrow(/plain/i);
    expect(received).toEqual([]);
  });

  it('sends a plain path', async () => {
    await expect(
      router().callInternalApi(`/internal/projects/${TENANT}/workflows/nightly-report/invoke`, {}),
    ).resolves.toEqual({ job_id: 'job_1' });
    expect(received.map(({ url }) => url)).toEqual([
      `/internal/projects/${TENANT}/workflows/nightly-report/invoke`,
    ]);
  });
});
