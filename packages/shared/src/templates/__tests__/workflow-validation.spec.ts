import { describe, it, expect } from 'vitest';
import {
  validateWorkflowTemplates,
  buildWorkflowInputsScope,
} from '../workflow-validation.js';

describe('validateWorkflowTemplates', () => {
  it('returns no errors for a workflow without templates', () => {
    expect(
      validateWorkflowTemplates({
        classify: {
          steps: [{ name: 'ingest', agent: { name: 'a' } }],
        },
      }),
    ).toEqual([]);
  });

  it('accepts declared inputs referenced in step.harness_profile', () => {
    expect(
      validateWorkflowTemplates({
        classify: {
          inputs: { model: { from: 'event.payload.meta.brand', default: 'planner' } },
          steps: [
            { name: 'ingest', agent: { name: 'a' }, harness_profile: '${inputs.model}' },
          ],
        },
      }),
    ).toEqual([]);
  });

  it('rejects undeclared `${inputs.<key>}` references', () => {
    const errors = validateWorkflowTemplates({
      classify: {
        inputs: { model: { default: 'planner' } },
        steps: [
          { name: 'ingest', agent: { name: 'a' }, harness_profile: '${inputs.unknown}' },
        ],
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      workflow: 'classify',
      stepName: 'ingest',
      field: 'harness_profile',
    });
    expect(errors[0].message).toMatch(/undeclared input/);
  });

  it('rejects malformed templates in harness_profile_override fields', () => {
    const errors = validateWorkflowTemplates({
      classify: {
        steps: [
          {
            name: 'ingest',
            agent: { name: 'a' },
            harness_profile_override: {
              harness: 'zai',
              model: '${bogus}',
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      workflow: 'classify',
      stepName: 'ingest',
      field: 'harness_profile_override.model',
    });
    expect(errors[0].message).toMatch(/Unsupported expression head/);
  });

  it('accepts event.payload references without requiring declaration', () => {
    expect(
      validateWorkflowTemplates({
        classify: {
          steps: [
            {
              name: 'ingest',
              agent: { name: 'a' },
              harness_profile_override: {
                harness: 'zai',
                model: '${event.payload.meta.model}',
              },
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it('accepts declared inputs referenced in step git templates', () => {
    expect(
      validateWorkflowTemplates({
        plan: {
          inputs: { slug: { default: 'draft' } },
          steps: [
            {
              name: 'write',
              agent: { name: 'planner' },
              git: {
                branch: 'plans/${inputs.slug}',
                commit_message: 'Plan ${inputs.slug}',
              },
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it('rejects undeclared inputs referenced in step git templates', () => {
    const errors = validateWorkflowTemplates({
      plan: {
        steps: [
          {
            name: 'write',
            agent: { name: 'planner' },
            git: {
              branch: 'plans/${inputs.slug}',
            },
          },
        ],
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      workflow: 'plan',
      stepName: 'write',
      field: 'git.branch',
    });
    expect(errors[0].message).toMatch(/undeclared input/);
  });

  it('gracefully ignores non-object workflow definitions', () => {
    expect(
      validateWorkflowTemplates({ notAWorkflow: 'string', alsoNotAWorkflow: 42 as unknown as Record<string, unknown> }),
    ).toEqual([]);
  });
});

describe('buildWorkflowInputsScope', () => {
  it('prefers explicit provided input over event payload and default', () => {
    const scope = buildWorkflowInputsScope(
      { model: { from: 'event.payload.meta.model', default: 'planner' } },
      { model: 'fast' },
      { meta: { model: 'gemini' } },
    );
    expect(scope).toEqual({ model: 'fast' });
  });

  it('falls back to event payload path when input not provided', () => {
    const scope = buildWorkflowInputsScope(
      { model: { from: 'event.payload.meta.model', default: 'planner' } },
      {},
      { meta: { model: 'gemini' } },
    );
    expect(scope).toEqual({ model: 'gemini' });
  });

  it('falls back to default when both provided and payload absent', () => {
    const scope = buildWorkflowInputsScope(
      { model: { from: 'event.payload.meta.model', default: 'planner' } },
      {},
      {},
    );
    expect(scope).toEqual({ model: 'planner' });
  });

  it('omits inputs that resolve to nothing', () => {
    const scope = buildWorkflowInputsScope(
      { model: { from: 'event.payload.meta.model' } },
      {},
      {},
    );
    expect(scope).toEqual({});
  });

  it('includes ad-hoc caller inputs that were not declared', () => {
    const scope = buildWorkflowInputsScope(
      {},
      { extra: 'value' },
      {},
    );
    expect(scope).toEqual({ extra: 'value' });
  });

  it('rejects malformed `from` expressions', () => {
    const scope = buildWorkflowInputsScope(
      { model: { from: 'inputs.x' } },
      {},
      {},
    );
    expect(scope).toEqual({});
  });
});
