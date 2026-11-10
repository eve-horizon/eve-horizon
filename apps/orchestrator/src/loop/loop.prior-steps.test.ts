import { describe, expect, it, vi } from 'vitest';
import { LoopService } from './loop.service';

type Row = Record<string, unknown>;

type LoopInternals = {
  enrichWorkflowStep(job: Row, jobs: unknown): Promise<string>;
  evaluateStepCondition(jobs: unknown, job: Row): Promise<{ shouldRun: boolean; reason?: string } | null>;
};

function loop(): LoopInternals {
  const service = Object.create(LoopService.prototype) as Row;
  service.logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return service as unknown as LoopInternals;
}

/** Root of workflow run run1, invoked by user_owner. */
const RUN_ROOT: Row = { id: 'run1', parent_id: null, project_id: 'proj_a', step_name: null, actor_user_id: 'user_owner' };

/** Step "write" of run1, running as user_owner. */
const WRITE_STEP: Row = {
  id: 'run1.2',
  parent_id: 'run1',
  project_id: 'proj_a',
  step_name: 'write',
  actor_user_id: 'user_owner',
  description: 'Write it up.',
  hints: { workflow_name: 'report', step_name: 'write' },
};

/** A done step compiled by the workflow expander (step_name column set). */
function done(id: string, parentId: string | null, stepName: string, actor = 'user_owner'): Row {
  return { id, parent_id: parentId, project_id: 'proj_a', phase: 'done', priority: 2, step_name: stepName, actor_user_id: actor, hints: { step_name: stepName } };
}

/** A job someone created under the run root with a step name in its hints only. */
function filedUnderRun(id: string, stepName: string, actor = 'user_mate'): Row {
  return { id, parent_id: 'run1', project_id: 'proj_a', phase: 'done', priority: 0, step_name: null, actor_user_id: actor, hints: { step_name: stepName } };
}

function jobsWith(dependencies: Row[], attempts: Record<string, Row>, sibling: Row | null = null) {
  return {
    findById: vi.fn(async (id: string) => (id === RUN_ROOT.id ? RUN_ROOT : null)),
    getDependencies: vi.fn(async () => dependencies),
    getLatestAttempt: vi.fn(async (id: string) => attempts[id] ?? null),
    findSiblingByStepName: vi.fn(async () => sibling),
  };
}

describe('prior step results in a workflow step prompt', () => {
  it('adds the results of earlier steps of the same run', async () => {
    const jobs = jobsWith([done('run1.1', 'run1', 'research')], { 'run1.1': { result_text: 'Research notes' } });

    const prompt = await loop().enrichWorkflowStep(WRITE_STEP, jobs);

    expect(prompt).toContain('## Prior Step Results');
    expect(prompt).toContain('Research notes');
  });

  it('leaves out the results of jobs from outside the run, however they came to be dependencies', async () => {
    const jobs = jobsWith(
      [done('run2.1', 'run2', 'research'), done('solo-1', null, 'notes')],
      { 'run2.1': { result_text: 'Other run notes' }, 'solo-1': { result_text: 'Standalone notes' } },
    );

    const prompt = await loop().enrichWorkflowStep(WRITE_STEP, jobs);

    expect(prompt).toBe('Write it up.');
  });

  it('leaves out a job someone created under the run and added as a dependency', async () => {
    const jobs = jobsWith([filedUnderRun('run1.9', 'research')], { 'run1.9': { result_text: 'Filed notes' } });

    const prompt = await loop().enrichWorkflowStep(WRITE_STEP, jobs);

    expect(prompt).toBe('Write it up.');
  });

  it('leaves out an earlier step that now runs as someone other than the step or the run', async () => {
    const jobs = jobsWith([done('run1.1', 'run1', 'research', 'user_mate')], { 'run1.1': { result_text: 'Rewritten notes' } });

    const prompt = await loop().enrichWorkflowStep(WRITE_STEP, jobs);

    expect(prompt).toBe('Write it up.');
  });

  it("gives a retrier's step the run's original earlier steps and the retrier's own", async () => {
    const retried = { ...WRITE_STEP, id: 'run1.4', actor_user_id: 'user_retrier' };
    const jobs = jobsWith(
      [done('run1.1', 'run1', 'research'), done('run1.3', 'run1', 'outline', 'user_retrier')],
      { 'run1.1': { result_text: 'Research notes' }, 'run1.3': { result_text: 'Outline notes' } },
    );

    const prompt = await loop().enrichWorkflowStep(retried, jobs);

    expect(prompt).toContain('Research notes');
    expect(prompt).toContain('Outline notes');
  });
});

describe('workflow step conditions', () => {
  const CONDITIONAL_STEP: Row = {
    ...WRITE_STEP,
    hints: { ...(WRITE_STEP.hints as Row), condition: "research.status == 'ok'" },
  };

  it("reads the named step from the step's own run, not from a dependency outside it", async () => {
    const outside = done('run2.1', 'run2', 'research');
    const ownStep = done('run1.1', 'run1', 'research');
    const jobs = jobsWith(
      [outside],
      {
        'run2.1': { result_json: { eve: { status: 'ok' } } },
        'run1.1': { result_json: { eve: { status: 'skip' } } },
      },
      ownStep,
    );

    const outcome = await loop().evaluateStepCondition(jobs, CONDITIONAL_STEP);

    expect(outcome?.shouldRun).toBe(false);
  });

  it('is not decided by a job someone created under the run with the step name in its hints', async () => {
    const jobs = jobsWith(
      [filedUnderRun('run1.9', 'research')],
      {
        'run1.9': { result_json: { eve: { status: 'ok' } } },
        'run1.1': { result_json: { eve: { status: 'skip' } } },
      },
      done('run1.1', 'run1', 'research'),
    );

    const outcome = await loop().evaluateStepCondition(jobs, CONDITIONAL_STEP);

    expect(outcome?.shouldRun).toBe(false);
  });

  it('is not met when the named step now runs as someone other than the step or the run', async () => {
    const jobs = jobsWith(
      [done('run1.1', 'run1', 'research', 'user_mate')],
      { 'run1.1': { result_json: { eve: { status: 'ok' } } } },
    );

    const outcome = await loop().evaluateStepCondition(jobs, CONDITIONAL_STEP);

    expect(outcome?.shouldRun).toBe(false);
    expect(outcome?.reason).toMatch(/research/);
  });

  it("is decided by the run's own step", async () => {
    const jobs = jobsWith(
      [done('run1.1', 'run1', 'research')],
      { 'run1.1': { result_json: { eve: { status: 'ok' } } } },
    );

    const outcome = await loop().evaluateStepCondition(jobs, CONDITIONAL_STEP);

    expect(outcome).toEqual({ shouldRun: true, reason: undefined });
  });
});
