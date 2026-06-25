import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Event } from '@eve/db';

// Mock loadConfig before importing the service
vi.mock('@eve/shared', () => ({
  loadConfig: vi.fn().mockReturnValue({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    EVE_API_URL: 'http://localhost:4701',
    EVE_INTERNAL_API_KEY: 'test-internal-key',
  }),
}));

// Import after mocking
import { EventRouterService } from './event-router.service';

describe('EventRouterService', () => {
  let service: EventRouterService;
  let mockDb: any;
  let mockTriggerMatcher: any;

  beforeEach(() => {
    mockDb = {};
    mockTriggerMatcher = {
      matchTriggersForEvent: vi.fn().mockResolvedValue({ matches: [], evaluations: [] }),
    };

    service = new EventRouterService(mockDb, mockTriggerMatcher);
  });

  describe('buildTriggerInputs (via extractPullRequestMetadata)', () => {
    // Access the private method through the service for testing
    const buildTriggerInputs = (event: Event) => {
      return (service as any).buildTriggerInputs(event);
    };

    it('returns base inputs for non-PR events', () => {
      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.push',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'main',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: { some: 'data' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const inputs = buildTriggerInputs(event);

      expect(inputs).toEqual({
        event_id: 'evt_123',
        event_type: 'github.push',
        source: 'github',
        ref_sha: 'abc123',
        ref_branch: 'main',
        actor_type: 'user',
        actor_id: 'user_123',
        payload: { some: 'data' },
      });
    });

    it('extracts full PR metadata for github.pull_request events', () => {
      const event: Event = {
        id: 'evt_456',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'deadbeef123',
        ref_branch: 'feature/awesome',
        actor_type: 'user',
        actor_id: 'octocat',
        payload_json: {
          action: 'opened',
          pull_request: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            head: {
              ref: 'feature/awesome',
              sha: 'deadbeef123',
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

      const inputs = buildTriggerInputs(event);

      // Verify base inputs are present
      expect(inputs.event_id).toBe('evt_456');
      expect(inputs.event_type).toBe('github.pull_request');
      expect(inputs.source).toBe('github');
      expect(inputs.ref_sha).toBe('deadbeef123');
      expect(inputs.ref_branch).toBe('feature/awesome');
      expect(inputs.actor_type).toBe('user');
      expect(inputs.actor_id).toBe('octocat');

      // Verify PR-specific metadata
      expect(inputs.pr_number).toBe(42);
      expect(inputs.pr_branch).toBe('feature/awesome');
      expect(inputs.pr_sha).toBe('deadbeef123');
      expect(inputs.pr_url).toBe('https://github.com/owner/repo/pull/42');
      expect(inputs.pr_action).toBe('opened');
      expect(inputs.base_branch).toBe('main');
      expect(inputs.repo).toBe('owner/repo');
      expect(inputs.env_name).toBe('pr-42');
    });

    it('extracts PR metadata for synchronize action', () => {
      const event: Event = {
        id: 'evt_789',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'newsha456',
        ref_branch: 'feature/update',
        actor_type: 'user',
        actor_id: 'contributor',
        payload_json: {
          action: 'synchronize',
          pull_request: {
            number: 99,
            html_url: 'https://github.com/org/project/pull/99',
            head: {
              ref: 'feature/update',
              sha: 'newsha456',
            },
            base: {
              ref: 'develop',
            },
          },
          repository: {
            full_name: 'org/project',
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

      const inputs = buildTriggerInputs(event);

      expect(inputs.pr_number).toBe(99);
      expect(inputs.pr_action).toBe('synchronize');
      expect(inputs.base_branch).toBe('develop');
      expect(inputs.env_name).toBe('pr-99');
    });

    it('extracts PR metadata for closed action', () => {
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
            head: {
              ref: 'feature/done',
              sha: 'finalsha',
            },
            base: {
              ref: 'main',
            },
          },
          repository: {
            full_name: 'team/app',
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

      const inputs = buildTriggerInputs(event);

      expect(inputs.pr_action).toBe('closed');
      expect(inputs.env_name).toBe('pr-100');
    });

    it('handles missing pull_request in payload gracefully', () => {
      const event: Event = {
        id: 'evt_bad',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'somesha',
        ref_branch: 'some-branch',
        actor_type: 'user',
        actor_id: 'user',
        payload_json: {
          action: 'opened',
          // Missing pull_request object
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

      const inputs = buildTriggerInputs(event);

      // Should still have base inputs
      expect(inputs.event_id).toBe('evt_bad');
      expect(inputs.event_type).toBe('github.pull_request');

      // PR metadata should be undefined when pull_request is missing
      expect(inputs.pr_number).toBeUndefined();
      expect(inputs.env_name).toBeUndefined();
    });

    it('handles null payload_json gracefully', () => {
      const event: Event = {
        id: 'evt_null',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'somesha',
        ref_branch: 'some-branch',
        actor_type: 'user',
        actor_id: 'user',
        payload_json: null,
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const inputs = buildTriggerInputs(event);

      // Should only have base inputs, no PR metadata
      expect(inputs.event_id).toBe('evt_null');
      expect(inputs.payload).toBeNull();
      expect(inputs.pr_number).toBeUndefined();
    });

    it('handles partial PR metadata', () => {
      const event: Event = {
        id: 'evt_partial',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'partialsha',
        ref_branch: 'partial-branch',
        actor_type: 'user',
        actor_id: 'user',
        payload_json: {
          action: 'reopened',
          pull_request: {
            number: 55,
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

      const inputs = buildTriggerInputs(event);

      expect(inputs.pr_number).toBe(55);
      expect(inputs.pr_action).toBe('reopened');
      expect(inputs.env_name).toBe('pr-55');
      expect(inputs.pr_url).toBeUndefined();
      expect(inputs.pr_branch).toBeUndefined();
      expect(inputs.base_branch).toBeUndefined();
      expect(inputs.repo).toBeUndefined();
    });
  });
});
