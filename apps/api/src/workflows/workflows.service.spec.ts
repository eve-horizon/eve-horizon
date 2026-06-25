import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowsService, validateStepGraph, parseStepCondition } from './workflows.service.js';

// Capture what jobs.create receives. `capturedJobCreate` is the *last* job
// created (most commonly the last step). `allCreatedJobs` holds every call in
// order so step-specific assertions can pick the right one.
let capturedJobCreate: Record<string, unknown> | null = null;
let allCreatedJobs: Array<Record<string, unknown>> = [];

const mockManifestYamlWithGit = `
name: test
services:
  api:
    image: test:latest
workflows:
  sync-docs:
    git:
      ref: main
      commit: auto
      push: on_success
    hints:
      permission_policy: auto_edit
    steps:
      - agent:
          prompt: "Sync docs"
`;

const mockManifestYamlWithoutGit = `
name: test
services:
  api:
    image: test:latest
workflows:
  simple:
    steps:
      - agent:
          prompt: "Do something"
`;

const mockManifestYamlWithPartialGit = `
name: test
services:
  api:
    image: test:latest
workflows:
  partial-git:
    git:
      ref: develop
    steps:
      - agent:
          prompt: "Work"
`;

function createMockDb(manifestYaml: string) {
  return {
    // Postgres tagged template — just return a passthrough so queries don't throw
    begin: vi.fn(),
  } as unknown;
}

interface ServiceOptions {
  agentConfigs?: {
    xEveYaml?: string | null;
    parsedAgents?: Record<string, unknown> | null;
  };
  agents?: Array<{
    id: string;
    harness_profile?: string | null;
    policies_json?: Record<string, unknown> | null;
  }>;
  apiSources?: {
    list?: ReturnType<typeof vi.fn>;
  };
  appLinkSubscriptions?: {
    listByConsumer?: ReturnType<typeof vi.fn>;
    listWithGrants?: ReturnType<typeof vi.fn>;
  };
}

function createService(
  manifestYaml: string,
  options: ServiceOptions = {},
): WorkflowsService {
  capturedJobCreate = null;
  allCreatedJobs = [];

  const service = new WorkflowsService(createMockDb(manifestYaml) as any);

  // Override the query objects with mocks
  const manifests = {
    findLatestByProject: vi.fn().mockResolvedValue({
      manifest_yaml: manifestYaml,
    }),
  };
  const projects = {
    findById: vi.fn().mockResolvedValue({
      id: 'proj_test123',
      org_id: 'org_test123',
      slug: 'testproj',
    }),
  };
  const jobs = {
    generateJobId: vi.fn().mockImplementation(() =>
      Promise.resolve({
        id: `testproj-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`,
        projectId: 'proj_test123',
      }),
    ),
    create: vi.fn().mockImplementation((data: Record<string, unknown>) => {
      capturedJobCreate = data;
      allCreatedJobs.push(data);
      return Promise.resolve({ id: data.id, phase: 'ready' });
    }),
    addDependency: vi.fn().mockResolvedValue(undefined),
  };
  const agents = {
    listByProject: vi.fn().mockResolvedValue(options.agents ?? []),
  };
  const agentConfigs = {
    findLatestByProject: vi.fn().mockResolvedValue(
      options.agentConfigs?.xEveYaml !== undefined || options.agentConfigs?.parsedAgents !== undefined
        ? {
            x_eve_yaml: options.agentConfigs?.xEveYaml ?? null,
            parsed_agents: options.agentConfigs?.parsedAgents ?? null,
          }
        : null,
    ),
  };
  const apiSources = {
    list: options.apiSources?.list ?? vi.fn().mockResolvedValue([]),
  };
  const appLinkSubscriptions = {
    listByConsumer: options.appLinkSubscriptions?.listByConsumer ?? vi.fn().mockResolvedValue([]),
    listWithGrants: options.appLinkSubscriptions?.listWithGrants ?? vi.fn().mockResolvedValue([]),
  };

  // Inject mocks via private field access
  (service as any).manifests = manifests;
  (service as any).projects = projects;
  (service as any).jobs = jobs;
  (service as any).agents = agents;
  (service as any).agentConfigs = agentConfigs;
  (service as any).apiSources = apiSources;
  (service as any).appLinkSubscriptions = appLinkSubscriptions;

  return service;
}

describe('WorkflowsService', () => {
  describe('invoke - script steps', () => {
    it('materializes a workflow script step as a script job', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  setup-workflow:
    hints:
      permission_policy: auto_edit
    steps:
      - name: setup
        script:
          run: "echo setup"
          timeout_seconds: 45
`);

      await service.invoke('proj_test123', 'setup-workflow', {
        input: { topic: 'docs' },
      });

      const stepJob = allCreatedJobs.find((job) => job.step_name === 'setup');
      expect(stepJob).toBeTruthy();
      expect(stepJob?.execution_type).toBe('script');
      expect(stepJob?.script_command).toBe('echo setup');
      expect(stepJob?.script_timeout_seconds).toBe(45);
      expect(stepJob?.harness).toBeNull();
      expect(stepJob?.assignee).toBeNull();
      expect(stepJob?.description).toContain('echo setup');
      expect(stepJob?.description).toContain('Workflow input');
      expect((stepJob?.hints as Record<string, unknown>).permission_policy).toBeUndefined();
    });

    it('materializes mixed script and agent workflows with dependency wiring', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  mixed:
    steps:
      - name: setup
        run: "echo setup"
      - name: review
        depends_on: [setup]
        agent:
          prompt: "Review setup"
      - name: cleanup
        depends_on: [review]
        script:
          command: "echo cleanup"
`);

      await service.invoke('proj_test123', 'mixed');

      const setupJob = allCreatedJobs.find((job) => job.step_name === 'setup');
      const reviewJob = allCreatedJobs.find((job) => job.step_name === 'review');
      const cleanupJob = allCreatedJobs.find((job) => job.step_name === 'cleanup');
      expect(setupJob?.execution_type).toBe('script');
      expect(reviewJob?.execution_type).toBe('agent');
      expect(cleanupJob?.execution_type).toBe('script');

      const addDependency = (service as any).jobs.addDependency;
      expect(addDependency).toHaveBeenCalledWith(reviewJob?.id, setupJob?.id, 'blocks');
      expect(addDependency).toHaveBeenCalledWith(cleanupJob?.id, reviewJob?.id, 'blocks');
    });

    it('persists script step token scope and permissions', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  scoped-script:
    scope:
      orgfs:
        allow_prefixes: ["/groups/projects/**"]
    permissions: ["jobs:read", "orgs:read"]
    steps:
      - name: setup
        script:
          run: "eve job list --json"
        scope:
          orgfs:
            allow_prefixes: ["/groups/projects/demo/**"]
        permissions: ["jobs:read"]
`);

      await service.invoke('proj_test123', 'scoped-script');

      const stepJob = allCreatedJobs.find((job) => job.step_name === 'setup');
      expect(stepJob?.token_scope).toEqual({
        orgfs: {
          allow_prefixes: ['/groups/projects/demo/**'],
          read_only_prefixes: [],
        },
      });
      expect(stepJob?.token_permissions).toEqual(['jobs:read']);
    });

    it('persists resolved toolchains for workflow script steps', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  toolchain-scripts:
    toolchains: [media]
    steps:
      - name: root-default
        run: "echo root"
      - name: step-override
        toolchains: [python, python]
        script:
          run: "python -m demo"
      - name: empty-step
        toolchains: []
        run: "echo empty"
`);

      await service.invoke('proj_test123', 'toolchain-scripts');

      const rootDefault = allCreatedJobs.find((job) => job.step_name === 'root-default');
      const stepOverride = allCreatedJobs.find((job) => job.step_name === 'step-override');
      const emptyStep = allCreatedJobs.find((job) => job.step_name === 'empty-step');

      expect((rootDefault?.hints as Record<string, unknown>).toolchains).toEqual(['media']);
      expect((stepOverride?.hints as Record<string, unknown>).toolchains).toEqual(['python']);
      expect((emptyStep?.hints as Record<string, unknown>).toolchains).toEqual(['media']);
    });

    it('persists workflow env on root and child jobs', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  env-scoped:
    env: sandbox
    steps:
      - name: smoke
        script:
          run: "echo smoke"
      - name: review
        agent:
          prompt: "Review smoke"
`);

      await service.invoke('proj_test123', 'env-scoped');

      const rootJob = allCreatedJobs.find((job) => job.depth === 0);
      const smokeJob = allCreatedJobs.find((job) => job.step_name === 'smoke');
      const reviewJob = allCreatedJobs.find((job) => job.step_name === 'review');

      expect(rootJob?.env_name).toBe('sandbox');
      expect(smokeJob?.env_name).toBe('sandbox');
      expect(reviewJob?.env_name).toBe('sandbox');
    });

    it('leaves workflow env_name null when workflow env is omitted', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  unscoped:
    steps:
      - name: smoke
        script:
          run: "echo smoke"
`);

      await service.invoke('proj_test123', 'unscoped');

      const rootJob = allCreatedJobs.find((job) => job.depth === 0);
      const smokeJob = allCreatedJobs.find((job) => job.step_name === 'smoke');

      expect(rootJob?.env_name).toBeNull();
      expect(smokeJob?.env_name).toBeNull();
    });

    it('uses workflow env when resolving workflow-level app APIs for agent steps', async () => {
      const listApis = vi.fn()
        .mockResolvedValueOnce([
          {
            name: 'api',
            type: 'openapi',
            base_url: 'http://api.sandbox.svc:3000',
          },
        ])
        .mockResolvedValueOnce([]);
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  app-api-env:
    env: sandbox
    with_apis: [api]
    steps:
      - name: call-api
        agent:
          prompt: "Call the app"
`, {
        apiSources: { list: listApis },
      });

      await service.invoke('proj_test123', 'app-api-env');

      expect(listApis).toHaveBeenNthCalledWith(1, {
        project_id: 'proj_test123',
        env_name: 'sandbox',
      });
      expect(listApis).toHaveBeenNthCalledWith(2, {
        project_id: 'proj_test123',
        env_name: null,
      });
      const stepJob = allCreatedJobs.find((job) => job.step_name === 'call-api');
      expect((stepJob?.hints as Record<string, unknown>).resolved_app_apis).toEqual([
        {
          name: 'api',
          type: 'openapi',
          base_url: 'http://api.sandbox.svc:3000',
        },
      ]);
    });

    it('resolves agent step toolchains from step, agent config, then workflow root', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  agent-toolchains:
    toolchains: [python]
    steps:
      - name: agent-default
        agent:
          name: builder
      - name: step-override
        agent:
          name: builder
        toolchains: [rust]
      - name: root-fallback
        agent:
          prompt: "Inline agent"
`, {
        agents: [
          { id: 'builder', harness_profile: null, policies_json: {} },
        ],
        agentConfigs: {
          parsedAgents: {
            builder: { toolchains: ['media'] },
          },
        },
      });

      await service.invoke('proj_test123', 'agent-toolchains');

      const agentDefault = allCreatedJobs.find((job) => job.step_name === 'agent-default');
      const stepOverride = allCreatedJobs.find((job) => job.step_name === 'step-override');
      const rootFallback = allCreatedJobs.find((job) => job.step_name === 'root-fallback');

      expect((agentDefault?.hints as Record<string, unknown>).toolchains).toEqual(['media']);
      expect((stepOverride?.hints as Record<string, unknown>).toolchains).toEqual(['rust']);
      expect((rootFallback?.hints as Record<string, unknown>).toolchains).toEqual(['python']);
    });

    it('rejects workflow action steps explicitly before creating jobs', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  unsupported-action:
    steps:
      - name: deploy
        action:
          type: deploy
`);

      await expect(service.invoke('proj_test123', 'unsupported-action')).rejects.toThrow(/action steps not yet supported/i);
      expect(allCreatedJobs).toHaveLength(0);
    });

    it('rejects workflow action steps with toolchains during manifest validation', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  unsupported-action-toolchains:
    steps:
      - name: deploy
        toolchains: [python]
        action:
          type: run
`);

      await expect(service.invoke('proj_test123', 'unsupported-action-toolchains')).rejects.toThrow(/Workflow action steps do not support toolchains/i);
      expect(allCreatedJobs).toHaveLength(0);
    });

    it('rejects ambiguous workflow steps before creating jobs', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  ambiguous:
    steps:
      - name: setup
        agent:
          prompt: "Plan"
        script:
          run: "echo setup"
`);

      await expect(service.invoke('proj_test123', 'ambiguous')).rejects.toThrow(/exactly one/i);
      expect(allCreatedJobs).toHaveLength(0);
    });
  });

  describe('invoke - step prompts', () => {
    it('uses workflow agent prompt as the child job description', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  prompt-workflow:
    steps:
      - name: plan
        agent:
          prompt: |
            # Plan

            Create the implementation plan.
`);

      await service.invoke('proj_test123', 'prompt-workflow');

      const planJob = allCreatedJobs.find((job) => job.step_name === 'plan');
      expect(planJob?.description).toBe('# Plan\n\nCreate the implementation plan.\n');
    });
  });

  describe('invoke - git config propagation', () => {
    it('propagates git config from workflow definition to created job', async () => {
      const service = createService(mockManifestYamlWithGit);

      await service.invoke('proj_test123', 'sync-docs');

      expect(capturedJobCreate).not.toBeNull();
      expect(capturedJobCreate!.git_json).toEqual({
        ref: 'main',
        commit: 'auto',
        push: 'on_success',
      });
    });

    it('sets git_json to null when workflow has no git config', async () => {
      const service = createService(mockManifestYamlWithoutGit);

      await service.invoke('proj_test123', 'simple');

      expect(capturedJobCreate).not.toBeNull();
      expect(capturedJobCreate!.git_json).toBeNull();
    });

    it('propagates partial git config', async () => {
      const service = createService(mockManifestYamlWithPartialGit);

      await service.invoke('proj_test123', 'partial-git');

      expect(capturedJobCreate).not.toBeNull();
      expect(capturedJobCreate!.git_json).toEqual({
        ref: 'develop',
      });
    });

    it('materializes step-level git config with input interpolation on child jobs', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  make-plan:
    inputs:
      slug:
        required: true
    steps:
      - name: plan
        agent:
          prompt: "Plan"
        git:
          ref_policy: project_default
          branch: "plans/\${inputs.slug}"
          create_branch: if_missing
          commit: required
          push: on_success
      - name: review
        depends_on: [plan]
        agent:
          prompt: "Review"
        git:
          ref_policy: explicit
          ref: "plans/\${inputs.slug}"
          branch: "plans/\${inputs.slug}"
          create_branch: never
          commit: auto
          push: on_success
`);

      await service.invoke('proj_test123', 'make-plan', {
        input: { slug: 'camera-portal-healthz' },
      });

      const planJob = allCreatedJobs.find((job) => job.step_name === 'plan');
      const reviewJob = allCreatedJobs.find((job) => job.step_name === 'review');

      expect(planJob?.git_json).toEqual({
        ref_policy: 'project_default',
        branch: 'plans/camera-portal-healthz',
        create_branch: 'if_missing',
        commit: 'required',
        push: 'on_success',
      });
      expect(reviewJob?.git_json).toEqual({
        ref_policy: 'explicit',
        ref: 'plans/camera-portal-healthz',
        branch: 'plans/camera-portal-healthz',
        create_branch: 'never',
        commit: 'auto',
        push: 'on_success',
      });
    });

    it('merges workflow git defaults with step-level overrides', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  inherited-git:
    git:
      ref_policy: project_default
      create_branch: if_missing
      commit: manual
      push: never
    steps:
      - name: work
        agent:
          prompt: "Work"
        git:
          branch: "job/\${inputs.slug}"
          commit: required
`);

      await service.invoke('proj_test123', 'inherited-git', {
        input: { slug: 'abc123' },
      });

      const stepJob = allCreatedJobs.find((job) => job.step_name === 'work');
      expect(stepJob?.git_json).toEqual({
        ref_policy: 'project_default',
        create_branch: 'if_missing',
        commit: 'required',
        push: 'never',
        branch: 'job/abc123',
      });
    });
  });

  describe('invoke - hints propagation', () => {
    it('propagates hints from workflow definition', async () => {
      const service = createService(mockManifestYamlWithGit);

      await service.invoke('proj_test123', 'sync-docs');

      expect(capturedJobCreate).not.toBeNull();
      const hints = capturedJobCreate!.hints as Record<string, unknown>;
      expect(hints.permission_policy).toBe('auto_edit');
      expect(hints.workflow_name).toBe('sync-docs');
    });

    it('preserves toolchain hints on workflow retry clones', () => {
      const service = createService(mockManifestYamlWithoutGit);
      const retryHints = (service as any).buildRetryStepHints(
        {
          id: 'job_source',
          hints: {
            workflow_name: 'simple',
            step_name: 'step-1',
            toolchains: ['python'],
          },
        },
        {
          rootJobId: 'job_root',
          generation: 2,
          mode: 'failed',
          requestedAt: '2026-05-19T09:00:00.000Z',
        },
      );

      expect(retryHints.toolchains).toEqual(['python']);
      expect(retryHints.workflow_retry_generation).toBe(2);
      expect(retryHints.workflow_retry_of).toBe('job_source');
    });
  });

  describe('invoke - env_overrides propagation', () => {
    it('persists merged workflow, step, and invocation env_overrides on step jobs', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  research:
    env_overrides:
      GLOBAL_KEY: workflow
      SHARED_KEY: workflow
    steps:
      - name: search
        agent:
          prompt: "Search"
        env_overrides:
          STEP_KEY: step
          SHARED_KEY: step
      - name: summarize
        depends_on: [search]
        agent:
          prompt: "Summarize"
`);

      await service.invoke('proj_test123', 'research', {
        env_overrides: {
          INVOCATION_KEY: '${secret.INVOCATION_KEY}',
          SHARED_KEY: 'invocation',
        },
      });

      const rootJob = allCreatedJobs.find((job) => job.parent_id === null);
      const searchJob = allCreatedJobs.find((job) => job.step_name === 'search');
      const summarizeJob = allCreatedJobs.find((job) => job.step_name === 'summarize');

      expect(rootJob?.env_overrides).toBeNull();
      expect(searchJob?.env_overrides).toEqual({
        GLOBAL_KEY: 'workflow',
        STEP_KEY: 'step',
        INVOCATION_KEY: '${secret.INVOCATION_KEY}',
        SHARED_KEY: 'invocation',
      });
      expect(summarizeJob?.env_overrides).toEqual({
        GLOBAL_KEY: 'workflow',
        INVOCATION_KEY: '${secret.INVOCATION_KEY}',
        SHARED_KEY: 'invocation',
      });
    });

    it('keeps step job env_overrides null for workflows without overrides', async () => {
      const service = createService(mockManifestYamlWithoutGit);

      await service.invoke('proj_test123', 'simple');

      const stepJob = allCreatedJobs.find((job) => job.step_name === 'step-1');
      expect(stepJob?.env_overrides).toBeNull();
    });

    it('rejects invalid manifest env_overrides at invocation time', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  invalid-env:
    steps:
      - name: run
        agent:
          prompt: "Run"
        env_overrides:
          EVE_JOB_TOKEN: \${secret.TOKEN}
`);

      await expect(service.invoke('proj_test123', 'invalid-env')).rejects.toThrow(/workflows\.invalid-env\.steps\.0\.env_overrides/);
    });
  });

  describe('invoke - token scope propagation', () => {
    it('persists intersected workflow, step, and invocation token scope on step jobs', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  scoped:
    scope:
      orgfs:
        allow_prefixes: ["/groups/projects/**"]
      cloud_fs:
        allow_mount_ids: ["mount_a", "mount_b"]
    steps:
      - name: scoped-step
        agent:
          prompt: "Run"
        scope:
          orgfs:
            allow_prefixes: ["/groups/projects/project-a/**"]
          cloud_fs:
            allow_mount_ids: ["mount_a"]
`);

      await service.invoke('proj_test123', 'scoped', {
        scope: {
          orgfs: { allow_prefixes: ['/groups/projects/project-a/reports/**'] },
          cloud_fs: { allow_mount_ids: ['mount_a'] },
        },
      });

      const rootJob = allCreatedJobs.find((job) => job.parent_id === null);
      const stepJob = allCreatedJobs.find((job) => job.step_name === 'scoped-step');

      expect(rootJob?.token_scope).toBeNull();
      expect(stepJob?.token_scope).toEqual({
        orgfs: {
          allow_prefixes: ['/groups/projects/project-a/reports/**'],
          read_only_prefixes: [],
        },
        cloud_fs: {
          allow_mount_ids: ['mount_a'],
        },
      });
    });

    it('keeps token_scope null for workflows without scope', async () => {
      const service = createService(mockManifestYamlWithoutGit);

      await service.invoke('proj_test123', 'simple');

      const stepJob = allCreatedJobs.find((job) => job.step_name === 'step-1');
      expect(stepJob?.token_scope).toBeNull();
    });
  });

  describe('invoke - workflow resource refs', () => {
    it('passes invocation resource_refs to dependent steps by default', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  design:
    steps:
      - name: read
        agent:
          prompt: "Read sources"
      - name: revise
        depends_on: [read]
        agent:
          prompt: "Revise from sources"
`);

      const response = await service.invoke('proj_test123', 'design', {
        input: {
          resource_refs: [
            { name: 'brief', uri: 'org_docs:/design/brief.md', label: 'brief.md', required: true },
          ],
        },
      });

      const rootJob = allCreatedJobs.find((job) => job.parent_id === null);
      const readJob = allCreatedJobs.find((job) => job.step_name === 'read');
      const reviseJob = allCreatedJobs.find((job) => job.step_name === 'revise');

      expect(rootJob?.resource_refs).toEqual([
        { name: 'brief', uri: 'org_docs:/design/brief.md', label: 'brief.md', required: true },
      ]);
      expect(readJob?.resource_refs).toEqual(rootJob?.resource_refs);
      expect(reviseJob?.resource_refs).toEqual(rootJob?.resource_refs);
      expect((reviseJob?.hints as Record<string, unknown>).resource_refs_policy).toBe('inherit');

      expect(response).toMatchObject({
        step_jobs: [
          { step_name: 'read', resource_refs: { mode: 'inherit', source: 'default', count: 1, inherited_count: 1 } },
          { step_name: 'revise', resource_refs: { mode: 'inherit', source: 'default', count: 1, inherited_count: 1 } },
        ],
      });
    });

    it('supports workflow-level selection and step-level opt out', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  scoped-design:
    resource_refs:
      - brief
    steps:
      - name: read
        agent:
          prompt: "Read brief"
      - name: publish
        depends_on: [read]
        resource_refs: none
        agent:
          prompt: "Publish without raw refs"
`);

      const response = await service.invoke('proj_test123', 'scoped-design', {
        input: {
          resource_refs: [
            { name: 'brief', uri: 'org_docs:/design/brief.md', label: 'brief.md' },
            { name: 'secret-source', uri: 'org_docs:/design/secret.md', label: 'secret.md' },
          ],
        },
      });

      const readJob = allCreatedJobs.find((job) => job.step_name === 'read');
      const publishJob = allCreatedJobs.find((job) => job.step_name === 'publish');

      expect(readJob?.resource_refs).toEqual([
        { name: 'brief', uri: 'org_docs:/design/brief.md', label: 'brief.md' },
      ]);
      expect(publishJob?.resource_refs).toEqual([]);
      expect((readJob?.hints as Record<string, unknown>).resource_refs_selectors).toEqual(['brief']);
      expect((publishJob?.hints as Record<string, unknown>).resource_refs_policy).toBe('none');

      expect(response).toMatchObject({
        step_jobs: [
          { step_name: 'read', resource_refs: { mode: 'selected', source: 'workflow', count: 1, inherited_count: 2, selectors: ['brief'] } },
          { step_name: 'publish', resource_refs: { mode: 'none', source: 'step', count: 0, inherited_count: 2 } },
        ],
      });
    });

    it('rejects invalid resource_refs policies at invocation time', async () => {
      const service = createService(`
name: test
services:
  api:
    image: test:latest
workflows:
  bad-resource-policy:
    resource_refs: sometimes
    steps:
      - name: read
        agent:
          prompt: "Read"
`);

      await expect(service.invoke('proj_test123', 'bad-resource-policy')).rejects.toThrow(/workflows\.bad-resource-policy\.resource_refs/i);
    });
  });

  describe('invoke - Phase 4 template expressions', () => {
    const profilesYaml = `
name: test
x-eve:
  agents:
    profiles:
      planner:
        - harness: claude
          model: claude-sonnet-4-6
workflows:
  classify:
    inputs:
      model:
        from: event.payload.meta.model
        default: planner
    steps:
      - name: classify-one
        agent:
          name: my-agent
        harness_profile: \${inputs.model}
  templated:
    inputs:
      brand:
        from: event.payload.meta.brand
    steps:
      - name: run
        agent:
          name: my-agent
        harness_profile_override:
          harness: zai
          model: glm-4.6-\${inputs.brand}
`;

    const agentFixtures = [
      {
        id: 'my-agent',
        harness_profile: 'planner',
        policies_json: {},
      },
    ];

    it('resolves step harness_profile template from event.payload and uses string_ref source', async () => {
      const service = createService(profilesYaml, {
        agents: agentFixtures,
        agentConfigs: {
          xEveYaml: `
agents:
  profiles:
    planner:
      - harness: claude
        model: claude-sonnet-4-6
    fast:
      - harness: zai
        model: glm-4.6
`,
        },
      });

      await service.invoke('proj_test123', 'classify', {
        input: { payload: { meta: { model: 'fast' } } },
      });

      // Two creates: root container + one step
      expect(allCreatedJobs).toHaveLength(2);
      const step = allCreatedJobs[1];
      expect(step.harness).toBe('zai');
      expect((step.harness_options as Record<string, unknown>).model).toBe('glm-4.6');
      expect(step.harness_profile).toBe('fast');
      expect(step.harness_profile_source).toBe('string_ref');
      expect(step.harness_profile_override).toBeNull();
      expect(step.harness_profile_hash).toBeTruthy();
    });

    it('falls back to agent_default when the template has no resolution', async () => {
      const service = createService(profilesYaml, {
        agents: agentFixtures,
        agentConfigs: {
          xEveYaml: `
agents:
  profiles:
    planner:
      - harness: claude
        model: claude-sonnet-4-6
`,
        },
      });

      // No payload → default kicks in → declared default is 'planner'.
      await service.invoke('proj_test123', 'classify');

      const step = allCreatedJobs[1];
      expect(step.harness).toBe('claude');
      expect(step.harness_profile).toBe('planner');
      expect(step.harness_profile_source).toBe('string_ref');
    });

    it('resolves harness_profile_override templates and persists the inline bundle', async () => {
      const service = createService(profilesYaml, {
        agents: agentFixtures,
        agentConfigs: {
          xEveYaml: `
agents:
  profiles:
    planner:
      - harness: claude
        model: claude-sonnet-4-6
`,
        },
      });

      await service.invoke('proj_test123', 'templated', {
        input: { payload: { meta: { brand: 'eden' } } },
      });

      const step = allCreatedJobs[1];
      expect(step.harness).toBe('zai');
      expect((step.harness_options as Record<string, unknown>).model).toBe('glm-4.6-eden');
      expect(step.harness_profile_source).toBe('workflow_template');
      expect(step.harness_profile_override).toEqual({
        harness: 'zai',
        model: 'glm-4.6-eden',
      });
      expect(step.harness_profile_hash).toBeTruthy();
    });

    it('falls back to agent default when override has unresolved refs', async () => {
      const service = createService(profilesYaml, {
        agents: agentFixtures,
        agentConfigs: {
          xEveYaml: `
agents:
  profiles:
    planner:
      - harness: claude
        model: claude-sonnet-4-6
`,
        },
      });

      // No brand in payload → model template can't resolve.
      await service.invoke('proj_test123', 'templated', {
        input: { payload: { meta: {} } },
      });

      const step = allCreatedJobs[1];
      expect(step.harness).toBe('claude');
      expect((step.harness_options as Record<string, unknown>).model).toBe('claude-sonnet-4-6');
      expect(step.harness_profile_source).toBe('agent_default');
      expect(step.harness_profile_override).toBeNull();
    });
  });
});

describe('parseStepCondition', () => {
  it('parses == condition with single quotes', () => {
    const result = parseStepCondition("triage.status == 'complex'");
    expect(result).toEqual({ stepName: 'triage', operator: '==', value: 'complex' });
  });

  it('parses != condition with single quotes', () => {
    const result = parseStepCondition("triage.status != 'simple'");
    expect(result).toEqual({ stepName: 'triage', operator: '!=', value: 'simple' });
  });

  it('parses condition with double quotes', () => {
    const result = parseStepCondition('triage.status == "complex"');
    expect(result).toEqual({ stepName: 'triage', operator: '==', value: 'complex' });
  });

  it('handles step names with hyphens', () => {
    const result = parseStepCondition("fast-triage.status == 'needs-review'");
    expect(result).toEqual({ stepName: 'fast-triage', operator: '==', value: 'needs-review' });
  });

  it('returns null for invalid format', () => {
    expect(parseStepCondition('invalid')).toBeNull();
    expect(parseStepCondition('triage.result == "ok"')).toBeNull();
    expect(parseStepCondition('triage.status > 5')).toBeNull();
    expect(parseStepCondition('')).toBeNull();
  });
});

describe('validateStepGraph - condition validation', () => {
  it('rejects steps with ambiguous execution kinds', () => {
    const steps = [
      { name: 'setup', agent: { name: 'bot' }, script: { run: 'echo setup' } },
    ];
    expect(() => validateStepGraph('test', steps)).toThrow(/exactly one/i);
  });

  it('accepts valid conditions', () => {
    const steps = [
      { name: 'triage', agent: { name: 'bot' } },
      { name: 'deep', depends_on: ['triage'], agent: { name: 'bot' }, condition: "triage.status == 'complex'" },
    ];
    expect(() => validateStepGraph('test', steps)).not.toThrow();
  });

  it('rejects condition with invalid format', () => {
    const steps = [
      { name: 'triage', agent: { name: 'bot' } },
      { name: 'deep', depends_on: ['triage'], agent: { name: 'bot' }, condition: 'bad condition' },
    ];
    expect(() => validateStepGraph('test', steps)).toThrow(/invalid condition/i);
  });

  it('rejects condition referencing nonexistent step', () => {
    const steps = [
      { name: 'triage', agent: { name: 'bot' } },
      { name: 'deep', depends_on: ['triage'], agent: { name: 'bot' }, condition: "ghost.status == 'complex'" },
    ];
    expect(() => validateStepGraph('test', steps)).toThrow(/nonexistent step/i);
  });

  it('rejects condition referencing step not in depends_on', () => {
    const steps = [
      { name: 'triage', agent: { name: 'bot' } },
      { name: 'other', agent: { name: 'bot' } },
      { name: 'deep', depends_on: ['other'], agent: { name: 'bot' }, condition: "triage.status == 'complex'" },
    ];
    expect(() => validateStepGraph('test', steps)).toThrow(/not in its depends_on/i);
  });

  it('accepts != conditions', () => {
    const steps = [
      { name: 'triage', agent: { name: 'bot' } },
      { name: 'deep', depends_on: ['triage'], agent: { name: 'bot' }, condition: "triage.status != 'simple'" },
    ];
    expect(() => validateStepGraph('test', steps)).not.toThrow();
  });
});
