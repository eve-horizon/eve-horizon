import { describe, expect, it } from 'vitest';
import { ManifestSchema } from '../manifest.js';
import { PipelineDefinitionSchema, PipelineStepSchema } from '../pipeline.js';

describe('PipelineStepSchema', () => {
  it('accepts toolchains on script, run, agent, and action-run steps', () => {
    expect(PipelineStepSchema.safeParse({ script: { run: 'python -m demo' }, toolchains: ['python'] }).success).toBe(true);
    expect(PipelineStepSchema.safeParse({ run: 'cargo test', toolchains: ['rust'] }).success).toBe(true);
    expect(PipelineStepSchema.safeParse({ agent: { prompt: 'Plan' }, toolchains: ['media'] }).success).toBe(true);
    expect(PipelineStepSchema.safeParse({ action: { type: 'run', command: 'java -version' }, toolchains: ['java'] }).success).toBe(true);
    expect(PipelineStepSchema.safeParse({ script: { run: 'echo optional' }, toolchains: [] }).success).toBe(true);
  });

  it('rejects unknown toolchains', () => {
    const parsed = PipelineStepSchema.safeParse({
      script: { run: 'python -m demo' },
      toolchains: ['rubber'],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects toolchains on non-run action steps', () => {
    const parsed = PipelineStepSchema.safeParse({
      action: { type: 'deploy' },
      toolchains: ['python'],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join('\n')).toContain('Pipeline action steps support toolchains only for action.type=run');
  });

  it('rejects nested action.toolchains', () => {
    const parsed = PipelineStepSchema.safeParse({
      action: { type: 'run', command: 'python -m demo', toolchains: ['python'] },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join('\n')).toContain('Use top-level step toolchains');
  });
});

describe('PipelineDefinitionSchema', () => {
  it('preserves pipeline-level toolchains', () => {
    const parsed = PipelineDefinitionSchema.parse({
      toolchains: ['python', 'media'],
      steps: [{ script: { run: 'python -m demo' } }],
    });

    expect(parsed.toolchains).toEqual(['python', 'media']);
  });

  it('routes manifest pipelines through PipelineDefinitionSchema', () => {
    const valid = ManifestSchema.safeParse({
      name: 'pipeline-test',
      pipelines: {
        build: {
          toolchains: ['python'],
          steps: [{ action: { type: 'run', command: 'python -m demo' }, toolchains: ['python'] }],
        },
      },
    });
    expect(valid.success).toBe(true);

    const invalid = ManifestSchema.safeParse({
      name: 'pipeline-test',
      pipelines: {
        deploy: {
          steps: [{ action: { type: 'deploy' }, toolchains: ['python'] }],
        },
      },
    });
    expect(invalid.success).toBe(false);
  });
});
