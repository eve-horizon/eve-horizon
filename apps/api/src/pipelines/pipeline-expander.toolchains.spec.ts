import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PipelineExpanderService } from './pipeline-expander.service.js';

let allCreatedJobs: Array<Record<string, unknown>> = [];

function createService(manifestYaml: string): PipelineExpanderService {
  allCreatedJobs = [];
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
    createRun: vi.fn().mockImplementation((data: Record<string, unknown>) => Promise.resolve({
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
      created_at: new Date('2026-05-19T09:00:00.000Z'),
      updated_at: new Date('2026-05-19T09:00:00.000Z'),
    })),
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
        created_at: new Date('2026-05-19T09:00:00.000Z'),
        updated_at: new Date('2026-05-19T09:00:00.000Z'),
      });
    }),
    addDependency: vi.fn().mockResolvedValue(undefined),
  };

  return service;
}

describe('PipelineExpanderService - toolchains', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('persists resolved toolchains on pipeline script, agent, and action-run jobs', async () => {
    const service = createService(`
name: test
pipelines:
  build:
    toolchains: [media]
    steps:
      - name: root-script
        run: "echo root"
      - name: step-script
        toolchains: [python, python]
        script:
          run: "python -m demo"
      - name: agent-step
        agent:
          prompt: "Plan"
      - name: action-run
        toolchains: [java]
        action:
          type: run
          command: "java -version"
      - name: deploy
        action:
          type: deploy
`);

    await service.expandPipeline('proj_test123', {
      pipeline_name: 'build',
      git_sha: 'abc123',
    });

    const rootScript = allCreatedJobs.find((job) => job.step_name === 'root-script');
    const stepScript = allCreatedJobs.find((job) => job.step_name === 'step-script');
    const agentStep = allCreatedJobs.find((job) => job.step_name === 'agent-step');
    const actionRun = allCreatedJobs.find((job) => job.step_name === 'action-run');
    const deploy = allCreatedJobs.find((job) => job.step_name === 'deploy');

    expect((rootScript?.hints as Record<string, unknown>).toolchains).toEqual(['media']);
    expect((stepScript?.hints as Record<string, unknown>).toolchains).toEqual(['python']);
    expect((agentStep?.hints as Record<string, unknown>).toolchains).toEqual(['media']);
    expect((actionRun?.hints as Record<string, unknown>).toolchains).toEqual(['java']);
    expect((deploy?.hints as Record<string, unknown>).toolchains).toBeUndefined();
  });

  it('includes resolved toolchains in dry-run responses', async () => {
    const service = createService(`
name: test
pipelines:
  dry:
    toolchains: [python]
    steps:
      - name: check
        run: "python -m demo"
`);

    const response = await service.expandPipeline('proj_test123', {
      pipeline_name: 'dry',
      git_sha: 'abc123',
      dry_run: true,
    });

    expect(response.jobs[0].hints.toolchains).toEqual(['python']);
    expect(allCreatedJobs).toHaveLength(0);
  });

  it('rejects top-level toolchains on non-run action steps', async () => {
    const service = createService(`
name: test
pipelines:
  deploy:
    steps:
      - name: deploy
        toolchains: [python]
        action:
          type: deploy
`);

    await expect(service.expandPipeline('proj_test123', {
      pipeline_name: 'deploy',
      git_sha: 'abc123',
    })).rejects.toThrow(/action steps support toolchains only for action.type=run/i);
    expect(allCreatedJobs).toHaveLength(0);
  });

  it('rejects nested action.toolchains', async () => {
    const service = createService(`
name: test
pipelines:
  nested:
    steps:
      - name: run
        action:
          type: run
          command: "python -m demo"
          toolchains: [python]
`);

    await expect(service.expandPipeline('proj_test123', {
      pipeline_name: 'nested',
      git_sha: 'abc123',
    })).rejects.toThrow(/action\.toolchains.*top-level step toolchains/i);
    expect(allCreatedJobs).toHaveLength(0);
  });
});
