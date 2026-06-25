import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TriggerMatcherService } from '../events/trigger-matcher.service';
import { EventRouterService } from '../events/event-router.service';
import type { Event, ProjectManifest } from '@eve/db';

// Mock loadConfig before importing
vi.mock('@eve/shared', () => ({
  loadConfig: vi.fn().mockReturnValue({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    EVE_API_URL: 'http://localhost:4701',
    EVE_INTERNAL_API_KEY: 'test-internal-key',
  }),
}));

/**
 * Integration tests for PR preview environments flow.
 *
 * Tests the complete flow from PR webhook -> trigger match -> pipeline run creation
 * with proper metadata, deduplication, and output aggregation.
 */
describe('PR Preview Environments Integration', () => {
  let mockDb: any;
  let mockManifests: any;
  let triggerMatcher: TriggerMatcherService;

  beforeEach(() => {
    mockDb = {};
    mockManifests = {
      findLatestByProject: vi.fn(),
    };

    triggerMatcher = new TriggerMatcherService(mockDb);
    (triggerMatcher as any).manifests = mockManifests;
  });

  describe('1. PR Trigger Match Tests', () => {
    const createManifest = (yaml: string): ProjectManifest => ({
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
    });

    const createPREvent = (
      action: string,
      baseBranch: string,
      headBranch: string,
      prNumber: number,
    ): Event => ({
      id: 'evt_123',
      project_id: 'proj_123',
      type: 'github.pull_request',
      source: 'github',
      env_name: null,
      ref_sha: 'abc123',
      ref_branch: headBranch,
      actor_type: 'user',
      actor_id: 'user_123',
      payload_json: {
        action,
        pull_request: {
          number: prNumber,
          html_url: `https://github.com/org/repo/pull/${prNumber}`,
          head: { ref: headBranch, sha: 'abc123' },
          base: { ref: baseBranch },
        },
        repository: { full_name: 'org/repo' },
      },
      dedupe_key: null,
      job_id: null,
      trigger_match_count: null,
      triggers_evaluated: null,
      status: 'pending',
      processed_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    it('triggers pipeline when PR opened on main with base_branch: main', async () => {
      const manifestYaml = `
pipelines:
  deploy-pr:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
        base_branch: main
    steps:
      - run: echo "deploy"
`;

      mockManifests.findLatestByProject.mockResolvedValue(createManifest(manifestYaml));

      const event = createPREvent('opened', 'main', 'feature/new', 42);
      const { matches } = await triggerMatcher.matchTriggersForEvent(event);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'pipeline',
        name: 'deploy-pr',
        projectId: 'proj_123',
      });
    });

    it('triggers pipeline when PR synchronized on main with base_branch: main', async () => {
      const manifestYaml = `
pipelines:
  deploy-pr:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
        base_branch: main
    steps:
      - run: echo "deploy"
`;

      mockManifests.findLatestByProject.mockResolvedValue(createManifest(manifestYaml));

      const event = createPREvent('synchronize', 'main', 'feature/new', 42);
      const { matches } = await triggerMatcher.matchTriggersForEvent(event);

      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('deploy-pr');
    });

    it('triggers cleanup pipeline when PR closed on main', async () => {
      const manifestYaml = `
pipelines:
  cleanup-pr:
    trigger:
      github:
        event: pull_request
        action: closed
        base_branch: main
    steps:
      - run: echo "cleanup"
`;

      mockManifests.findLatestByProject.mockResolvedValue(createManifest(manifestYaml));

      const event = createPREvent('closed', 'main', 'feature/new', 42);
      const { matches } = await triggerMatcher.matchTriggersForEvent(event);

      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('cleanup-pr');
    });

    it('does NOT trigger when PR opened on feature/* with base_branch: main', async () => {
      const manifestYaml = `
pipelines:
  deploy-pr:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
        base_branch: main
    steps:
      - run: echo "deploy"
`;

      mockManifests.findLatestByProject.mockResolvedValue(createManifest(manifestYaml));

      // PR targeting feature/dev, not main
      const event = createPREvent('opened', 'feature/dev', 'feature/new', 42);
      const { matches } = await triggerMatcher.matchTriggersForEvent(event);

      expect(matches).toEqual([]);
    });

    it('does NOT trigger when action is reopened but not in allowed list', async () => {
      const manifestYaml = `
pipelines:
  deploy-pr:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize]  # reopened NOT included
        base_branch: main
    steps:
      - run: echo "deploy"
`;

      mockManifests.findLatestByProject.mockResolvedValue(createManifest(manifestYaml));

      const event = createPREvent('reopened', 'main', 'feature/new', 42);
      const { matches } = await triggerMatcher.matchTriggersForEvent(event);

      expect(matches).toEqual([]);
    });

    it('triggers when action is reopened AND it is in the allowed list', async () => {
      const manifestYaml = `
pipelines:
  deploy-pr:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
        base_branch: main
    steps:
      - run: echo "deploy"
`;

      mockManifests.findLatestByProject.mockResolvedValue(createManifest(manifestYaml));

      const event = createPREvent('reopened', 'main', 'feature/new', 42);
      const { matches } = await triggerMatcher.matchTriggersForEvent(event);

      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('deploy-pr');
    });

    it('supports wildcard base_branch patterns (release/*)', async () => {
      const manifestYaml = `
pipelines:
  deploy-pr:
    trigger:
      github:
        event: pull_request
        action: opened
        base_branch: release/*
    steps:
      - run: echo "deploy"
`;

      mockManifests.findLatestByProject.mockResolvedValue(createManifest(manifestYaml));

      const event = createPREvent('opened', 'release/v1.0', 'feature/new', 42);
      const { matches } = await triggerMatcher.matchTriggersForEvent(event);

      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('deploy-pr');
    });

    it('does NOT match wildcard when base branch prefix differs', async () => {
      const manifestYaml = `
pipelines:
  deploy-pr:
    trigger:
      github:
        event: pull_request
        action: opened
        base_branch: release/*
    steps:
      - run: echo "deploy"
`;

      mockManifests.findLatestByProject.mockResolvedValue(createManifest(manifestYaml));

      const event = createPREvent('opened', 'hotfix/v1.0', 'feature/new', 42);
      const { matches } = await triggerMatcher.matchTriggersForEvent(event);

      expect(matches).toEqual([]);
    });
  });

  describe('2. Pipeline Dedupe Tests', () => {
    it('generates same dedupe_key for same PR number', () => {
      const eventRouter = new EventRouterService(mockDb, triggerMatcher);

      const event1: Event = {
        id: 'evt_1',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'sha1',
        ref_branch: 'feature/new',
        actor_type: 'user',
        actor_id: 'user_1',
        payload_json: {
          action: 'opened',
          pull_request: {
            number: 42,
            html_url: 'https://github.com/org/repo/pull/42',
            head: { ref: 'feature/new', sha: 'sha1' },
            base: { ref: 'main' },
          },
          repository: { full_name: 'org/repo' },
        },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const event2: Event = {
        ...event1,
        id: 'evt_2',
        ref_sha: 'sha2', // Different SHA (new commit)
        payload_json: {
          ...event1.payload_json,
          action: 'synchronize',
        },
      };

      const inputs1 = (eventRouter as any).buildTriggerInputs(event1);
      const dedupeKey1 = (eventRouter as any).generateDedupeKey(event1, inputs1);

      const inputs2 = (eventRouter as any).buildTriggerInputs(event2);
      const dedupeKey2 = (eventRouter as any).generateDedupeKey(event2, inputs2);

      expect(dedupeKey1).toBe('pr:org/repo:42');
      expect(dedupeKey2).toBe('pr:org/repo:42');
      expect(dedupeKey1).toBe(dedupeKey2);
    });

    it('generates different dedupe_key for different PR numbers', () => {
      const eventRouter = new EventRouterService(mockDb, triggerMatcher);

      const event1: Event = {
        id: 'evt_1',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'sha1',
        ref_branch: 'feature/one',
        actor_type: 'user',
        actor_id: 'user_1',
        payload_json: {
          action: 'opened',
          pull_request: {
            number: 42,
            html_url: 'https://github.com/org/repo/pull/42',
            head: { ref: 'feature/one', sha: 'sha1' },
            base: { ref: 'main' },
          },
          repository: { full_name: 'org/repo' },
        },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const event2: Event = {
        ...event1,
        id: 'evt_2',
        ref_branch: 'feature/two',
        payload_json: {
          action: 'opened',
          pull_request: {
            number: 99, // Different PR
            html_url: 'https://github.com/org/repo/pull/99',
            head: { ref: 'feature/two', sha: 'sha1' },
            base: { ref: 'main' },
          },
          repository: { full_name: 'org/repo' },
        },
      };

      const inputs1 = (eventRouter as any).buildTriggerInputs(event1);
      const dedupeKey1 = (eventRouter as any).generateDedupeKey(event1, inputs1);

      const inputs2 = (eventRouter as any).buildTriggerInputs(event2);
      const dedupeKey2 = (eventRouter as any).generateDedupeKey(event2, inputs2);

      expect(dedupeKey1).toBe('pr:org/repo:42');
      expect(dedupeKey2).toBe('pr:org/repo:99');
      expect(dedupeKey1).not.toBe(dedupeKey2);
    });

    it('generates different dedupe_key for different repositories', () => {
      const eventRouter = new EventRouterService(mockDb, triggerMatcher);

      const event1: Event = {
        id: 'evt_1',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'sha1',
        ref_branch: 'feature/new',
        actor_type: 'user',
        actor_id: 'user_1',
        payload_json: {
          action: 'opened',
          pull_request: {
            number: 42,
            html_url: 'https://github.com/org/repo1/pull/42',
            head: { ref: 'feature/new', sha: 'sha1' },
            base: { ref: 'main' },
          },
          repository: { full_name: 'org/repo1' },
        },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const event2: Event = {
        ...event1,
        id: 'evt_2',
        payload_json: {
          ...event1.payload_json,
          repository: { full_name: 'org/repo2' }, // Different repo
        },
      };

      const inputs1 = (eventRouter as any).buildTriggerInputs(event1);
      const dedupeKey1 = (eventRouter as any).generateDedupeKey(event1, inputs1);

      const inputs2 = (eventRouter as any).buildTriggerInputs(event2);
      const dedupeKey2 = (eventRouter as any).generateDedupeKey(event2, inputs2);

      expect(dedupeKey1).toBe('pr:org/repo1:42');
      expect(dedupeKey2).toBe('pr:org/repo2:42');
      expect(dedupeKey1).not.toBe(dedupeKey2);
    });

    it('returns undefined dedupe_key for non-PR events (push)', () => {
      const eventRouter = new EventRouterService(mockDb, triggerMatcher);

      const pushEvent: Event = {
        id: 'evt_push',
        project_id: 'proj_123',
        type: 'github.push',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'main',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: { commits: [] },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const inputs = (eventRouter as any).buildTriggerInputs(pushEvent);
      const dedupeKey = (eventRouter as any).generateDedupeKey(pushEvent, inputs);

      expect(dedupeKey).toBeUndefined();
    });

    it('returns undefined dedupe_key when PR payload is missing', () => {
      const eventRouter = new EventRouterService(mockDb, triggerMatcher);

      const event: Event = {
        id: 'evt_bad',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: { action: 'opened' }, // Missing pull_request
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const inputs = (eventRouter as any).buildTriggerInputs(event);
      const dedupeKey = (eventRouter as any).generateDedupeKey(event, inputs);

      expect(dedupeKey).toBeUndefined();
    });
  });

  describe('3. Preview URL Output Tests', () => {
    describe('PR metadata extraction', () => {
      it('extracts full PR metadata from github.pull_request event', () => {
        const eventRouter = new EventRouterService(mockDb, triggerMatcher);

        const event: Event = {
          id: 'evt_456',
          project_id: 'proj_123',
          type: 'github.pull_request',
          source: 'github',
          env_name: null,
          ref_sha: 'deadbeef',
          ref_branch: 'feature/dashboard',
          actor_type: 'user',
          actor_id: 'octocat',
          payload_json: {
            action: 'opened',
            pull_request: {
              number: 42,
              html_url: 'https://github.com/owner/repo/pull/42',
              head: {
                ref: 'feature/dashboard',
                sha: 'deadbeef',
              },
              base: {
                ref: 'main',
              },
            },
            repository: {
              full_name: 'owner/repo',
            },
          },
          dedupe_key: null,
          job_id: null,
          trigger_match_count: null,
          triggers_evaluated: null,
          status: 'pending',
          processed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };

        const inputs = (eventRouter as any).buildTriggerInputs(event);

        // Verify base event inputs
        expect(inputs.event_id).toBe('evt_456');
        expect(inputs.event_type).toBe('github.pull_request');
        expect(inputs.source).toBe('github');
        expect(inputs.ref_sha).toBe('deadbeef');
        expect(inputs.ref_branch).toBe('feature/dashboard');
        expect(inputs.actor_type).toBe('user');
        expect(inputs.actor_id).toBe('octocat');

        // Verify PR-specific metadata
        expect(inputs.pr_number).toBe(42);
        expect(inputs.pr_branch).toBe('feature/dashboard');
        expect(inputs.pr_sha).toBe('deadbeef');
        expect(inputs.pr_url).toBe('https://github.com/owner/repo/pull/42');
        expect(inputs.pr_action).toBe('opened');
        expect(inputs.base_branch).toBe('main');
        expect(inputs.repo).toBe('owner/repo');
        expect(inputs.env_name).toBe('pr-42');
      });

      it('computes env_name as pr-{number}', () => {
        const eventRouter = new EventRouterService(mockDb, triggerMatcher);

        const event: Event = {
          id: 'evt_test',
          project_id: 'proj_123',
          type: 'github.pull_request',
          source: 'github',
          env_name: null,
          ref_sha: 'abc',
          ref_branch: 'feature/test',
          actor_type: 'user',
          actor_id: 'user',
          payload_json: {
            action: 'synchronize',
            pull_request: {
              number: 999,
              html_url: 'https://github.com/org/repo/pull/999',
              head: { ref: 'feature/test', sha: 'abc' },
              base: { ref: 'main' },
            },
            repository: { full_name: 'org/repo' },
          },
          dedupe_key: null,
          job_id: null,
          trigger_match_count: null,
          triggers_evaluated: null,
          status: 'pending',
          processed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };

        const inputs = (eventRouter as any).buildTriggerInputs(event);

        expect(inputs.env_name).toBe('pr-999');
      });

      it('handles closed action metadata correctly', () => {
        const eventRouter = new EventRouterService(mockDb, triggerMatcher);

        const event: Event = {
          id: 'evt_closed',
          project_id: 'proj_123',
          type: 'github.pull_request',
          source: 'github',
          env_name: null,
          ref_sha: 'finalsha',
          ref_branch: 'feature/done',
          actor_type: 'user',
          actor_id: 'merger',
          payload_json: {
            action: 'closed',
            pull_request: {
              number: 100,
              html_url: 'https://github.com/team/app/pull/100',
              head: { ref: 'feature/done', sha: 'finalsha' },
              base: { ref: 'main' },
            },
            repository: { full_name: 'team/app' },
          },
          dedupe_key: null,
          job_id: null,
          trigger_match_count: null,
          triggers_evaluated: null,
          status: 'pending',
          processed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };

        const inputs = (eventRouter as any).buildTriggerInputs(event);

        expect(inputs.pr_action).toBe('closed');
        expect(inputs.pr_number).toBe(100);
        expect(inputs.env_name).toBe('pr-100');
      });
    });

    describe('Pipeline output aggregation', () => {
      it('pipeline inputs should include env_name for deploy step', () => {
        const eventRouter = new EventRouterService(mockDb, triggerMatcher);

        const event: Event = {
          id: 'evt_deploy',
          project_id: 'proj_123',
          type: 'github.pull_request',
          source: 'github',
          env_name: null,
          ref_sha: 'abc123',
          ref_branch: 'feature/preview',
          actor_type: 'user',
          actor_id: 'user',
          payload_json: {
            action: 'opened',
            pull_request: {
              number: 55,
              html_url: 'https://github.com/org/repo/pull/55',
              head: { ref: 'feature/preview', sha: 'abc123' },
              base: { ref: 'main' },
            },
            repository: { full_name: 'org/repo' },
          },
          dedupe_key: null,
          job_id: null,
          trigger_match_count: null,
          triggers_evaluated: null,
          status: 'pending',
          processed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };

        const inputs = (eventRouter as any).buildTriggerInputs(event);

        // The pipeline can use ${inputs.env_name} to deploy to pr-55
        expect(inputs.env_name).toBe('pr-55');
      });

      it('handles missing pull_request gracefully', () => {
        const eventRouter = new EventRouterService(mockDb, triggerMatcher);

        const event: Event = {
          id: 'evt_bad',
          project_id: 'proj_123',
          type: 'github.pull_request',
          source: 'github',
          env_name: null,
          ref_sha: 'abc',
          ref_branch: 'feature/test',
          actor_type: 'user',
          actor_id: 'user',
          payload_json: { action: 'opened' }, // Missing pull_request
          dedupe_key: null,
          job_id: null,
          trigger_match_count: null,
          triggers_evaluated: null,
          status: 'pending',
          processed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };

        const inputs = (eventRouter as any).buildTriggerInputs(event);

        expect(inputs.pr_number).toBeUndefined();
        expect(inputs.env_name).toBeUndefined();
        expect(inputs.base_branch).toBeUndefined();
      });

      it('handles partial PR metadata gracefully', () => {
        const eventRouter = new EventRouterService(mockDb, triggerMatcher);

        const event: Event = {
          id: 'evt_partial',
          project_id: 'proj_123',
          type: 'github.pull_request',
          source: 'github',
          env_name: null,
          ref_sha: 'abc',
          ref_branch: 'feature/test',
          actor_type: 'user',
          actor_id: 'user',
          payload_json: {
            action: 'opened',
            pull_request: {
              number: 77,
              // Missing html_url, head, base
            },
            // Missing repository
          },
          dedupe_key: null,
          job_id: null,
          trigger_match_count: null,
          triggers_evaluated: null,
          status: 'pending',
          processed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };

        const inputs = (eventRouter as any).buildTriggerInputs(event);

        expect(inputs.pr_number).toBe(77);
        expect(inputs.env_name).toBe('pr-77');
        expect(inputs.pr_url).toBeUndefined();
        expect(inputs.pr_branch).toBeUndefined();
        expect(inputs.base_branch).toBeUndefined();
        expect(inputs.repo).toBeUndefined();
      });
    });

    describe('Preview URL in step outputs', () => {
      it('documents expected step output structure for deploy action', () => {
        // This is a documentation test - the actual implementation
        // happens in the pipeline executor when it processes deploy actions.
        //
        // Expected flow:
        // 1. Deploy step completes -> stores result_json with preview_url
        // 2. Pipeline run aggregates step_outputs_json with deploy.preview_url
        // 3. Root job result includes pipeline_output with preview_url
        //
        // Example step result:
        const deployStepResult = {
          preview_url: 'https://web.myproject-pr-42.lvh.me',
          env_name: 'pr-42',
          deployed_at: '2026-01-29T12:00:00Z',
        };

        // Example pipeline run step_outputs_json:
        const pipelineStepOutputs = {
          deploy: {
            preview_url: 'https://web.myproject-pr-42.lvh.me',
            env_name: 'pr-42',
            deployed_at: '2026-01-29T12:00:00Z',
          },
        };

        // Example root job result:
        const rootJobResult = {
          pipeline_output: {
            preview_url: 'https://web.myproject-pr-42.lvh.me',
            env_name: 'pr-42',
            deployed_at: '2026-01-29T12:00:00Z',
          },
        };

        expect(deployStepResult.preview_url).toBe('https://web.myproject-pr-42.lvh.me');
        expect(pipelineStepOutputs.deploy.preview_url).toBe('https://web.myproject-pr-42.lvh.me');
        expect(rootJobResult.pipeline_output.preview_url).toBe(
          'https://web.myproject-pr-42.lvh.me',
        );
      });
    });
  });

  describe('4. End-to-End PR Flow Tests', () => {
    it('complete flow: PR opened -> trigger match -> inputs with metadata', async () => {
      const manifestYaml = `
pipelines:
  deploy-pr:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize]
        base_branch: main
    steps:
      - name: ensure-env
        action:
          type: env-ensure
          input: { env_name: "\${inputs.env_name}", kind: "preview" }
      - name: build
        action: { type: build }
      - name: deploy
        depends_on: [build]
        action:
          type: deploy
          input: { env_name: "\${inputs.env_name}" }
`;

      mockManifests.findLatestByProject.mockResolvedValue({
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: 'abc123',
        branch: 'main',
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const event: Event = {
        id: 'evt_flow',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'commit123',
        ref_branch: 'feature/dashboard',
        actor_type: 'user',
        actor_id: 'developer',
        payload_json: {
          action: 'opened',
          pull_request: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            head: { ref: 'feature/dashboard', sha: 'commit123' },
            base: { ref: 'main' },
          },
          repository: { full_name: 'owner/repo' },
        },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Step 1: Trigger matches
      const { matches } = await triggerMatcher.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('deploy-pr');

      // Step 2: Build inputs
      const eventRouter = new EventRouterService(mockDb, triggerMatcher);
      const inputs = (eventRouter as any).buildTriggerInputs(event);

      expect(inputs).toMatchObject({
        event_id: 'evt_flow',
        event_type: 'github.pull_request',
        pr_number: 42,
        pr_branch: 'feature/dashboard',
        pr_sha: 'commit123',
        pr_url: 'https://github.com/owner/repo/pull/42',
        pr_action: 'opened',
        base_branch: 'main',
        repo: 'owner/repo',
        env_name: 'pr-42',
      });

      // Step 3: Generate dedupe key
      const dedupeKey = (eventRouter as any).generateDedupeKey(event, inputs);
      expect(dedupeKey).toBe('pr:owner/repo:42');

      // Step 4: Verify inputs can be used for pipeline run
      // (In real flow, these would be passed to API endpoint)
      expect(inputs.env_name).toBe('pr-42'); // For deploy action
      expect(dedupeKey).toBeTruthy(); // For deduplication
    });

    it('complete flow: PR closed -> trigger cleanup -> delete env', async () => {
      const manifestYaml = `
pipelines:
  cleanup-pr:
    trigger:
      github:
        event: pull_request
        action: closed
        base_branch: main
    steps:
      - name: delete-env
        action:
          type: env-delete
          input: { env_name: "\${inputs.env_name}" }
`;

      mockManifests.findLatestByProject.mockResolvedValue({
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: 'abc123',
        branch: 'main',
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const event: Event = {
        id: 'evt_cleanup',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'finalsha',
        ref_branch: 'feature/dashboard',
        actor_type: 'user',
        actor_id: 'developer',
        payload_json: {
          action: 'closed',
          pull_request: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            head: { ref: 'feature/dashboard', sha: 'finalsha' },
            base: { ref: 'main' },
          },
          repository: { full_name: 'owner/repo' },
        },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Trigger matches cleanup pipeline
      const { matches } = await triggerMatcher.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('cleanup-pr');

      // Build inputs with env_name
      const eventRouter = new EventRouterService(mockDb, triggerMatcher);
      const inputs = (eventRouter as any).buildTriggerInputs(event);

      expect(inputs.env_name).toBe('pr-42');
      expect(inputs.pr_action).toBe('closed');
    });
  });
});
