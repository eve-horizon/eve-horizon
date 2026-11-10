import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TriggerMatcherService } from './trigger-matcher.service';
import type { Event, ProjectManifest } from '@eve/db';

/**
 * Pull request triggers start pipelines and agent workflows on the PR head
 * commit. They fire only for PRs whose head branch lives in the project's own
 * repository and whose author is an owner, member or collaborator of it.
 */

const REPO = 'acme/app';

const PR_MANIFEST = `
pipelines:
  pr-preview:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
        base_branch: main
    steps:
      - run: echo preview
  on-push:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - run: echo push
workflows:
  pr-review:
    trigger:
      github:
        event: pull_request
    steps:
      - agent:
          prompt: Review the change
`;

function manifest(yaml: string): ProjectManifest {
  return {
    id: 'manifest_123',
    project_id: 'proj_123',
    manifest_yaml: yaml,
    manifest_hash: 'hash123',
    git_sha: 'abc123',
    branch: 'main',
    parsed_defaults: null,
    parsed_agents: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

type PrPayload = Record<string, any>;

function prPayload(): PrPayload {
  return {
    action: 'opened',
    number: 7,
    pull_request: {
      number: 7,
      html_url: `https://github.com/${REPO}/pull/7`,
      author_association: 'MEMBER',
      head: {
        ref: 'feature/change',
        sha: 'headsha123',
        repo: { full_name: REPO, fork: false },
      },
      base: {
        ref: 'main',
        sha: 'basesha123',
        repo: { full_name: REPO, fork: false },
      },
    },
    repository: { full_name: REPO, fork: false },
    sender: { login: 'someone' },
  };
}

function event(overrides: Partial<Event>): Event {
  return {
    id: 'evt_123',
    project_id: 'proj_123',
    type: 'github.pull_request',
    source: 'github',
    env_name: null,
    ref_sha: 'headsha123',
    ref_branch: 'feature/change',
    actor_type: 'user',
    actor_id: 'someone',
    payload_json: prPayload(),
    dedupe_key: null,
    job_id: null,
    trigger_match_count: null,
    triggers_evaluated: null,
    status: 'pending',
    processed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function prEvent(mutate: (payload: PrPayload) => void = () => {}): Event {
  const payload = prPayload();
  mutate(payload);
  return event({ payload_json: payload });
}

function forkHead(payload: PrPayload): void {
  payload.pull_request.head.repo = { full_name: 'someone/app', fork: true };
}

describe('TriggerMatcherService pull request origin', () => {
  let service: TriggerMatcherService;
  let findLatestByProject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new TriggerMatcherService({} as any);
    findLatestByProject = vi.fn().mockResolvedValue(manifest(PR_MANIFEST));
    (service as any).manifests = { findLatestByProject };
    (service as any).projects = {
      findById: vi.fn().mockResolvedValue({ id: 'proj_123', branch: 'main' }),
    };
  });

  function reasonFor(
    evaluations: { name: string; matched: boolean; reason?: string }[],
    name: string,
  ): string | undefined {
    const entry = evaluations.find((e) => e.name === name);
    expect(entry).toBeDefined();
    expect(entry!.matched).toBe(false);
    return entry!.reason;
  }

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])(
    'starts the PR pipeline and workflow for a same-repository PR whose author is %s',
    async (association) => {
      const { matches } = await service.matchTriggersForEvent(
        prEvent((p) => {
          p.pull_request.author_association = association;
        }),
      );

      expect(matches.map((m) => `${m.type}:${m.name}`).sort()).toEqual([
        'pipeline:pr-preview',
        'workflow:pr-review',
      ]);
    },
  );

  it('does not start a pipeline or workflow for a PR whose head is in a fork', async () => {
    const { matches, evaluations } = await service.matchTriggersForEvent(prEvent(forkHead));

    expect(matches).toEqual([]);
    expect(reasonFor(evaluations, 'pr-preview')).toBe('pull_request_from_fork');
    expect(reasonFor(evaluations, 'pr-review')).toBe('pull_request_from_fork');
    // Triggers that would not have matched anyway keep their own reason.
    expect(reasonFor(evaluations, 'on-push')).toBe('type_mismatch');
  });

  it('does not start anything when the head repository differs from the base repository', async () => {
    const { matches, evaluations } = await service.matchTriggersForEvent(
      prEvent((p) => {
        p.pull_request.head.repo = { full_name: 'other/app', fork: false };
      }),
    );

    expect(matches).toEqual([]);
    expect(reasonFor(evaluations, 'pr-preview')).toBe('pull_request_from_fork');
  });

  it.each(['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN'])(
    'does not start anything for a same-repository PR whose author is %s',
    async (association) => {
      const { matches, evaluations } = await service.matchTriggersForEvent(
        prEvent((p) => {
          p.pull_request.author_association = association;
        }),
      );

      expect(matches).toEqual([]);
      expect(reasonFor(evaluations, 'pr-preview')).toBe('pull_request_author_not_collaborator');
      expect(reasonFor(evaluations, 'pr-review')).toBe('pull_request_author_not_collaborator');
    },
  );

  it.each<[string, (p: PrPayload) => void]>([
    ['author_association is missing', (p) => { delete p.pull_request.author_association; }],
    ['author_association is not a string', (p) => { p.pull_request.author_association = ['MEMBER']; }],
    ['the head repository is missing', (p) => { delete p.pull_request.head.repo; }],
    ['the head repository is null (deleted fork)', (p) => { p.pull_request.head.repo = null; }],
    ['the head repository has no full name', (p) => { delete p.pull_request.head.repo.full_name; }],
    ['the head repository has no fork flag', (p) => { delete p.pull_request.head.repo.fork; }],
    ['the base repository is missing', (p) => { delete p.pull_request.base.repo; }],
    ['the base repository has no full name', (p) => { p.pull_request.base.repo.full_name = ''; }],
    ['the pull_request object is missing', (p) => { delete p.pull_request; }],
  ])('does not start anything when %s', async (_label, mutate) => {
    const { matches, evaluations } = await service.matchTriggersForEvent(prEvent(mutate));

    expect(matches).toEqual([]);
    expect(reasonFor(evaluations, 'pr-review')).toBe('pull_request_origin_unknown');
  });

  it('does not start anything when the PR event has no payload', async () => {
    const { matches, evaluations } = await service.matchTriggersForEvent(
      event({ payload_json: null }),
    );

    expect(matches).toEqual([]);
    expect(reasonFor(evaluations, 'pr-review')).toBe('pull_request_origin_unknown');
  });

  it('starts the PR pipeline for a same-repository PR when the project repository is itself a fork', async () => {
    const { matches } = await service.matchTriggersForEvent(
      prEvent((p) => {
        p.pull_request.head.repo.fork = true;
        p.pull_request.base.repo.fork = true;
      }),
    );

    expect(matches.map((m) => m.name).sort()).toEqual(['pr-preview', 'pr-review']);
  });

  it('applies to github triggers with only a branch filter', async () => {
    findLatestByProject.mockResolvedValue(
      manifest(`
pipelines:
  feature-ci:
    trigger:
      github:
        branch: feature/*
    steps:
      - run: echo ci
`),
    );

    const fork = await service.matchTriggersForEvent(prEvent(forkHead));
    expect(fork.matches).toEqual([]);
    expect(reasonFor(fork.evaluations, 'feature-ci')).toBe('pull_request_from_fork');

    const own = await service.matchTriggersForEvent(prEvent());
    expect(own.matches.map((m) => m.name)).toEqual(['feature-ci']);
  });

  it('applies to generic event triggers on github pull_request events', async () => {
    findLatestByProject.mockResolvedValue(
      manifest(`
workflows:
  any-pr:
    trigger:
      event:
        source: github
        type: github.pull_request
    steps:
      - agent:
          prompt: Look at the change
`),
    );

    const fork = await service.matchTriggersForEvent(prEvent(forkHead));
    expect(fork.matches).toEqual([]);
    expect(reasonFor(fork.evaluations, 'any-pr')).toBe('pull_request_from_fork');

    const own = await service.matchTriggersForEvent(prEvent());
    expect(own.matches.map((m) => m.name)).toEqual(['any-pr']);
  });

  it('applies to pull request events delivered through an app link', async () => {
    findLatestByProject.mockResolvedValue(
      manifest(`
workflows:
  upstream-pr:
    trigger:
      app_link:
        alias: upstream
        type: github.pull_request
    steps:
      - agent:
          prompt: Look at the upstream change
`),
    );

    const linked = (original: PrPayload): Event =>
      event({
        source: 'app_link',
        payload_json: {
          producer_event_id: 'evt_producer',
          producer_project_id: 'proj_producer',
          link_alias: 'upstream',
          original,
        },
      });

    const forkPayload = prPayload();
    forkHead(forkPayload);
    const fork = await service.matchTriggersForEvent(linked(forkPayload));
    expect(fork.matches).toEqual([]);
    expect(reasonFor(fork.evaluations, 'upstream-pr')).toBe('pull_request_from_fork');

    const own = await service.matchTriggersForEvent(linked(prPayload()));
    expect(own.matches.map((m) => m.name)).toEqual(['upstream-pr']);
  });

  it('leaves push triggers unchanged', async () => {
    const { matches } = await service.matchTriggersForEvent(
      event({
        type: 'github.push',
        ref_branch: 'main',
        payload_json: { ref: 'refs/heads/main', after: 'pushsha123' },
      }),
    );

    expect(matches.map((m) => `${m.type}:${m.name}`)).toEqual(['pipeline:on-push']);
  });
});
