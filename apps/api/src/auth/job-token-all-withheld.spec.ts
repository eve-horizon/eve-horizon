import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessService } from './access.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { PipelineExpanderService } from '../pipelines/pipeline-expander.service';

const MANIFEST = `
name: a
workflows:
  nightly:
    steps:
      - name: sweep
        permissions: [system:admin, orgs:invite]
        script:
          run: "true"
pipelines:
  release:
    steps:
      - name: run
        permissions: [system:admin, orgs:admin]
        action:
          type: run
          command: "true"
`;

/** The narrowest documented job default: enough for a script to read and report on its own job. */
const MINIMAL = ['envs:read', 'jobs:read', 'jobs:write', 'projects:read'];

const m = vi.hoisted(() => {
  const jobs: Array<Record<string, unknown>> = [];
  let n = 0;
  return {
    jobs,
    projects: {
      findById: vi.fn(async (id: string) => (id === 'proj_a' ? { id: 'proj_a', org_id: 'org_a', slug: 'a', name: 'a' } : null)),
    },
    manifests: {
      findByProjectAndGitSha: vi.fn(async () => null),
      findLatestByProject: vi.fn(async () => ({ manifest_yaml: '', manifest_hash: 'h', parsed_defaults: null })),
    },
    runs: {
      createRun: vi.fn(async (d: Record<string, unknown>) => ({ ...d, created_at: new Date(), updated_at: new Date() })),
      findActiveRunByDedupeKey: vi.fn(async () => null),
    },
    jobQ: {
      generateJobId: vi.fn(async (_p: string, parentId?: string) => ({ id: parentId ? `${parentId}.${++n}` : `a-${++n}`, projectId: 'proj_a' })),
      create: vi.fn(async (d: Record<string, unknown>) => {
        jobs.push(d);
        return { ...d, created_at: new Date(), updated_at: new Date() };
      }),
      addDependency: vi.fn(async () => 'rel'),
      updatePhase: vi.fn(async () => ({ success: true })),
    },
    appLinks: { listByConsumer: vi.fn(async () => []) },
  };
});

vi.mock('@eve/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/db')>();
  return {
    ...actual,
    projectQueries: vi.fn(() => m.projects),
    projectManifestQueries: vi.fn(() => m.manifests),
    pipelineRunQueries: vi.fn(() => m.runs),
    jobQueries: vi.fn(() => m.jobQ),
    appLinkSubscriptionQueries: vi.fn(() => m.appLinks),
  };
});

const rawSql = (async () => []) as never;

describe('a step no user started whose declared permissions are all withheld', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.jobs.length = 0;
    m.manifests.findLatestByProject.mockResolvedValue({ manifest_yaml: MANIFEST, manifest_hash: 'h', parsed_defaults: null });
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
  });

  it('gets the minimal job permissions, not the broad executor default (workflow script step)', async () => {
    await new WorkflowsService(rawSql, new AccessService({} as never, rawSql)).invoke('proj_a', 'nightly', undefined, false, undefined);

    const step = m.jobs.find((j) => j.step_name === 'sweep');
    expect(((step?.token_permissions as string[] | null) ?? []).slice().sort()).toEqual(MINIMAL);
  });

  it('gets the minimal job permissions, not the broad executor default (pipeline step)', async () => {
    await new PipelineExpanderService(rawSql, new AccessService({} as never, rawSql)).expandPipeline(
      'proj_a',
      { pipeline_name: 'release', git_sha: 'abc' },
      'system',
    );

    const step = m.jobs.find((j) => j.step_name === 'run');
    expect(((step?.token_permissions as string[] | null) ?? []).slice().sort()).toEqual(MINIMAL);
  });
});
