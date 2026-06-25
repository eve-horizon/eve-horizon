import { describe, expect, it } from 'vitest';
import { ManifestSchema } from '../manifest.js';
import { WorkflowDefinitionSchema, WorkflowStepSchema } from '../workflow.js';
import { getScriptConfig, parseStepExecution } from '../../workflow/step-execution.js';

describe('WorkflowStepSchema', () => {
  it('accepts exactly one agent, script, run, or action execution kind', () => {
    expect(WorkflowStepSchema.safeParse({ agent: { prompt: 'Plan' } }).success).toBe(true);
    expect(WorkflowStepSchema.safeParse({ script: { run: 'echo setup' } }).success).toBe(true);
    expect(WorkflowStepSchema.safeParse({ run: 'echo shorthand' }).success).toBe(true);
    expect(WorkflowStepSchema.safeParse({ action: { type: 'deploy' } }).success).toBe(true);
  });

  it('rejects ambiguous or missing execution kinds', () => {
    const ambiguous = WorkflowStepSchema.safeParse({
      agent: { prompt: 'Plan' },
      script: { run: 'echo setup' },
    });
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.error?.issues.map((issue) => issue.message).join('\n')).toContain('exactly one');

    const missing = WorkflowStepSchema.safeParse({
      name: 'setup',
      env_overrides: { API_KEY: '${secret.API_KEY}' },
    });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((issue) => issue.message).join('\n')).toContain('exactly one');
  });

  it('accepts workflow cross-cutting fields', () => {
    const parsed = WorkflowStepSchema.safeParse({
      name: 'setup',
      depends_on: ['prepare'],
      condition: "prepare.status == 'done'",
      script: { command: 'echo setup', timeout_seconds: 30 },
      requires: { secrets: ['SETUP_TOKEN'] },
      scope: { orgfs: { allow_prefixes: ['/groups/projects/demo/**'] } },
      permissions: ['jobs:read'],
      env_overrides: { SETUP_TOKEN: '${secret.SETUP_TOKEN}' },
      resource_refs: { mode: 'selected', include: ['brief'] },
      git: { ref: 'main' },
      with_apis: ['api'],
      toolchains: ['python'],
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts toolchains on agent, script, and run steps', () => {
    expect(WorkflowStepSchema.safeParse({ agent: { name: 'builder' }, toolchains: ['media'] }).success).toBe(true);
    expect(WorkflowStepSchema.safeParse({ script: { run: 'python -m demo' }, toolchains: ['python'] }).success).toBe(true);
    expect(WorkflowStepSchema.safeParse({ run: 'cargo test', toolchains: ['rust'] }).success).toBe(true);
    expect(WorkflowStepSchema.safeParse({ run: 'echo optional', toolchains: [] }).success).toBe(true);
  });

  it('rejects unknown toolchains and workflow action toolchain declarations', () => {
    const unknown = WorkflowStepSchema.safeParse({
      script: { run: 'python -m demo' },
      toolchains: ['rubber'],
    });
    expect(unknown.success).toBe(false);

    const action = WorkflowStepSchema.safeParse({
      action: { type: 'run' },
      toolchains: ['python'],
    });
    expect(action.success).toBe(false);
    expect(action.error?.issues.map((issue) => issue.message).join('\n')).toContain('Workflow action steps do not support toolchains');

    const nestedAction = WorkflowStepSchema.safeParse({
      action: { type: 'run', toolchains: ['python'] },
    });
    expect(nestedAction.success).toBe(false);
    expect(nestedAction.error?.issues.map((issue) => issue.message).join('\n')).toContain('Use top-level step toolchains');
  });
});

describe('WorkflowDefinitionSchema', () => {
  it('preserves workflow-level fields used by invocation', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      inputs: { slug: { from: 'event.payload.slug', default: 'demo' } },
      env: 'sandbox',
      db_access: 'read_only',
      env_overrides: { GLOBAL_TOKEN: '${secret.GLOBAL_TOKEN}' },
      scope: { orgfs: { allow_prefixes: ['/groups/projects/**'] } },
      permissions: ['jobs:read'],
      resource_refs: 'inherit',
      git: { ref: 'main', commit: 'auto' },
      hints: { gates: ['manual-review'] },
      trigger: { manual: {} },
      with_apis: ['api'],
      toolchains: ['python', 'media'],
      steps: [{ agent: { prompt: 'Review' } }],
    });

    expect(parsed.env).toBe('sandbox');
    expect(parsed.git).toEqual({ ref: 'main', commit: 'auto' });
    expect(parsed.hints).toEqual({ gates: ['manual-review'] });
    expect(parsed.trigger).toEqual({ manual: {} });
    expect(parsed.with_apis).toEqual(['api']);
    expect(parsed.toolchains).toEqual(['python', 'media']);
  });

  it('routes manifest workflows through WorkflowDefinitionSchema', () => {
    const valid = ManifestSchema.safeParse({
      name: 'workflow-test',
      workflows: {
        build_context: {
          steps: [{ script: { run: 'echo setup' } }],
        },
      },
    });
    expect(valid.success).toBe(true);

    const invalid = ManifestSchema.safeParse({
      name: 'workflow-test',
      workflows: {
        build_context: {
          steps: [{ agent: { prompt: 'Plan' }, run: 'echo ambiguous' }],
        },
      },
    });
    expect(invalid.success).toBe(false);
  });
});

describe('workflow step execution helper', () => {
  it('parses script object and run shorthand steps', () => {
    expect(getScriptConfig({ script: { run: 'echo setup', timeout_seconds: 30 } })).toEqual({
      command: 'echo setup',
      timeoutSeconds: 30,
      config: { run: 'echo setup', timeout_seconds: 30 },
    });

    expect(parseStepExecution({ run: 'echo shorthand' }, 'setup')).toMatchObject({
      executionType: 'script',
      scriptCommand: 'echo shorthand',
      scriptTimeoutSeconds: null,
    });
  });

  it('parses command-based scripts, agent steps, and action steps', () => {
    expect(parseStepExecution({ script: { command: 'npm test', timeout: 120 } }, 'test')).toMatchObject({
      executionType: 'script',
      scriptCommand: 'npm test',
      scriptTimeoutSeconds: 120,
    });

    expect(parseStepExecution({ agent: { prompt: 'Review' } }, 'review')).toMatchObject({
      executionType: 'agent',
      agentConfig: { prompt: 'Review' },
    });

    expect(parseStepExecution({ action: { type: 'deploy', env_name: 'test' } }, 'deploy')).toMatchObject({
      executionType: 'action',
      actionType: 'deploy',
      actionInput: { env_name: 'test' },
    });
  });
});
