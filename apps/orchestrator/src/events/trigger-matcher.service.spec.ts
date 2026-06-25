import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TriggerMatcherService } from './trigger-matcher.service';
import type { Event } from '@eve/db';
import type { ProjectManifest } from '@eve/db';

describe('TriggerMatcherService', () => {
  let service: TriggerMatcherService;
  let mockDb: any;
  let mockManifests: {
    findLatestByProject: ReturnType<typeof vi.fn>;
  };
  let mockProjects: {
    findById: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    // Create a mock database
    mockDb = {};

    // Create the service with mocked DB
    service = new TriggerMatcherService(mockDb);

    // Mock the manifests queries
    mockManifests = {
      findLatestByProject: vi.fn(),
    };

    // Mock the projects queries
    mockProjects = {
      findById: vi.fn().mockResolvedValue({ id: 'proj_123', branch: 'main' }),
    };

    // Replace the internal queries with our mocks
    (service as any).manifests = mockManifests;
    (service as any).projects = mockProjects;
  });

  describe('matchTriggersForEvent', () => {
    it('returns empty array when no manifest exists', async () => {
      // Arrange
      mockManifests.findLatestByProject.mockResolvedValue(null);

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toEqual([]);
      expect(mockManifests.findLatestByProject).toHaveBeenCalledWith('proj_123');
    });

    it('returns empty array when manifest YAML is invalid', async () => {
      // Arrange
      const manifest: ProjectManifest = {
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: 'invalid yaml: [[[',
        manifest_hash: 'hash123',
        git_sha: 'abc123',
        branch: 'main',
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toEqual([]);
    });

    it('matches GitHub push event with pipeline that has github trigger', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  deploy:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - run: echo "deploying"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'pipeline',
        name: 'deploy',
        projectId: 'proj_123',
      });
    });

    it('matches GitHub push event with workflow that has github trigger', async () => {
      // Arrange
      const manifestYaml = `
workflows:
  build-and-deploy:
    trigger:
      github:
        event: push
        branch: main
    jobs:
      - job: build
        steps:
          - run: npm run build
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'workflow',
        name: 'build-and-deploy',
        projectId: 'proj_123',
      });
    });

    it('matches exact branch match (main matches main)', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  deploy:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - run: echo "deploying"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toHaveLength(1);
    });

    it('does not match when branch does not match exactly', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  deploy:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - run: echo "deploying"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.push',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'develop',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toEqual([]);
    });

    it('matches branch wildcard suffix (feature/* matches feature/foo)', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  test:
    trigger:
      github:
        event: push
        branch: feature/*
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: 'abc123',
        branch: 'feature/foo',
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.push',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/foo',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('test');
    });

    it('matches branch wildcard suffix with nested path (feature/* matches feature/foo/bar)', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  test:
    trigger:
      github:
        event: push
        branch: feature/*
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: 'abc123',
        branch: 'feature/foo/bar',
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.push',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/foo/bar',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toHaveLength(1);
    });

    it('does not match branch wildcard suffix when prefix is different', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  test:
    trigger:
      github:
        event: push
        branch: feature/*
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: 'abc123',
        branch: 'bugfix/foo',
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.push',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'bugfix/foo',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toEqual([]);
    });

    it('matches branch wildcard prefix (*-prod matches staging-prod)', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  deploy-prod:
    trigger:
      github:
        event: push
        branch: "*-prod"
    steps:
      - run: echo "deploy to prod"
`;

      const manifest: ProjectManifest = {
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: 'abc123',
        branch: 'staging-prod',
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.push',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'staging-prod',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('deploy-prod');
    });

    it('does not match branch wildcard prefix when suffix is different', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  deploy-prod:
    trigger:
      github:
        event: push
        branch: "*-prod"
    steps:
      - run: echo "deploy to prod"
`;

      const manifest: ProjectManifest = {
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: 'abc123',
        branch: 'staging-dev',
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.push',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'staging-dev',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toEqual([]);
    });

    it('does not match manual triggers with events', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  manual-deploy:
    trigger:
      manual: true
    steps:
      - run: echo "manual deployment"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toEqual([]);
    });

    it('does not match when event source is different from trigger source (cron event vs github trigger)', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  deploy:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - run: echo "deploying"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'cron.scheduled',
        source: 'cron',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toEqual([]);
    });

    it('matches multiple pipelines and workflows for the same event', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  test:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - run: npm test
  deploy:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - run: npm run deploy

workflows:
  ci-cd:
    trigger:
      github:
        event: push
        branch: main
    jobs:
      - job: build
        steps:
          - run: npm run build
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toHaveLength(3);
      expect(matches).toContainEqual({
        type: 'pipeline',
        name: 'test',
        projectId: 'proj_123',
      });
      expect(matches).toContainEqual({
        type: 'pipeline',
        name: 'deploy',
        projectId: 'proj_123',
      });
      expect(matches).toContainEqual({
        type: 'workflow',
        name: 'ci-cd',
        projectId: 'proj_123',
      });
    });

    it('matches github trigger without branch filter for any branch', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  test:
    trigger:
      github:
        event: push
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: 'abc123',
        branch: 'feature/xyz',
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.push',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/xyz',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('test');
    });

    it('does not match when event type is different from trigger event', async () => {
      // Arrange
      const manifestYaml = `
pipelines:
  deploy:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - run: echo "deploying"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'main',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Act
      const { matches } = await service.matchTriggersForEvent(event);

      // Assert
      expect(matches).toEqual([]);
    });

    it('matches Slack event with pipeline trigger', async () => {
      const manifestYaml = `
pipelines:
  notify:
    trigger:
      slack:
        event: message
        channel: C123
    steps:
      - run: echo "notify"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'slack.message',
        source: 'slack',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'user',
        actor_id: 'U123',
        payload_json: { event: { channel: 'C123' } },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'pipeline',
        name: 'notify',
        projectId: 'proj_123',
      });
    });

    it('does not match Slack event when channel differs', async () => {
      const manifestYaml = `
pipelines:
  notify:
    trigger:
      slack:
        event: message
        channel: C999
    steps:
      - run: echo "notify"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'slack.message',
        source: 'slack',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'user',
        actor_id: 'U123',
        payload_json: { event: { channel: 'C123' } },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    // Pull Request action filtering tests
    it('matches PR event when action is in the allowed actions array', async () => {
      const manifestYaml = `
pipelines:
  pr-ci:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new-feature',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: { action: 'opened' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('pr-ci');
    });

    it('matches PR event when action is a single string match', async () => {
      const manifestYaml = `
pipelines:
  pr-closed:
    trigger:
      github:
        event: pull_request
        action: closed
    steps:
      - run: echo "PR closed"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new-feature',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: { action: 'closed' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('pr-closed');
    });

    it('does not match PR event when action is not in allowed actions', async () => {
      const manifestYaml = `
pipelines:
  pr-ci:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new-feature',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: { action: 'closed' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('does not match PR event with action filter when payload has no action', async () => {
      const manifestYaml = `
pipelines:
  pr-ci:
    trigger:
      github:
        event: pull_request
        action: opened
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new-feature',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    // Pull Request base_branch filtering tests
    it('matches PR event when base_branch matches', async () => {
      const manifestYaml = `
pipelines:
  pr-to-main:
    trigger:
      github:
        event: pull_request
        base_branch: main
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new-feature',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {
          action: 'opened',
          pull_request: {
            base: { ref: 'main' },
            head: { ref: 'feature/new-feature' },
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

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('pr-to-main');
    });

    it('does not match PR event when base_branch does not match', async () => {
      const manifestYaml = `
pipelines:
  pr-to-main:
    trigger:
      github:
        event: pull_request
        base_branch: main
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new-feature',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {
          action: 'opened',
          pull_request: {
            base: { ref: 'develop' },
            head: { ref: 'feature/new-feature' },
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

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('matches PR event with base_branch wildcard pattern', async () => {
      const manifestYaml = `
pipelines:
  pr-to-release:
    trigger:
      github:
        event: pull_request
        base_branch: release/*
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new-feature',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {
          action: 'opened',
          pull_request: {
            base: { ref: 'release/v1.0' },
            head: { ref: 'feature/new-feature' },
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

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('pr-to-release');
    });

    it('does not match PR event with base_branch filter when payload has no base branch', async () => {
      const manifestYaml = `
pipelines:
  pr-to-main:
    trigger:
      github:
        event: pull_request
        base_branch: main
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new-feature',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: { action: 'opened' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    // Combined action and base_branch filtering test
    it('matches PR event with both action and base_branch filters', async () => {
      const manifestYaml = `
pipelines:
  pr-ci-to-main:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
        base_branch: main
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new-feature',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {
          action: 'synchronize',
          pull_request: {
            base: { ref: 'main' },
            head: { ref: 'feature/new-feature' },
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

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('pr-ci-to-main');
    });

    it('does not match PR event when action matches but base_branch does not', async () => {
      const manifestYaml = `
pipelines:
  pr-ci-to-main:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
        base_branch: main
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new-feature',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {
          action: 'opened',
          pull_request: {
            base: { ref: 'develop' },
            head: { ref: 'feature/new-feature' },
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

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    // App event trigger tests (shorthand for source=app)
    it('matches workflow with app trigger (shorthand format)', async () => {
      const manifestYaml = `
workflows:
  evolve-questions:
    trigger:
      app:
        event: question.answered
    steps:
      - agent:
          prompt: "Evolve questions"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'question.answered',
        source: 'app',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'app',
        actor_id: null,
        payload_json: { question_id: 'q_123' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'workflow',
        name: 'evolve-questions',
        projectId: 'proj_123',
      });
    });

    it('does not match app trigger when source is not app', async () => {
      const manifestYaml = `
workflows:
  evolve:
    trigger:
      app:
        event: question.answered
    steps:
      - agent:
          prompt: "Evolve"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'question.answered',
        source: 'github',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'user',
        actor_id: null,
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('does not match app trigger when event type differs', async () => {
      const manifestYaml = `
workflows:
  evolve:
    trigger:
      app:
        event: question.answered
    steps:
      - agent:
          prompt: "Evolve"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'changeset.accepted',
        source: 'app',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'app',
        actor_id: null,
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    // Generic event trigger tests
    it('matches workflow with generic event trigger (source + type)', async () => {
      const manifestYaml = `
workflows:
  process-doc:
    trigger:
      event:
        source: app
        type: document.uploaded
    steps:
      - agent:
          prompt: "Process the uploaded document"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'document.uploaded',
        source: 'app',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'app',
        actor_id: null,
        payload_json: { document_id: 'doc_123' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'workflow',
        name: 'process-doc',
        projectId: 'proj_123',
      });
    });

    it('matches generic event trigger with source only (no type filter)', async () => {
      const manifestYaml = `
workflows:
  handle-app-event:
    trigger:
      event:
        source: app
    steps:
      - agent:
          prompt: "Handle app event"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'anything.at.all',
        source: 'app',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'app',
        actor_id: null,
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
    });

    it('does not match generic event trigger when source differs', async () => {
      const manifestYaml = `
workflows:
  process-doc:
    trigger:
      event:
        source: app
        type: document.uploaded
    steps:
      - agent:
          prompt: "Process document"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'document.uploaded',
        source: 'github',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'user',
        actor_id: null,
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('does not match generic event trigger when type differs', async () => {
      const manifestYaml = `
workflows:
  process-doc:
    trigger:
      event:
        source: app
        type: document.uploaded
    steps:
      - agent:
          prompt: "Process document"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'document.processed',
        source: 'app',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'app',
        actor_id: null,
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('does not match PR event when base_branch matches but action does not', async () => {
      const manifestYaml = `
pipelines:
  pr-ci-to-main:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
        base_branch: main
    steps:
      - run: npm test
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.pull_request',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/new-feature',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {
          action: 'closed',
          pull_request: {
            base: { ref: 'main' },
            head: { ref: 'feature/new-feature' },
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

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });
  });

    // ──────────────────────────────────────────────────────────
    // System event trigger tests
    // ──────────────────────────────────────────────────────────

    it('matches system.doc.ingest event with workflow that has system trigger', async () => {
      const manifestYaml = `
workflows:
  ingest-handler:
    trigger:
      system:
        event: doc.ingest
    steps:
      - agent:
          prompt: "Process ingested documents"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'system.doc.ingest',
        source: 'system',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: { document_id: 'doc_456' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'workflow',
        name: 'ingest-handler',
        projectId: 'proj_123',
      });
    });

    it('matches system.job.failed event with workflow that has system trigger', async () => {
      const manifestYaml = `
workflows:
  failure-handler:
    trigger:
      system:
        event: job.failed
    steps:
      - agent:
          prompt: "Handle job failure"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'system.job.failed',
        source: 'system',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: { job_id: 'job_789', reason: 'timeout' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'workflow',
        name: 'failure-handler',
        projectId: 'proj_123',
      });
    });

    it('matches system.job.attempt.completed event for learning loop workflow', async () => {
      const manifestYaml = `
workflows:
  post-session-review:
    trigger:
      system:
        event: job.attempt.completed
    steps:
      - agent:
          name: session_reviewer
          prompt: "Review the completed job"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_456',
        project_id: 'proj_123',
        type: 'system.job.attempt.completed',
        source: 'system',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: 'orchestrator',
        payload_json: {
          job_id: 'job_789',
          attempt_id: 'att_001',
          assignee: 'my-agent',
          thread_id: null,
          execution_type: 'agent',
          status: 'succeeded',
          duration_ms: 45000,
        },
        dedupe_key: 'job_attempt_completed:job_789:att_001',
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'workflow',
        name: 'post-session-review',
        projectId: 'proj_123',
      });
    });

    it('matches system.pipeline.failed event with pipeline filter', async () => {
      const manifestYaml = `
pipelines:
  remediation:
    trigger:
      system:
        event: pipeline.failed
        pipeline: deploy
    steps:
      - run: echo "remediate deploy failure"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'system.pipeline.failed',
        source: 'system',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: { pipeline_name: 'deploy' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'pipeline',
        name: 'remediation',
        projectId: 'proj_123',
      });
    });

    it('does not match system trigger when event source is not system', async () => {
      const manifestYaml = `
workflows:
  ingest-handler:
    trigger:
      system:
        event: doc.ingest
    steps:
      - agent:
          prompt: "Process docs"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'system.doc.ingest',
        source: 'github',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('does not match system trigger when event type does not match', async () => {
      const manifestYaml = `
workflows:
  failure-handler:
    trigger:
      system:
        event: job.failed
    steps:
      - agent:
          prompt: "Handle failure"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'system.doc.ingest',
        source: 'system',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('anti-recursion: pipeline does not trigger itself when event pipeline_name matches trigger owner', async () => {
      const manifestYaml = `
pipelines:
  deploy:
    trigger:
      system:
        event: pipeline.failed
    steps:
      - run: echo "remediate"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      // The event's pipeline_name matches the pipeline's own name ("deploy")
      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'system.pipeline.failed',
        source: 'system',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: { pipeline_name: 'deploy' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('system trigger with no event filter matches any system event', async () => {
      const manifestYaml = `
workflows:
  catch-all-system:
    trigger:
      system: {}
    steps:
      - agent:
          prompt: "Handle system event"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'system.anything.at.all',
        source: 'system',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'workflow',
        name: 'catch-all-system',
        projectId: 'proj_123',
      });
    });

    it('does not match system.pipeline.failed when pipeline filter does not match payload', async () => {
      const manifestYaml = `
pipelines:
  remediation:
    trigger:
      system:
        event: pipeline.failed
        pipeline: deploy
    steps:
      - run: echo "remediate"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'system.pipeline.failed',
        source: 'system',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: { pipeline_name: 'build' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    // ──────────────────────────────────────────────────────────
    // Cron trigger tests
    // ──────────────────────────────────────────────────────────

    it('matches cron event with correct schedule and trigger_name', async () => {
      const manifestYaml = `
workflows:
  nightly-cleanup:
    trigger:
      cron:
        schedule: "0 0 * * *"
    steps:
      - agent:
          prompt: "Run nightly cleanup"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'cron.tick',
        source: 'cron',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: { schedule: '0 0 * * *', trigger_name: 'nightly-cleanup' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'workflow',
        name: 'nightly-cleanup',
        projectId: 'proj_123',
      });
    });

    it('does not match cron event when trigger_name does not match workflow name', async () => {
      const manifestYaml = `
workflows:
  nightly-cleanup:
    trigger:
      cron:
        schedule: "0 0 * * *"
    steps:
      - agent:
          prompt: "Run nightly cleanup"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'cron.tick',
        source: 'cron',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: { schedule: '0 0 * * *', trigger_name: 'weekly-report' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('does not match cron trigger when event source is not cron', async () => {
      const manifestYaml = `
workflows:
  nightly-cleanup:
    trigger:
      cron:
        schedule: "0 0 * * *"
    steps:
      - agent:
          prompt: "Run nightly cleanup"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'cron.tick',
        source: 'system',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: { schedule: '0 0 * * *', trigger_name: 'nightly-cleanup' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('does not match cron trigger when schedule does not match', async () => {
      const manifestYaml = `
workflows:
  nightly-cleanup:
    trigger:
      cron:
        schedule: "0 0 * * *"
    steps:
      - agent:
          prompt: "Run nightly cleanup"
`;

      const manifest: ProjectManifest = {
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
      };

      mockManifests.findLatestByProject.mockResolvedValue(manifest);

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'cron.tick',
        source: 'cron',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: null,
        payload_json: { schedule: '*/5 * * * *', trigger_name: 'nightly-cleanup' },
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

  describe('environment-linked pipeline triggers', () => {
    it('triggers pipeline linked from environment on push to default branch', async () => {
      const manifestYaml = `
environments:
  sandbox:
    pipeline: deploy
pipelines:
  deploy:
    steps:
      - name: build
        action: { type: build }
`;
      mockManifests.findLatestByProject.mockResolvedValue({
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: null,
        branch: null,
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      mockProjects.findById.mockResolvedValue({ id: 'proj_123', branch: 'main' });

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'pipeline',
        name: 'deploy',
        projectId: 'proj_123',
        envName: 'sandbox',
      });
    });

    it('does not trigger environment-linked pipeline on push to non-default branch', async () => {
      const manifestYaml = `
environments:
  sandbox:
    pipeline: deploy
pipelines:
  deploy:
    steps:
      - name: build
        action: { type: build }
`;
      mockManifests.findLatestByProject.mockResolvedValue({
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: null,
        branch: null,
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      mockProjects.findById.mockResolvedValue({ id: 'proj_123', branch: 'main' });

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.push',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'feature/something',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('respects environment branch override', async () => {
      const manifestYaml = `
environments:
  staging:
    pipeline: deploy
    branch: develop
pipelines:
  deploy:
    steps:
      - name: build
        action: { type: build }
`;
      mockManifests.findLatestByProject.mockResolvedValue({
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: null,
        branch: null,
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      mockProjects.findById.mockResolvedValue({ id: 'proj_123', branch: 'main' });

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'github.push',
        source: 'github',
        env_name: null,
        ref_sha: 'abc123',
        ref_branch: 'develop',
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'pipeline',
        name: 'deploy',
        projectId: 'proj_123',
        envName: 'staging',
      });
    });

    it('skips environment-linked pipeline when pipeline has explicit trigger', async () => {
      const manifestYaml = `
environments:
  sandbox:
    pipeline: deploy
pipelines:
  deploy:
    trigger:
      github:
        event: push
        branch: release/*
    steps:
      - name: build
        action: { type: build }
`;
      mockManifests.findLatestByProject.mockResolvedValue({
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: null,
        branch: null,
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      mockProjects.findById.mockResolvedValue({ id: 'proj_123', branch: 'main' });

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Pipeline has explicit trigger for release/* not main, so neither
      // the explicit trigger nor the environment-linked implicit trigger should match
      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('skips environment with auto_deploy: false', async () => {
      const manifestYaml = `
environments:
  sandbox:
    pipeline: deploy
    auto_deploy: false
pipelines:
  deploy:
    steps:
      - name: build
        action: { type: build }
`;
      mockManifests.findLatestByProject.mockResolvedValue({
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: null,
        branch: null,
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      mockProjects.findById.mockResolvedValue({ id: 'proj_123', branch: 'main' });

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('does not duplicate when pipeline already matched explicitly', async () => {
      const manifestYaml = `
environments:
  sandbox:
    pipeline: deploy
pipelines:
  deploy:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - name: build
        action: { type: build }
`;
      mockManifests.findLatestByProject.mockResolvedValue({
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: null,
        branch: null,
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      mockProjects.findById.mockResolvedValue({ id: 'proj_123', branch: 'main' });

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Pipeline has explicit trigger matching main, so only the explicit match
      // should be returned (no environment-linked duplicate)
      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        type: 'pipeline',
        name: 'deploy',
        projectId: 'proj_123',
      });
      // Should NOT have envName since it matched via explicit trigger
      expect(matches[0].envName).toBeUndefined();
    });

    it('does not trigger on non-github events', async () => {
      const manifestYaml = `
environments:
  sandbox:
    pipeline: deploy
pipelines:
  deploy:
    steps:
      - name: build
        action: { type: build }
`;
      mockManifests.findLatestByProject.mockResolvedValue({
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: null,
        branch: null,
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const event: Event = {
        id: 'evt_123',
        project_id: 'proj_123',
        type: 'slack.message',
        source: 'slack',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: 'user',
        actor_id: 'user_123',
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toEqual([]);
    });

    it('triggers multiple environments with different pipelines', async () => {
      const manifestYaml = `
environments:
  sandbox:
    pipeline: deploy-sandbox
  staging:
    pipeline: deploy-staging
pipelines:
  deploy-sandbox:
    steps:
      - name: build
        action: { type: build }
  deploy-staging:
    steps:
      - name: build
        action: { type: build }
`;
      mockManifests.findLatestByProject.mockResolvedValue({
        id: 'manifest_123',
        project_id: 'proj_123',
        manifest_yaml: manifestYaml,
        manifest_hash: 'hash123',
        git_sha: null,
        branch: null,
        parsed_defaults: null,
        parsed_agents: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      mockProjects.findById.mockResolvedValue({ id: 'proj_123', branch: 'main' });

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
        payload_json: {},
        dedupe_key: null,
        job_id: null,
        trigger_match_count: null,
        triggers_evaluated: null,
        status: 'pending',
        processed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const { matches } = await service.matchTriggersForEvent(event);
      expect(matches).toHaveLength(2);
      expect(matches).toEqual(
        expect.arrayContaining([
          { type: 'pipeline', name: 'deploy-sandbox', projectId: 'proj_123', envName: 'sandbox' },
          { type: 'pipeline', name: 'deploy-staging', projectId: 'proj_123', envName: 'staging' },
        ]),
      );
    });
  });
});
