import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PipelineExpanderService } from './pipeline-expander.service.js';

let allCreatedJobs: Array<Record<string, unknown>> = [];
let createRun: ReturnType<typeof vi.fn>;

function createService(manifestYaml: string): PipelineExpanderService {
  allCreatedJobs = [];
  createRun = vi.fn().mockImplementation((data: Record<string, unknown>) => Promise.resolve({
    id: data.id,
    project_id: data.project_id,
    pipeline_name: data.pipeline_name,
    env_name: data.env_name,
    git_sha: data.git_sha,
    manifest_hash: data.manifest_hash,
    inputs_json: data.inputs_json,
    step_outputs_json: data.step_outputs_json,
    status: data.status,
    started_at: null,
    completed_at: null,
    error_message: data.error_message,
    requested_by: data.requested_by,
    run_mode: data.run_mode,
    dedupe_key: data.dedupe_key,
    created_at: new Date('2026-05-20T09:00:00.000Z'),
    updated_at: new Date('2026-05-20T09:00:00.000Z'),
  }));

  let jobCounter = 0;
  const service = new PipelineExpanderService({} as any);
  (service as any).projects = {
    findById: vi.fn().mockResolvedValue({
      id: 'proj_test123',
      org_id: 'org_test123',
      slug: 'testproj',
    }),
  };
  (service as any).manifests = {
    findByProjectAndGitSha: vi.fn().mockResolvedValue(null),
    findLatestByProject: vi.fn().mockResolvedValue({
      manifest_yaml: manifestYaml,
      manifest_hash: 'hash_test123',
    }),
  };
  (service as any).runs = {
    createRun,
    findActiveRunByDedupeKey: vi.fn().mockResolvedValue(null),
    listStepRuns: vi.fn().mockResolvedValue([]),
    updateRun: vi.fn(),
    updateStepRun: vi.fn(),
  };
  (service as any).jobs = {
    generateJobId: vi.fn().mockImplementation(() => Promise.resolve({ id: `job_${++jobCounter}` })),
    create: vi.fn().mockImplementation((data: Record<string, unknown>) => {
      allCreatedJobs.push(data);
      return Promise.resolve({
        ...data,
        created_at: new Date('2026-05-20T09:00:00.000Z'),
        updated_at: new Date('2026-05-20T09:00:00.000Z'),
      });
    }),
    addDependency: vi.fn().mockResolvedValue(undefined),
  };

  return service;
}

describe('PipelineExpanderService - env_overrides', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('persists pipeline-level env_overrides on action-run jobs', async () => {
    const service = createService(`
name: test
pipelines:
  build:
    env_overrides:
      FOO: "bar"
    steps:
      - name: run
        action:
          type: run
          command: "printf %s \\"$FOO\\""
`);

    await service.expandPipeline('proj_test123', {
      pipeline_name: 'build',
      git_sha: 'abc123',
    });

    expect(allCreatedJobs[0].env_overrides).toEqual({ FOO: 'bar' });
  });

  it('lets step-level env_overrides override pipeline-level values for action-run jobs', async () => {
    const service = createService(`
name: test
pipelines:
  build:
    env_overrides:
      FOO: "pipeline"
      KEEP: "yes"
    steps:
      - name: run
        env_overrides:
          FOO: "step"
        action:
          type: run
          command: "printf ok"
`);

    await service.expandPipeline('proj_test123', {
      pipeline_name: 'build',
      git_sha: 'abc123',
    });

    expect(allCreatedJobs[0].env_overrides).toEqual({
      FOO: 'step',
      KEEP: 'yes',
    });
  });

  it('keeps non-run action env_overrides null', async () => {
    const service = createService(`
name: test
pipelines:
  deploy:
    env_overrides:
      FOO: "pipeline"
    steps:
      - name: deploy
        env_overrides:
          FOO: "step"
        action:
          type: deploy
`);

    await service.expandPipeline('proj_test123', {
      pipeline_name: 'deploy',
      git_sha: 'abc123',
    });

    expect(allCreatedJobs[0].env_overrides).toBeNull();
  });

  it('rejects invalid env_overrides before creating a pipeline run', async () => {
    const service = createService(`
name: test
pipelines:
  bad:
    env_overrides:
      PATH: "/evil"
    steps:
      - name: run
        action:
          type: run
          command: "printf ok"
`);

    await expect(service.expandPipeline('proj_test123', {
      pipeline_name: 'bad',
      git_sha: 'abc123',
    })).rejects.toThrow(/env key PATH is reserved/);
    expect(createRun).not.toHaveBeenCalled();
    expect(allCreatedJobs).toHaveLength(0);
  });

  it('includes action-run env_overrides in dry-run responses without persisting jobs', async () => {
    const service = createService(`
name: test
pipelines:
  dry:
    env_overrides:
      FOO: "bar"
    steps:
      - name: run
        action:
          type: run
          command: "printf ok"
`);

    const response = await service.expandPipeline('proj_test123', {
      pipeline_name: 'dry',
      git_sha: 'abc123',
      dry_run: true,
    });

    expect(response.jobs[0].env_overrides).toEqual({ FOO: 'bar' });
    expect(createRun).not.toHaveBeenCalled();
    expect(allCreatedJobs).toHaveLength(0);
  });
});
