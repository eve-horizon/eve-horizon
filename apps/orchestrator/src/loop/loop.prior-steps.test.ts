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

/** Step "write" of workflow run run1 (a child of root run1). */
const WRITE_STEP: Row = {
  id: 'run1.2',
  parent_id: 'run1',
  project_id: 'proj_a',
  step_name: 'write',
  description: 'Write it up.',
  hints: { workflow_name: 'report', step_name: 'write' },
};

function done(id: string, parentId: string | null, stepName: string): Row {
  return { id, parent_id: parentId, project_id: 'proj_a', phase: 'done', step_name: stepName, hints: { step_name: stepName } };
}

function jobsWith(dependencies: Row[], attempts: Record<string, Row>, sibling: Row | null = null) {
  return {
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
});
